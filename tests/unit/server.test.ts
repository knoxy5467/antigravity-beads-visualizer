import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BD_EXEC_OPTIONS,
  coalesceInFlight,
  computeStatsFallback,
  createStandaloneServer,
  deriveBlockedEntries,
  formatBdCommandError,
  isBeadsWorkspaceDir,
  isValidBeadId,
  listBeadsWorkspaces,
  loadBeadsSnapshot,
  loadIssueComments,
  parseBdJsonOutput,
  resolveBdExecutable,
  validateWorkspaceParam,
} from '../../src/standalone/server.js';

test('isValidBeadId accepts valid IDs and rejects flags or subcommands', () => {
  assert.equal(isValidBeadId('bv-task-1'), true);
  assert.equal(isValidBeadId('bv-a.1_b'), true);
  assert.equal(isValidBeadId('--help'), false);
  assert.equal(isValidBeadId('add'), false);
  assert.equal(isValidBeadId('../secret'), false);
  assert.equal(isValidBeadId(''), false);
});

test('resolveBdExecutable returns a non-empty executable path', () => {
  assert.ok(resolveBdExecutable().length > 0);
});

test('computeStatsFallback summarizes open, in_progress, blocked, ready, and closed', () => {
  const stats = computeStatsFallback(
    [
      { id: 'bv-1', title: 'Done', status: 'closed' },
      { id: 'bv-2', title: 'Active', status: 'in_progress' },
      { id: 'bv-3', title: 'Blocked', status: 'open' },
      { id: 'bv-4', title: 'Ready', status: 'open' },
    ],
    [{ id: 'bv-3', title: 'Blocked', status: 'open', priority: 1, issue_type: 'task', blocked_by_count: 1, blocked_by: ['bv-2'] }]
  );
  assert.equal(stats.total_issues, 4);
  assert.equal(stats.closed_issues, 1);
  assert.equal(stats.in_progress_issues, 1);
  assert.equal(stats.blocked_issues, 1);
  assert.equal(stats.ready_issues, 1);
});

test('computeStatsFallback counts open blocks dependency when blocked array is empty', () => {
  const stats = computeStatsFallback(
    [
      { id: 'bv-1', title: 'Blocker', status: 'open' },
      {
        id: 'bv-2',
        title: 'Blocked Task',
        status: 'open',
        dependencies: [{ issue_id: 'bv-2', depends_on_id: 'bv-1', type: 'blocks' }],
      },
    ],
    []
  );
  assert.equal(stats.total_issues, 2);
  assert.equal(stats.open_issues, 2);
  assert.equal(stats.blocked_issues, 1);
  assert.equal(stats.ready_issues, 1);
});

test('loadBeadsSnapshot reads synthetic fixture without invoking bd CLI', async () => {
  const snap = await loadBeadsSnapshot({
    fixturePath: 'tests/fixtures/synthetic-beads.json',
    testEnv: 'synthetic',
  });
  assert.equal(snap.testEnv, 'synthetic');
  assert.equal(snap.workspace, '/synthetic/workspace/beads-demo');
  assert.equal(snap.issues.length, 8);
  assert.ok(Array.isArray(snap.blocked));
  assert.ok(snap.stats !== undefined);
  assert.ok(snap.etag.length > 0);
});

test('loadIssueComments returns fixture comments and rejects invalid IDs', async () => {
  const comments = await loadIssueComments('bv-meta-demo', {
    fixturePath: 'tests/fixtures/synthetic-beads.json',
  });
  assert.equal(comments.length, 1);
  await assert.rejects(() => loadIssueComments('add', { fixturePath: 'tests/fixtures/synthetic-beads.json' }));
});

test('listBeadsWorkspaces returns synthetic workspace when fixturePath is set', async () => {
  const workspaces = await listBeadsWorkspaces({ fixturePath: 'tests/fixtures/synthetic-beads.json' });
  assert.deepEqual(workspaces, ['/synthetic/workspace/beads-demo']);
});

test('createStandaloneServer serves health, workspaces, snapshot etag, and rejects unsafe params', async () => {
  process.env.BEADS_FIXTURE_PATH = 'tests/fixtures/synthetic-beads.json';
  process.env.BEADS_TEST_ENV = 'synthetic';
  const server = createStandaloneServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);

    const ws = (await (await fetch(`${base}/api/workspaces`)).json()) as { workspaces: string[] };
    assert.deepEqual(ws.workspaces, ['/synthetic/workspace/beads-demo']);

    const snap = (await (await fetch(`${base}/api/snapshot`)).json()) as { etag: string; issues: unknown[] };
    assert.equal(snap.issues.length, 8);

    const unchanged = (await (await fetch(`${base}/api/snapshot?etag=${snap.etag}`)).json()) as { unchanged: boolean };
    assert.equal(unchanged.unchanged, true);

    const badWs = await fetch(`${base}/api/snapshot?workspace=/outside/dir`);
    assert.equal(badWs.status, 400);

    const badIssue = await fetch(`${base}/api/issue?id=add`);
    assert.equal(badIssue.status, 400);

    const okIssue = await fetch(`${base}/api/issue?id=bv-meta-demo`);
    assert.equal(okIssue.status, 200);
  } finally {
    delete process.env.BEADS_FIXTURE_PATH;
    delete process.env.BEADS_TEST_ENV;
    server.close();
  }
});

