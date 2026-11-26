// @scry.entry
// id: src.standalone-server~252067f3
// kind: code
// summary: >-
//   Serve the standalone Beads Visualizer UI and read-only snapshot, issue, and workspace APIs.
//   Also: standalone, server, fixture, bd-readonly, etag, health, comments, workspaces
// status: active
// weight: 0.8
// tags: ["topic:server", "server", "scope:src", "src", "standalone", "beads", "typescript"]
// rationale: >-
//   Provides an isolated HTTP server for synthetic Playwright tests and local standalone viewing.
// applies: serving standalone UI, loading synthetic fixtures, querying read-only bd JSON
// seeded_questions:
//   - "How does standalone server load synthetic fixtures vs live bd data?"
//   - "src/standalone/server.ts loadBeadsSnapshot"
// @scry.entry.end

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type {
  BeadBlockedEntry,
  BeadComment,
  BeadIssue,
  BeadSnapshot,
  BeadStatsSummary,
} from '../core/graph.js';
import { buildWorkflowLanes } from '../core/lanes.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = __dirname.includes(join('dist', 'src'))
  ? resolve(__dirname, '..', '..', '..')
  : resolve(__dirname, '..', '..');

interface StaticAsset {
  file: string;
  type: string;
}

const STATIC_ROUTES: Record<string, StaticAsset> = {
  '/': { file: join(REPO_ROOT, 'src', 'ui', 'index.html'), type: 'text/html; charset=utf-8' },
  '/index.html': { file: join(REPO_ROOT, 'src', 'ui', 'index.html'), type: 'text/html; charset=utf-8' },
  '/ui/styles.css': { file: join(REPO_ROOT, 'src', 'ui', 'styles.css'), type: 'text/css; charset=utf-8' },
  '/ui/app.js': { file: join(REPO_ROOT, 'dist', 'src', 'ui', 'app.js'), type: 'application/javascript; charset=utf-8' },
  '/ui/host-bridge.js': { file: join(REPO_ROOT, 'dist', 'src', 'ui', 'host-bridge.js'), type: 'application/javascript; charset=utf-8' },
  '/ui/views/tree.js': { file: join(REPO_ROOT, 'dist', 'src', 'ui', 'views', 'tree.js'), type: 'application/javascript; charset=utf-8' },
  '/ui/views/dag.js': { file: join(REPO_ROOT, 'dist', 'src', 'ui', 'views', 'dag.js'), type: 'application/javascript; charset=utf-8' },
  '/ui/views/board.js': { file: join(REPO_ROOT, 'dist', 'src', 'ui', 'views', 'board.js'), type: 'application/javascript; charset=utf-8' },
  '/ui/views/gates.js': { file: join(REPO_ROOT, 'dist', 'src', 'ui', 'views', 'gates.js'), type: 'application/javascript; charset=utf-8' },
  '/ui/views/inspector.js': { file: join(REPO_ROOT, 'dist', 'src', 'ui', 'views', 'inspector.js'), type: 'application/javascript; charset=utf-8' },
  '/core/graph.js': { file: join(REPO_ROOT, 'dist', 'src', 'core', 'graph.js'), type: 'application/javascript; charset=utf-8' },
  '/core/notes.js': { file: join(REPO_ROOT, 'dist', 'src', 'core', 'notes.js'), type: 'application/javascript; charset=utf-8' },
  '/core/dag.js': { file: join(REPO_ROOT, 'dist', 'src', 'core', 'dag.js'), type: 'application/javascript; charset=utf-8' },
  '/core/lanes.js': { file: join(REPO_ROOT, 'dist', 'src', 'core', 'lanes.js'), type: 'application/javascript; charset=utf-8' },
};

const EMPTY_STATS: BeadStatsSummary = {
  total_issues: 0,
  open_issues: 0,
  in_progress_issues: 0,
  blocked_issues: 0,
  closed_issues: 0,
  ready_issues: 0,
};

const BEAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_SUBCOMMANDS = new Set(['add', 'list', 'show', 'close', 'update', 'delete']);

/**
 * Validate that an issue ID is a safe Bead identifier and not a CLI subcommand or flag.
 */
export function isValidBeadId(id: string): boolean {
  const trimmed = id.trim();
  if (!trimmed || trimmed.length > 64) return false;
  if (RESERVED_SUBCOMMANDS.has(trimmed.toLowerCase())) return false;
  return BEAD_ID_RE.test(trimmed);
}

/**
 * Resolve the local bd CLI executable path.
 */
export function resolveBdExecutable(): string {
  if (process.env.BD_PATH) return process.env.BD_PATH;
  const winDefault = join(homedir(), 'AppData', 'Local', 'Programs', 'bd', 'bd.exe');
  if (existsSync(winDefault)) return winDefault;
  return 'bd';
}

/**
 * Compute fallback summary counts when bd stats is unavailable.
 */
export function computeStatsFallback(issues: BeadIssue[], blocked: BeadBlockedEntry[]): BeadStatsSummary {
  const lanes = buildWorkflowLanes(issues, blocked);
  return {
    total_issues: issues.length,
    open_issues: lanes.ready.length + lanes.in_progress.length + lanes.blocked.length,
    in_progress_issues: lanes.in_progress.length,
    blocked_issues: lanes.blocked.length,
    closed_issues: lanes.closed.length,
    ready_issues: lanes.ready.length,
  };
}

export interface SnapshotOptions {
  fixturePath?: string;
  testEnv?: string;
  cwd?: string;
}

/**
 * Load a read-only Beads snapshot from a synthetic fixture or live bd CLI.
 */
export async function loadBeadsSnapshot(options: SnapshotOptions = {}): Promise<BeadSnapshot> {
  const fixturePath = options.fixturePath ?? process.env.BEADS_FIXTURE_PATH ?? '';
  const testEnv = options.testEnv ?? process.env.BEADS_TEST_ENV ?? 'live';

  if (fixturePath) {
    const absPath = resolve(REPO_ROOT, fixturePath);
    const raw = await readFile(absPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      workspace?: string;
      issues?: BeadIssue[];
      blocked?: BeadBlockedEntry[];
      stats?: BeadStatsSummary;
    };
    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    const blocked = Array.isArray(parsed.blocked) ? parsed.blocked : [];
    const stats = parsed.stats ?? computeStatsFallback(issues, blocked);
    const etag = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    return {
      testEnv,
      workspace: parsed.workspace || '/synthetic/workspace/demo',
      issues,
      blocked,
      stats,
      etag,
    };
  }

  const cwd = options.cwd ?? REPO_ROOT;
  const bdExe = resolveBdExecutable();
  const [listRes, blockedRes, statsRes] = await Promise.all([
    execFileAsync(bdExe, ['list', '--all', '--include-gates', '--limit', '0', '--readonly', '--json'], {
      cwd,
      timeout: 15000,
    }),
    execFileAsync(bdExe, ['blocked', '--readonly', '--json'], { cwd, timeout: 15000 }).catch(() => ({
      stdout: '[]',
    })),
    execFileAsync(bdExe, ['stats', '--readonly', '--json'], { cwd, timeout: 15000 }).catch(() => ({
      stdout: '{}',
    })),
  ]);

  const parsedIssues = JSON.parse(listRes.stdout || '[]') as unknown;
  const issues = Array.isArray(parsedIssues) ? (parsedIssues as BeadIssue[]) : [];
  const parsedBlocked = JSON.parse(blockedRes.stdout || '[]') as unknown;
  const blocked = Array.isArray(parsedBlocked) ? (parsedBlocked as BeadBlockedEntry[]) : [];
  const parsedStats = JSON.parse(statsRes.stdout || '{}') as { summary?: BeadStatsSummary };
  const stats = parsedStats.summary ?? computeStatsFallback(issues, blocked) ?? EMPTY_STATS;
  const etag = createHash('sha256')
    .update(listRes.stdout + blockedRes.stdout)
    .digest('hex')
    .slice(0, 16);

  return {
    testEnv,
    workspace: cwd,
    issues,
    blocked,
    stats,
    etag,
  };
}

