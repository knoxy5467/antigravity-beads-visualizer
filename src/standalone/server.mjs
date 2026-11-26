// @scry.entry
// id: src.standalone-server~252067f3
// kind: code
// summary: >-
//   Serve the standalone Beads Visualizer UI and read-only snapshot API.
//   Also: standalone, server, fixture, bd-readonly, etag, health
// status: active
// weight: 0.8
// tags: ["topic:server", "server", "scope:src", "src", "standalone", "beads"]
// rationale: >-
//   Provides an isolated HTTP server for synthetic Playwright tests and local standalone viewing.
// applies: serving standalone UI, loading synthetic fixtures, querying read-only bd JSON
// seeded_questions:
//   - "How does standalone server load synthetic fixtures vs live bd data?"
//   - "src/standalone/server.mjs loadBeadsSnapshot"
// @scry.entry.end

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const STATIC_ROUTES = {
  '/': { file: join(REPO_ROOT, 'src', 'ui', 'index.html'), type: 'text/html; charset=utf-8' },
  '/index.html': { file: join(REPO_ROOT, 'src', 'ui', 'index.html'), type: 'text/html; charset=utf-8' },
  '/styles.css': { file: join(REPO_ROOT, 'src', 'ui', 'styles.css'), type: 'text/css; charset=utf-8' },
  '/app.js': { file: join(REPO_ROOT, 'src', 'ui', 'app.js'), type: 'application/javascript; charset=utf-8' },
  '/core/graph.mjs': { file: join(REPO_ROOT, 'src', 'core', 'graph.mjs'), type: 'application/javascript; charset=utf-8' },
};

/**
 * Load a read-only Beads snapshot from a synthetic fixture or live bd CLI.
 * @param {{fixturePath?: string, testEnv?: string, cwd?: string}} [options]
 * @returns {Promise<{testEnv: string, workspace: string, issues: Array<object>, etag: string}>}
 */
export async function loadBeadsSnapshot(options = {}) {
  const fixturePath = options.fixturePath ?? process.env.BEADS_FIXTURE_PATH ?? '';
  const testEnv = options.testEnv ?? process.env.BEADS_TEST_ENV ?? 'live';

  if (fixturePath) {
    const absPath = resolve(REPO_ROOT, fixturePath);
    const raw = await readFile(absPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    const etag = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    return {
      testEnv,
      workspace: parsed.workspace || '/synthetic/workspace/demo',
      issues,
      etag,
    };
  }

  const cwd = options.cwd ?? REPO_ROOT;
  const bdExe = process.env.BD_PATH || 'bd';
  const { stdout } = await execFileAsync(bdExe, ['list', '--json'], { cwd, timeout: 8000 });
  const issues = JSON.parse(stdout || '[]');
  const etag = createHash('sha256').update(stdout || '[]').digest('hex').slice(0, 16);
  return {
    testEnv,
    workspace: 'local-workspace',
    issues: Array.isArray(issues) ? issues : [],
    etag,
  };
}

/**
 * Create the standalone HTTP server instance.
 * @returns {http.Server}
 */
export function createStandaloneServer() {
  return http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (urlPath === '/api/snapshot') {
      try {
        const snap = await loadBeadsSnapshot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
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
