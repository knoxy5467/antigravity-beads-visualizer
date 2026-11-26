// @scry.entry
// id: src.core-graph~de0a9e0c
// kind: code
// summary: >-
//   Build recursive epic trees, dependency edges, completion counts, and quote payloads.
//   Also: graph, epic-tree, completion, quote-payload, parent-child, blocks
// status: active
// weight: 0.8
// tags: ["topic:graph", "graph", "scope:src", "src", "beads", "epics"]
// rationale: >-
//   Centralizes pure read-only Beads hierarchy and quote formatting logic for UI and tests.
// applies: building epic trees, computing completion stats, formatting quote pills
// seeded_questions:
//   - "How does buildEpicTree nest meta-epics, sub-epics, and tasks?"
//   - "src/core/graph.mjs buildEpicTree"
// @scry.entry.end

/**
 * Build a nested tree of epics and child tasks from flat Beads issues.
 * @param {Array<object>} issues
 * @returns {{roots: Array<object>, edges: Array<object>}}
 */
export function buildEpicTree(issues) {
  const byId = new Map();
  const edges = [];

  for (const issue of issues) {
    byId.set(issue.id, { ...issue, children: [], blockedBy: [] });
  }

  const hasParent = new Set();
  for (const issue of issues) {
    const node = byId.get(issue.id);
    const deps = Array.isArray(issue.dependencies) ? issue.dependencies : [];
    for (const dep of deps) {
      const targetId = dep.depends_on_id || dep.target || '';
      const depType = dep.type || 'blocks';
      if (!targetId) continue;
      edges.push({ from: issue.id, to: targetId, type: depType });
      if (depType === 'parent-child' && byId.has(targetId)) {
        byId.get(targetId).children.push(node);
        hasParent.add(issue.id);
      } else if (depType === 'blocks') {
        node.blockedBy.push(targetId);
      }
    }
  }

  const roots = [];
  for (const issue of issues) {
    if (!hasParent.has(issue.id)) {
      roots.push(byId.get(issue.id));
    }
  }

  function assignDepth(node, depth) {
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
 * @param {object} node
 * @returns {{total: number, closed: number}}
 */
export function computeCompletion(node) {
  let total = 1;
  let closed = node.status === 'closed' ? 1 : 0;
  for (const child of node.children || []) {
    const sub = computeCompletion(child);
    total += sub.total;
    closed += sub.closed;
  }
  return { total, closed };
}

/**
 * Format a read-only quote snippet for Antigravity chat context pills.
 * @param {object} issue
 * @returns {string}
 */
export function formatQuotePayload(issue) {
  const status = issue.status || 'open';
  const priority = issue.priority !== undefined ? `P${issue.priority}` : 'P2';
  return `[Bead ${issue.id}] (${priority} | ${status}) ${issue.title || ''}`.trim();
}
