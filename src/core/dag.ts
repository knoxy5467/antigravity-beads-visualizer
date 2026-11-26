// @scry.entry
// id: src.core-dag~28da5370
// kind: code
// summary: >-
//   Compute cycle-safe topological DAG node coordinates and neighbor highlight sets.
//   Also: dag, graph, layout, topological-sort, blockers, neighbor-highlight
// status: active
// weight: 0.8
// tags: ["topic:graph", "graph", "scope:src", "src", "dag", "beads"]
// rationale: >-
//   Provides deterministic SVG layout coordinates and upstream/downstream highlighting for dependency graphs.
// applies: rendering dependency DAG, highlighting blockers and dependents
// seeded_questions:
//   - "How does buildDagLayout assign topological columns without hanging on cycles?"
//   - "src/core/dag.ts buildDagLayout"
// @scry.entry.end

import type { BeadEdge, BeadIssue } from './graph.js';

export interface DagNode {
  id: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  col: number;
  row: number;
  x: number;
  y: number;
}

export interface DagLayout {
  nodes: DagNode[];
  edges: BeadEdge[];
  width: number;
  height: number;
}

export interface NeighborHighlight {
  upstream: Set<string>;
  downstream: Set<string>;
}

const COL_WIDTH = 240;
const ROW_HEIGHT = 86;
const PAD_X = 24;
const PAD_Y = 24;

/**
 * Compute cycle-safe topological columns and SVG coordinates for Beads issues.
 */
export function buildDagLayout(issues: BeadIssue[]): DagLayout {
  const byId = new Map<string, BeadIssue>();
  for (const issue of issues) {
    byId.set(issue.id, issue);
  }

  const edges: BeadEdge[] = [];
  const depsByNode = new Map<string, string[]>();
  for (const issue of issues) {
    const parents: string[] = [];
    for (const dep of issue.dependencies || []) {
      const target = dep.depends_on_id || dep.target || '';
      const depType = dep.type || 'blocks';
      if (!target || !byId.has(target)) continue;
      edges.push({ from: target, to: issue.id, type: depType });
      parents.push(target);
    }
    depsByNode.set(issue.id, parents);
  }

  const memoCol = new Map<string, number>();
  const visiting = new Set<string>();

  function computeCol(id: string): number {
    const cached = memoCol.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let maxParent = -1;
    for (const parentId of depsByNode.get(id) || []) {
      maxParent = Math.max(maxParent, computeCol(parentId));
    }
    visiting.delete(id);
    const col = maxParent + 1;
    memoCol.set(id, col);
    return col;
  }

  const rowCounters = new Map<number, number>();
  const nodes: DagNode[] = [];
  let maxCol = 0;
  let maxRow = 0;

  for (const issue of issues) {
    const col = computeCol(issue.id);
    const row = rowCounters.get(col) ?? 0;
    rowCounters.set(col, row + 1);
    maxCol = Math.max(maxCol, col);
    maxRow = Math.max(maxRow, row);

    nodes.push({
      id: issue.id,
      title: issue.title,
      status: issue.status || 'open',
      priority: issue.priority ?? 2,
      issueType: issue.issue_type || 'task',
      col,
      row,
      x: PAD_X + col * COL_WIDTH,
      y: PAD_Y + row * ROW_HEIGHT,
    });
  }

  return {
    nodes,
    edges,
    width: PAD_X * 2 + (maxCol + 1) * COL_WIDTH,
    height: PAD_Y * 2 + (maxRow + 1) * ROW_HEIGHT,
  };
}

/**
 * Find direct upstream blockers and downstream dependents for a selected node.
 */
export function getNeighborHighlight(selectedId: string, edges: BeadEdge[]): NeighborHighlight {
  const upstream = new Set<string>();
  const downstream = new Set<string>();
  for (const edge of edges) {
    if (edge.to === selectedId) upstream.add(edge.from);
    if (edge.from === selectedId) downstream.add(edge.to);
  }
  return { upstream, downstream };
}
