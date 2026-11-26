import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  computeStatsFallback,
  createStandaloneServer,
  isValidBeadId,
  listBeadsWorkspaces,
  loadBeadsSnapshot,
  loadIssueComments,
  resolveBdExecutable,
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