test('listBeadsWorkspaces discovers directories containing .beads via BEADS_WORKSPACES', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'bv-ws-'));
  mkdirSync(join(tempRoot, '.beads'), { recursive: true });
  const prevWorkspaces = process.env.BEADS_WORKSPACES;
  const prevFixture = process.env.BEADS_FIXTURE_PATH;
  delete process.env.BEADS_FIXTURE_PATH;
  process.env.BEADS_WORKSPACES = tempRoot;
  try {
    const workspaces = await listBeadsWorkspaces();
    assert.ok(workspaces.includes(tempRoot));
  } finally {
    if (prevWorkspaces === undefined) delete process.env.BEADS_WORKSPACES;
    else process.env.BEADS_WORKSPACES = prevWorkspaces;
    if (prevFixture !== undefined) process.env.BEADS_FIXTURE_PATH = prevFixture;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('BD_EXEC_OPTIONS configures 45s timeout and 10 MiB maxBuffer', () => {
  assert.ok(BD_EXEC_OPTIONS.timeout >= 45000);
  assert.ok(BD_EXEC_OPTIONS.maxBuffer >= 10 * 1024 * 1024);
});

test('deriveBlockedEntries extracts open issues with unresolved blocks dependencies', () => {
  const blocked = deriveBlockedEntries([
    { id: 'bv-1', title: 'Closed Blocker', status: 'closed' },
    { id: 'bv-2', title: 'Open Blocker', status: 'open' },
    {
      id: 'bv-3',
      title: 'Blocked Task',
      status: 'open',
      priority: 1,
      dependencies: [
        { depends_on_id: 'bv-1', type: 'blocks' },
        { depends_on_id: 'bv-2', type: 'blocks' },
      ],
    },
  ]);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]?.id, 'bv-3');
  assert.deepEqual(blocked[0]?.blocked_by, ['bv-2']);
});

test('isBeadsWorkspaceDir rejects global-only .beads directories and accepts project workspaces', () => {
  const globalOnly = mkdtempSync(join(tmpdir(), 'bv-global-only-'));
  const validProject = mkdtempSync(join(tmpdir(), 'bv-valid-project-'));
  try {
    mkdirSync(join(globalOnly, '.beads', 'eventsData'), { recursive: true });
    writeFileSync(join(globalOnly, '.beads', 'machine-id'), 'synthetic-machine-id', 'utf-8');
    assert.equal(isBeadsWorkspaceDir(globalOnly), false);

    mkdirSync(join(validProject, '.beads'), { recursive: true });
    writeFileSync(join(validProject, '.beads', 'metadata.json'), '{"backend":"dolt"}', 'utf-8');
    assert.equal(isBeadsWorkspaceDir(validProject), true);
  } finally {
    rmSync(globalOnly, { recursive: true, force: true });
    rmSync(validProject, { recursive: true, force: true });
  }
});

