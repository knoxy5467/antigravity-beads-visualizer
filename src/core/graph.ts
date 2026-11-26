// @scry.entry
// id: src.core-graph~de0a9e0c
// kind: code
// summary: >-
//   Build recursive epic trees, dependency edges, completion counts, and quote payloads in TypeScript.
//   Also: graph, epic-tree, completion, quote-payload, parent-child, blocks, typescript
// status: active
// weight: 0.8
// tags: ["topic:graph", "graph", "scope:src", "src", "beads", "epics", "typescript"]
// rationale: >-
//   Centralizes pure read-only Beads hierarchy and quote formatting logic for UI and tests.
// applies: building epic trees, computing completion stats, formatting quote pills
// seeded_questions:
//   - "How does buildEpicTree nest meta-epics, sub-epics, and tasks?"
//   - "src/core/graph.ts buildEpicTree"
// @scry.entry.end

export interface BeadDependency {
  depends_on_id?: string;
  target?: string;
  type?: string;
}

export interface BeadComment {
  author: string;
  created_at?: string;
  text: string;
}

export interface BeadIssue {
  id: string;
  title: string;
  issue_type?: string;
  status?: string;
  priority?: number;
  assignee?: string;
  description?: string;
  acceptance?: string;
  design?: string;
  notes?: string;
  dependencies?: BeadDependency[];
  comments?: BeadComment[];
}

export interface BeadTreeNode extends BeadIssue {
  depth: number;
  children: BeadTreeNode[];
  blockedBy: string[];
}

export interface BeadEdge {
  from: string;
  to: string;
  type: string;
}

export interface BeadSnapshot {
  testEnv: string;
  workspace: string;
  issues: BeadIssue[];
  etag: string;
}

export interface CompletionStats {
  total: number;
  closed: number;
}

/**
 * Build a nested tree of epics and child tasks from flat Beads issues.
 */
export function buildEpicTree(issues: BeadIssue[]): { roots: BeadTreeNode[]; edges: BeadEdge[] } {
  const byId = new Map<string, BeadTreeNode>();
  const edges: BeadEdge[] = [];

  for (const issue of issues) {
    byId.set(issue.id, { ...issue, depth: 0, children: [], blockedBy: [] });
  }

  const hasParent = new Set<string>();
  for (const issue of issues) {
    const node = byId.get(issue.id);
    if (!node) continue;
    const deps = Array.isArray(issue.dependencies) ? issue.dependencies : [];
    for (const dep of deps) {
      const targetId = dep.depends_on_id || dep.target || '';
      const depType = dep.type || 'blocks';
      if (!targetId) continue;
      edges.push({ from: issue.id, to: targetId, type: depType });
      if (depType === 'parent-child') {
        const parent = byId.get(targetId);
        if (parent) {
          parent.children.push(node);
          hasParent.add(issue.id);
        }
      } else if (depType === 'blocks') {
        node.blockedBy.push(targetId);
      }
    }
  }

  const roots: BeadTreeNode[] = [];
  for (const issue of issues) {
    if (!hasParent.has(issue.id)) {
      const rootNode = byId.get(issue.id);
      if (rootNode) roots.push(rootNode);
    }
  }

  function assignDepth(node: BeadTreeNode, depth: number): void {
    node.depth = depth;
    for (const child of node.children) {
      assignDepth(child, depth + 1);
    }
  }

  for (const root of roots) {
    assignDepth(root, 0);
  }
  return { roots, edges };
}

/**
 * Count total and closed nodes inside a tree branch.
 */
export function computeCompletion(node: BeadTreeNode): CompletionStats {
  let total = 1;
  let closed = node.status === 'closed' ? 1 : 0;
  for (const child of node.children) {
    const sub = computeCompletion(child);
    total += sub.total;
    closed += sub.closed;
  }
  return { total, closed };
}

/**
 * Format a read-only quote snippet for Antigravity chat context pills.
 */
export function formatQuotePayload(issue: BeadIssue): string {
  const status = issue.status || 'open';
  const priority = issue.priority !== undefined ? `P${issue.priority}` : 'P2';
  return `[Bead ${issue.id}] (${priority} | ${status}) ${issue.title || ''}`.trim();
}
