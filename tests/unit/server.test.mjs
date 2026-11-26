import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBeadsSnapshot } from '../../src/standalone/server.mjs';

test('loadBeadsSnapshot reads synthetic fixture without invoking bd CLI', async () => {
  const snap = await loadBeadsSnapshot({
    fixturePath: 'tests/fixtures/synthetic-beads.json',
    testEnv: 'synthetic',
  });
  assert.equal(snap.testEnv, 'synthetic');
  assert.equal(snap.workspace, '/synthetic/workspace/beads-demo');
  assert.equal(snap.issues.length, 5);
  assert.ok(snap.etag.length > 0);
});
