import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDagLayout, getNeighborHighlight } from '../../src/core/dag.js';
import type { BeadIssue } from '../../src/core/graph.js';

const DAG_ISSUES: BeadIssue[] = [
  { id: 'bv-a', title: 'Root Spec', status: 'closed', priority: 0, dependencies: [] },
  {
    id: 'bv-b',
    title: 'Data Adapter',
    status: 'in_progress',
    priority: 1,
    dependencies: [{ depends_on_id: 'bv-a', type: 'blocks' }],
  },
  {
    id: 'bv-c',
    title: 'UI View',
    status: 'open',
    priority: 1,
    dependencies: [
      { depends_on_id: 'bv-b', type: 'blocks' },
      { depends_on_id: 'bv-a', type: 'relates-to' },
    ],
  },
];

test('buildDagLayout computes topological columns and directed edges', () => {
  const layout = buildDagLayout(DAG_ISSUES);
  assert.equal(layout.nodes.length, 3);
  assert.equal(layout.edges.length, 3);
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  assert.ok((byId.get('bv-a')?.col ?? 99) < (byId.get('bv-b')?.col ?? 0));
  assert.ok((byId.get('bv-b')?.col ?? 99) < (byId.get('bv-c')?.col ?? 0));
});

test('getNeighborHighlight returns upstream blockers and downstream dependents', () => {
  const layout = buildDagLayout(DAG_ISSUES);
  const hl = getNeighborHighlight('bv-b', layout.edges);
  assert.equal(hl.upstream.has('bv-a'), true);
  assert.equal(hl.downstream.has('bv-c'), true);
});
