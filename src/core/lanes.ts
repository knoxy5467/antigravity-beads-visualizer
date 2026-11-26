// @scry.entry
// id: src.core-lanes~2086a14d
// kind: code
// summary: >-
//   Classify Beads issues into Ready, In Progress, Blocked, and Closed workflow lanes.
//   Also: lanes, workflow-board, ready, blocked, grouping, epic, assignee
// status: active
// weight: 0.7
// tags: ["topic:workflow", "workflow", "scope:src", "src", "lanes", "beads"]
// rationale: >-
//   Powers the Workflow Board tab with deterministic status classification and grouping.
// applies: classifying workflow lanes, grouping board cards
// seeded_questions:
//   - "How does buildWorkflowLanes classify ready vs blocked issues?"
//   - "src/core/lanes.ts buildWorkflowLanes"
// @scry.entry.end

import type { BeadBlockedEntry, BeadIssue } from './graph.js';

export interface WorkflowLanes {
  ready: BeadIssue[];
  in_progress: BeadIssue[];
  blocked: BeadIssue[];
  closed: BeadIssue[];
}

export type LaneGroupBy = 'all' | 'epic' | 'assignee';

/**
 * Classify issues into Ready, In Progress, Blocked, and Closed lanes.
 */
export function buildWorkflowLanes(
  issues: BeadIssue[],
  blockedEntries: BeadBlockedEntry[] = []
): WorkflowLanes {
  const blockedIds = new Set<string>(blockedEntries.map((b) => b.id));
  const byId = new Map<string, BeadIssue>(issues.map((i) => [i.id, i]));

  for (const issue of issues) {
    for (const dep of issue.dependencies || []) {
      if ((dep.type || 'blocks') === 'blocks' && dep.depends_on_id) {
        const blocker = byId.get(dep.depends_on_id);
        if (!blocker || blocker.status !== 'closed') {
          blockedIds.add(issue.id);
        }
      }
    }
  }

  const lanes: WorkflowLanes = { ready: [], in_progress: [], blocked: [], closed: [] };
  for (const issue of issues) {
    const status = issue.status || 'open';
    if (status === 'closed') {
      lanes.closed.push(issue);
    } else if (status === 'in_progress') {
      lanes.in_progress.push(issue);
    } else if (status === 'blocked' || blockedIds.has(issue.id)) {
      lanes.blocked.push(issue);
    } else {
      lanes.ready.push(issue);
    }
  }
  return lanes;
}

/**
 * Group lane items by all, parent epic, or assignee.
 */
export function groupLaneItems(
  items: BeadIssue[],
  groupBy: LaneGroupBy
): Map<string, BeadIssue[]> {
  const groups = new Map<string, BeadIssue[]>();
  if (groupBy === 'all') {
    groups.set('All', items);
    return groups;
  }

  for (const item of items) {
    const parentDep = (item.dependencies || []).find(
      (d) => (d.type || '') === 'parent-child' && d.depends_on_id
    )?.depends_on_id;
    const key =
      groupBy === 'epic'
        ? item.parent || parentDep || 'No Epic'
        : item.assignee || 'Unassigned';
    const bucket = groups.get(key) || [];
    bucket.push(item);
    groups.set(key, bucket);
  }
  return groups;
}
