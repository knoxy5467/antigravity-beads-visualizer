import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkflowLanes, groupLaneItems } from '../../src/core/lanes.js';
import type { BeadBlockedEntry, BeadIssue } from '../../src/core/graph.js';

const LANE_ISSUES: BeadIssue[] = [
  { id: 'bv-1', title: 'Done Task', status: 'closed', priority: 0, assignee: 'agent-alpha', parent: 'bv-epic-1' },
  { id: 'bv-2', title: 'Active Task', status: 'in_progress', priority: 1, assignee: 'agent-beta', parent: 'bv-epic-1' },
  { id: 'bv-3', title: 'Blocked Task', status: 'open', priority: 1, assignee: 'agent-alpha', parent: 'bv-epic-2' },
  { id: 'bv-4', title: 'Ready Task', status: 'open', priority: 2, assignee: 'agent-beta', parent: 'bv-epic-2' },
  {
    id: 'bv-5',
    title: 'Dep Blocked Task',
    status: 'open',
    priority: 2,
    dependencies: [{ depends_on_id: 'bv-2', type: 'blocks' }],
  },
];

const BLOCKED: BeadBlockedEntry[] = [
  { id: 'bv-3', title: 'Blocked Task', status: 'open', priority: 1, issue_type: 'task', blocked_by_count: 1, blocked_by: ['bv-2'] },
];

test('buildWorkflowLanes classifies ready, in_progress, blocked, and closed', () => {
  const lanes = buildWorkflowLanes(LANE_ISSUES, BLOCKED);
  assert.deepEqual(lanes.closed.map((i) => i.id), ['bv-1']);
  assert.deepEqual(lanes.in_progress.map((i) => i.id), ['bv-2']);
  assert.deepEqual(lanes.blocked.map((i) => i.id), ['bv-3', 'bv-5']);
  assert.deepEqual(lanes.ready.map((i) => i.id), ['bv-4']);
});

test('groupLaneItems groups by all, epic, and assignee', () => {
  const allGroups = groupLaneItems(LANE_ISSUES, 'all');
  assert.equal(allGroups.get('All')?.length, 5);

  const epicGroups = groupLaneItems(LANE_ISSUES, 'epic');
  assert.equal(epicGroups.get('bv-epic-1')?.length, 2);
  assert.equal(epicGroups.get('No Epic')?.length, 1);

  const assigneeGroups = groupLaneItems(LANE_ISSUES, 'assignee');
  assert.equal(assigneeGroups.get('agent-alpha')?.length, 2);
  assert.equal(assigneeGroups.get('Unassigned')?.length, 1);
});

test('groupLaneItems falls back to parent-child dependency when parent is omitted', () => {
  const groups = groupLaneItems(
    [
      {
        id: 'bv-child-1',
        title: 'Child',
        status: 'open',
        dependencies: [{ depends_on_id: 'bv-sub-gates', type: 'parent-child' }],
      },
    ],
    'epic'
  );
  assert.equal(groups.get('bv-sub-gates')?.length, 1);
});
