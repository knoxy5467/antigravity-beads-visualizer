import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEpicTree, computeCompletion, formatQuotePayload, type BeadIssue } from '../../src/core/graph.js';

const SAMPLE_ISSUES: BeadIssue[] = [
  {
    id: 'bv-meta-1',
    title: 'Meta Epic',
    issue_type: 'epic',
    status: 'in_progress',
    priority: 0,
    dependencies: [],
  },
  {
    id: 'bv-sub-1',
    title: 'Sub Epic',
    issue_type: 'epic',
    status: 'open',
    priority: 1,
    dependencies: [{ depends_on_id: 'bv-meta-1', type: 'parent-child' }],
  },
  {
    id: 'bv-task-1',
    title: 'Leaf Task',
    issue_type: 'task',
    status: 'closed',
    priority: 1,
    dependencies: [{ depends_on_id: 'bv-sub-1', type: 'parent-child' }],
  },
];

test('buildEpicTree nests meta-epic -> sub-epic -> task with depth', () => {
  const { roots, edges } = buildEpicTree(SAMPLE_ISSUES);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].id, 'bv-meta-1');
  assert.equal(roots[0].depth, 0);
  assert.equal(roots[0].children.length, 1);
  assert.equal(roots[0].children[0].id, 'bv-sub-1');
  assert.equal(roots[0].children[0].depth, 1);
  assert.equal(roots[0].children[0].children[0].id, 'bv-task-1');
  assert.equal(roots[0].children[0].children[0].depth, 2);
  assert.equal(edges.length, 2);
});

test('computeCompletion counts closed descendants', () => {
  const { roots } = buildEpicTree(SAMPLE_ISSUES);
  const stats = computeCompletion(roots[0]);
  assert.equal(stats.total, 3);
  assert.equal(stats.closed, 1);
});

test('formatQuotePayload builds clean context snippet', () => {
  const text = formatQuotePayload(SAMPLE_ISSUES[2]);
  assert.match(text, /bv-task-1/);
  assert.match(text, /Leaf Task/);
});

test('buildEpicTree merges and deduplicates blocked_by and blocks edges', () => {
  const { roots } = buildEpicTree([
    {
      id: 'bv-x',
      title: 'Blocked Node',
      blocked_by: ['bv-b1'],
      dependencies: [
        { depends_on_id: 'bv-b1', type: 'blocks' },
        { depends_on_id: 'bv-b2', type: 'blocks' },
      ],
    },
  ]);
  assert.deepEqual(roots[0].blockedBy, ['bv-b1', 'bv-b2']);
});