/**
 * Load comments for one issue read-only.
 */
export async function loadIssueComments(
  issueId: string,
  options: SnapshotOptions = {}
): Promise<BeadComment[]> {
  if (!isValidBeadId(issueId)) {
    throw new Error(`Invalid issue ID: ${issueId}`);
  }
  const fixturePath = options.fixturePath ?? process.env.BEADS_FIXTURE_PATH ?? '';
  if (fixturePath) {
    const snap = await loadBeadsSnapshot(options);
    const found = snap.issues.find((i) => i.id === issueId);
    return found?.comments ?? [];
  }
  const cwd = options.cwd ?? REPO_ROOT;
  const bdExe = resolveBdExecutable();
  const { stdout } = await execFileAsync(bdExe, ['comments', issueId, '--readonly', '--json'], {
    cwd,
    timeout: 10000,
  });
  const parsed = JSON.parse(stdout || '[]') as unknown;
  return Array.isArray(parsed) ? (parsed as BeadComment[]) : [];
}

/**
 * List nearby local workspaces that contain a .beads directory.
 */
export async function listBeadsWorkspaces(options: SnapshotOptions = {}): Promise<string[]> {
  const fixturePath = options.fixturePath ?? process.env.BEADS_FIXTURE_PATH ?? '';
  if (fixturePath) {
    const snap = await loadBeadsSnapshot(options);
    return [snap.workspace];
  }
  const parentDir = dirname(REPO_ROOT);
  const found: string[] = [];
  try {
    const entries = await readdir(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(parentDir, entry.name);
      if (existsSync(join(candidate, '.beads'))) {
        found.push(candidate);
      }
    }
  } catch {
    return [REPO_ROOT];
  }
  return found.length > 0 ? found : [REPO_ROOT];
}

async function validateWorkspaceParam(workspaceParam: string | null): Promise<string | undefined | null> {
  if (!workspaceParam) return undefined;
  const allowed = await listBeadsWorkspaces();
  return allowed.includes(workspaceParam) ? workspaceParam : null;
}

/**
 * Create the standalone HTTP server instance.
 */
export function createStandaloneServer(): http.Server {
  return http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const urlPath = reqUrl.pathname;

    if (urlPath === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (urlPath === '/api/workspaces') {
      const workspaces = await listBeadsWorkspaces();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ workspaces }));
      return;
    }

    if (urlPath === '/api/issue') {
      const id = reqUrl.searchParams.get('id') || '';
      if (!isValidBeadId(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing id parameter' }));
        return;
      }
      const workspace = await validateWorkspaceParam(reqUrl.searchParams.get('workspace'));
      if (workspace === null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Workspace is not in allowed Beads workspaces' }));
        return;
      }
      try {
        const comments = await loadIssueComments(id, { cwd: workspace });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, comments }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (urlPath === '/api/snapshot') {
      const clientEtag = reqUrl.searchParams.get('etag') || '';
      const workspace = await validateWorkspaceParam(reqUrl.searchParams.get('workspace'));
      if (workspace === null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Workspace is not in allowed Beads workspaces' }));
        return;
      }
      try {
        const snap = await loadBeadsSnapshot({ cwd: workspace });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (clientEtag && clientEtag === snap.etag) {
          res.end(JSON.stringify({ unchanged: true, etag: snap.etag }));
          return;
        }
        res.end(JSON.stringify(snap));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    const asset = STATIC_ROUTES[urlPath];
    if (!asset) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    try {
      const content = await readFile(asset.file, 'utf-8');
      res.writeHead(200, { 'Content-Type': asset.type });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(err));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4173);
  const server = createStandaloneServer();
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`Beads Visualizer standalone listening on http://127.0.0.1:${port}\n`);
  });
}
