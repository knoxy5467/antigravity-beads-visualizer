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
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  '/ui/app.js': {
    file: existsSync(join(REPO_ROOT, 'dist', 'mcp-app', 'app.js'))
      ? join(REPO_ROOT, 'dist', 'mcp-app', 'app.js')
      : join(REPO_ROOT, 'dist', 'src', 'ui', 'app.js'),
    type: 'application/javascript; charset=utf-8',
  },
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

export const BD_EXEC_OPTIONS = {
  timeout: 45000,
  maxBuffer: 10 * 1024 * 1024,
} as const;

/**
 * Derive blocked issue entries from open issues with unresolved blocks dependencies.
 */
export function deriveBlockedEntries(issues: BeadIssue[]): BeadBlockedEntry[] {
  const byId = new Map<string, BeadIssue>(issues.map((issue) => [issue.id, issue]));
  const entries: BeadBlockedEntry[] = [];
  for (const issue of issues) {
    const status = issue.status || 'open';
    if (status === 'closed') continue;
    const blockers: string[] = [];
    for (const dep of issue.dependencies || []) {
      if ((dep.type || 'blocks') === 'blocks' && dep.depends_on_id) {
        const blocker = byId.get(dep.depends_on_id);
        if (!blocker || blocker.status !== 'closed') {
          blockers.push(dep.depends_on_id);
        }
      }
    }
    if (status === 'blocked' || blockers.length > 0) {
      entries.push({
        id: issue.id,
        title: issue.title,
        status,
        priority: issue.priority ?? 2,
        issue_type: issue.issue_type || 'task',
        blocked_by_count: blockers.length,
        blocked_by: blockers,
      });
    }
  }
  return entries;
}

const BEAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_SUBCOMMANDS = new Set(['add', 'list', 'show', 'close', 'update', 'delete']);
const BEADS_WORKSPACE_MARKERS = [
  'metadata.json',
  'config.yaml',
  'issues.jsonl',
  'beads.db',
  'dolt',
  'embeddeddolt',
] as const;

/**
 * Return true when dir contains a project .beads folder with database or config files.
 */
export function isBeadsWorkspaceDir(dir: string): boolean {
  const beadsDir = join(dir, '.beads');
  if (!existsSync(beadsDir)) return false;
  return BEADS_WORKSPACE_MARKERS.some((marker) => existsSync(join(beadsDir, marker)));
}

function normalizeWorkspaceKey(dir: string): string {
  const resolved = resolve(dir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Convert a bd CLI failure into a clear user message without raw binary paths.
 */
export function formatBdCommandError(err: unknown): string {
  const record =
    typeof err === 'object' && err !== null
      ? (err as {
          stderr?: unknown;
          stdout?: unknown;
          message?: unknown;
          killed?: unknown;
          signal?: unknown;
          code?: unknown;
          syscall?: unknown;
        })
      : {};
  const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : '';
  const stdout = typeof record.stdout === 'string' ? record.stdout.trim() : '';
  const syscall = typeof record.syscall === 'string' ? record.syscall : '';
  const rawMessage = err instanceof Error ? err.message : typeof record.message === 'string' ? record.message : String(err);
  const combined = [stderr, stdout, rawMessage].filter(Boolean).join('\n').trim();

  if (/dolt server unreachable|connectex|econnrefused/i.test(combined)) {
    const addrMatch =
      combined.match(/at\s+([0-9A-Za-z.-]+:\d+)/i) ??
      combined.match(/\b((?:localhost|\d{1,3}(?:\.\d{1,3}){3}):\d+)\b/i);
    const addrText = addrMatch ? ` at ${addrMatch[1]}` : '';
    return `Dolt server is not reachable${addrText}. Start it with "bd dolt start" and click Refresh.`;
  }
  if (/schema version mismatch/i.test(combined)) {
    return 'Beads database schema is out of date for this workspace. Run a bd command in that repository to migrate it.';
  }
  if (/no beads database found/i.test(combined)) {
    return 'This workspace does not have an initialized Beads database.';
  }
  if ((record.code === 'ENOENT' && /^spawn\b/i.test(syscall)) || /\bspawn\b.*\benoent\b/i.test(rawMessage)) {
    return 'Cannot find the Beads CLI executable (bd). Install bd or set BD_PATH.';
  }
  if (
    record.killed === true ||
    record.signal === 'SIGTERM' ||
    record.code === 'ETIMEDOUT' ||
    /\btimed out\b/i.test(combined)
  ) {
    return 'Beads CLI timed out on this workspace. Check the Dolt server status and click Refresh.';
  }

  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^Command failed:/i.test(line));
  const bestLine = lines.find((line) => /^Error:/i.test(line)) ?? lines[0] ?? 'Beads CLI command failed.';
  return bestLine.replace(/^Error:\s*/i, '').trim() || 'Beads CLI command failed.';
}

/**
 * Parse JSON stdout from bd CLI and ignore non-JSON warning lines before the payload.
 */
export function parseBdJsonOutput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'null') return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed === null ? [] : parsed;
  } catch {
    // Fall through to locate a JSON payload after leading warning lines.
  }

  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const candidate = lines.slice(i).join('\n').trim();
    if (!candidate.startsWith('[') && !candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return parsed === null ? [] : parsed;
    } catch {
      // Try the next candidate line.
    }
  }

  throw new Error('Beads CLI returned non-JSON output.');
}