test('validateWorkspaceParam deduplicates and matches normalized workspace paths', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'bv-norm-ws-'));
  mkdirSync(join(tempRoot, '.beads'), { recursive: true });
  writeFileSync(join(tempRoot, '.beads', 'metadata.json'), '{"backend":"dolt"}', 'utf-8');
  const prevWorkspaces = process.env.BEADS_WORKSPACES;
  const prevFixture = process.env.BEADS_FIXTURE_PATH;
  delete process.env.BEADS_FIXTURE_PATH;
  process.env.BEADS_WORKSPACES = tempRoot;
  try {
    const query = process.platform === 'win32' ? tempRoot.toLowerCase() : tempRoot;
    const matched = await validateWorkspaceParam(query);
    assert.equal(matched, tempRoot);
  } finally {
    if (prevWorkspaces === undefined) delete process.env.BEADS_WORKSPACES;
    else process.env.BEADS_WORKSPACES = prevWorkspaces;
    if (prevFixture !== undefined) process.env.BEADS_FIXTURE_PATH = prevFixture;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('formatBdCommandError returns clean actionable errors without raw Command failed prefixes', () => {
  const doltErr = Object.assign(new Error('Command failed: /synthetic/bin/bd list --json'), {
    stderr:
      'Error: failed to open database: Dolt server unreachable at 127.0.0.1:3307: connectex: connection refused\nTry: bd dolt start',
  });
  const doltMsg = formatBdCommandError(doltErr);
  assert.doesNotMatch(doltMsg, /Command failed:/);
  assert.match(doltMsg, /127\.0\.0\.1:3307/);
  assert.match(doltMsg, /bd dolt start/);

  const schemaErr = Object.assign(new Error('Command failed: /synthetic/bin/bd list --json'), {
    stderr: 'Error: failed to open database: schema version mismatch: database is at v53, binary expects v66',
  });
  const schemaMsg = formatBdCommandError(schemaErr);
  assert.doesNotMatch(schemaMsg, /Command failed:/);
  assert.match(schemaMsg, /schema/i);

  const noDbErr = Object.assign(new Error('Command failed: /synthetic/bin/bd list --json'), {
    stderr: 'Error: no beads database found in /synthetic/home',
  });
  const noDbMsg = formatBdCommandError(noDbErr);
  assert.doesNotMatch(noDbMsg, /Command failed:/);
  assert.match(noDbMsg, /Beads database/i);

  const genericErr = Object.assign(new Error('Command failed: /synthetic/bin/bd list --json\nError: permission denied'), {
    stderr: '',
  });
  const genericMsg = formatBdCommandError(genericErr);
  assert.doesNotMatch(genericMsg, /Command failed:/);
  assert.match(genericMsg, /permission denied/i);

  const stdoutOnlyErr = Object.assign(new Error('Command failed: /synthetic/bin/bd list --json'), {
    stderr: '',
    stdout: 'Error: failed to open database: Dolt server unreachable at 127.0.0.1:3307',
  });
  const stdoutOnlyMsg = formatBdCommandError(stdoutOnlyErr);
  assert.doesNotMatch(stdoutOnlyMsg, /Command failed:/);
  assert.match(stdoutOnlyMsg, /127\.0\.0\.1:3307/);

  const timeoutErr = Object.assign(new Error('Command failed: /synthetic/bin/bd list --json'), {
    killed: true,
    signal: 'SIGTERM',
    stderr: '',
    stdout: '',
  });
  const timeoutMsg = formatBdCommandError(timeoutErr);
  assert.doesNotMatch(timeoutMsg, /Command failed:/);
  assert.match(timeoutMsg, /timed out/i);

  const missingBinErr = Object.assign(new Error('spawn bd ENOENT'), {
    code: 'ENOENT',
    stderr: '',
    stdout: '',
  });
  const missingBinMsg = formatBdCommandError(missingBinErr);
  assert.match(missingBinMsg, /BD_PATH/i);

  const timestampDoltErr = Object.assign(new Error('Command failed: /synthetic/bin/bd list --json'), {
    stderr: 'time="2026-11-26T15:23:00Z" level=error connectex: connection refused',
  });
  const timestampDoltMsg = formatBdCommandError(timestampDoltErr);
  assert.doesNotMatch(timestampDoltMsg, /15:23/);
  assert.match(timestampDoltMsg, /Dolt server is not reachable\./);
});

test('parseBdJsonOutput handles clean JSON, leading CLI warnings, null, and invalid output', () => {
  assert.deepEqual(parseBdJsonOutput('[{"id":"bv-1"}]'), [{ id: 'bv-1' }]);
  assert.deepEqual(parseBdJsonOutput(''), []);
  assert.deepEqual(parseBdJsonOutput('null\n'), []);
  assert.deepEqual(
    parseBdJsonOutput('Warning: schema notice on stdout\n[{"id":"bv-2","title":"Valid"}]\n'),
    [{ id: 'bv-2', title: 'Valid' }]
  );
  assert.throws(
    () => parseBdJsonOutput('Command failed: /synthetic/bin/bd list --json'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, /Unexpected token/);
      assert.match(err.message, /non-JSON output/i);
      return true;
    }
  );
});

test('coalesceInFlight shares one concurrent promise per workspace key and clears after completion', async () => {
  const inflight = new Map<string, Promise<string>>();
  let calls = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const p1 = coalesceInFlight(inflight, 'ws-a', async () => {
    calls += 1;
    await firstGate;
    return `run-${calls}`;
  });
  const p2 = coalesceInFlight(inflight, 'ws-a', async () => {
    calls += 1;
    return `run-${calls}`;
  });

  releaseFirst();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 'run-1');
  assert.equal(r2, 'run-1');
  assert.equal(calls, 1);
  assert.equal(inflight.size, 0);

  const r3 = await coalesceInFlight(inflight, 'ws-a', async () => {
    calls += 1;
    return `run-${calls}`;
  });
  assert.equal(r3, 'run-2');
  assert.equal(calls, 2);
});

test('createStandaloneServer returns JSON 500 when workspace discovery fails', async () => {
  const prevFixture = process.env.BEADS_FIXTURE_PATH;
  process.env.BEADS_FIXTURE_PATH = 'tests/fixtures/does-not-exist-synthetic.json';
  const server = createStandaloneServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    for (const path of ['/api/workspaces', '/api/snapshot?workspace=/synthetic/ws', '/api/issue?id=bv-1&workspace=/synthetic/ws']) {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) });
      assert.equal(res.status, 500, `Expected 500 for ${path}`);
      const payload = (await res.json()) as { error?: string };
      assert.ok(payload.error && payload.error.length > 0, `Expected JSON error for ${path}`);
    }
  } finally {
    if (prevFixture === undefined) delete process.env.BEADS_FIXTURE_PATH;
    else process.env.BEADS_FIXTURE_PATH = prevFixture;
    server.close();
  }
});