/**
 * Coalesce concurrent async work for the same key into one in-flight promise.
 */
export function coalesceInFlight<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  work: () => Promise<T>
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = work().finally(() => {
    if (inFlight.get(key) === pending) {
      inFlight.delete(key);
    }
  });
  inFlight.set(key, pending);
  return pending;
}

const inFlightSnapshots = new Map<string, Promise<BeadSnapshot>>();

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

  const cwd = await resolveDefaultWorkspace(options);
  const cacheKey = `${normalizeWorkspaceKey(cwd)}|${testEnv}`;
  return coalesceInFlight(inFlightSnapshots, cacheKey, async () => {
    const bdExe = resolveBdExecutable();
    const listRes = await execFileAsync(
      bdExe,
      ['list', '--all', '--include-gates', '--limit', '0', '--readonly', '--json'],
      { cwd, ...BD_EXEC_OPTIONS }
    );

    const parsedIssues = parseBdJsonOutput(listRes.stdout || '[]');
    const issues = Array.isArray(parsedIssues) ? (parsedIssues as BeadIssue[]) : [];
    const blocked = deriveBlockedEntries(issues);
    const stats = computeStatsFallback(issues, blocked);
    const etag = createHash('sha256')
      .update(listRes.stdout)
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
  });
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
  const cwd = await resolveDefaultWorkspace(options);
  const bdExe = resolveBdExecutable();
  const { stdout } = await execFileAsync(bdExe, ['comments', issueId, '--readonly', '--json'], {
    cwd,
    ...BD_EXEC_OPTIONS,
  });
  const parsed = parseBdJsonOutput(stdout || '[]');
  return Array.isArray(parsed) ? (parsed as BeadComment[]) : [];
}

async function resolveDefaultWorkspace(options: SnapshotOptions = {}): Promise<string> {
  if (options.cwd) return options.cwd;
  if (isBeadsWorkspaceDir(REPO_ROOT)) return REPO_ROOT;
  if (isBeadsWorkspaceDir(process.cwd())) return process.cwd();
  const discovered = await listBeadsWorkspaces(options);
  if (discovered[0]) return discovered[0];
  throw new Error('No initialized Beads workspace found.');
}

/**
 * List local workspaces that contain a valid .beads directory.
 */
export async function listBeadsWorkspaces(options: SnapshotOptions = {}): Promise<string[]> {
  const fixturePath = options.fixturePath ?? process.env.BEADS_FIXTURE_PATH ?? '';
  if (fixturePath) {
    const snap = await loadBeadsSnapshot(options);
    return [snap.workspace];
  }

  const found = new Map<string, string>();
  const addWorkspace = (dir: string) => {
    const key = normalizeWorkspaceKey(dir);
    if (!found.has(key)) {
      found.set(key, dir);
    }
  };

  const envList = (process.env.BEADS_WORKSPACES || '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const dir of envList) {
    if (existsSync(join(dir, '.beads'))) addWorkspace(dir);
  }

  for (const directDir of [process.cwd(), REPO_ROOT]) {
    if (isBeadsWorkspaceDir(directDir)) addWorkspace(directDir);
  }

  const scanRoots = [
    dirname(REPO_ROOT),
    join(homedir(), 'Documents'),
    join(homedir(), 'Projects'),
    join(homedir(), 'repos'),
  ];
  for (const root of scanRoots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = join(root, entry.name);
        if (isBeadsWorkspaceDir(candidate)) {
          addWorkspace(candidate);
        }
      }
    } catch {
      // Ignore missing or unreadable workspace scan roots.
    }
  }

  return Array.from(found.values());
}

/**
 * Validate that a workspace parameter belongs to the discovered local Beads workspaces.
 */
export async function validateWorkspaceParam(
  workspaceParam: string | null,
  options: SnapshotOptions = {}
): Promise<string | undefined | null> {
  if (!workspaceParam) return undefined;
  const allowed = await listBeadsWorkspaces(options);
  const exact = allowed.find((entry) => entry === workspaceParam);
  if (exact) return exact;
  const targetKey = normalizeWorkspaceKey(workspaceParam);
  const normalized = allowed.find((entry) => normalizeWorkspaceKey(entry) === targetKey);
  return normalized ?? null;
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
        res.end(JSON.stringify({ error: formatBdCommandError(err) }));
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
        res.end(JSON.stringify({ error: formatBdCommandError(err) }));
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

const isStandaloneMain =
  Boolean(process.argv[1]) &&
  /[\\/]standalone[\\/]server\.js$/i.test(resolve(process.argv[1])) &&
  resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase();

if (isStandaloneMain) {
  const port = Number(process.env.PORT || 4173);
  const server = createStandaloneServer();
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`Beads Visualizer standalone listening on http://127.0.0.1:${port}\n`);
  });
}
