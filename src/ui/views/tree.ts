// @scry.entry
// id: src.ui-tree~51a43727
// kind: code
// summary: >-
//   Render the collapsible nested Beads epic tree with search, status, and priority filters.
//   Also: ui, tree, epic-hierarchy, filters, progress-bar
// status: active
// weight: 0.85
// tags: ["topic:ui", "ui", "scope:src", "src", "tree", "typescript"]
// rationale: >-
//   Displays L0 meta-epics, L1 sub-epics, and L2 leaf tasks with deterministic completion counts.
// applies: rendering epic tree view, filtering tree nodes, toggling collapse state
// seeded_questions:
//   - "How does tree.ts filter nested nodes while preserving matching descendants?"
//   - "src/ui/views/tree.ts renderEpicTreeView"
// @scry.entry.end

import {
  buildEpicTree,
  computeCompletion,
  type BeadIssue,
  type BeadSnapshot,
  type BeadTreeNode,
} from '../../core/graph.js';

export interface TreeFilterState {
  search: string;
  status: string;
  priority: string;
}

function matchesDirectFilter(issue: BeadIssue, filters: TreeFilterState): boolean {
  const query = filters.search.trim().toLowerCase();
  if (query) {
    const haystack = [issue.id, issue.title, issue.description || '', issue.assignee || '']
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }

  if (filters.status !== 'all') {
    const status = issue.status || 'open';
    if (status !== filters.status) return false;
  }

  if (filters.priority !== 'all') {
    const priority = String(issue.priority ?? 2);
    if (priority !== filters.priority) return false;
  }

  return true;
}

function filterTreeNode(node: BeadTreeNode, filters: TreeFilterState): BeadTreeNode | null {
  const filteredChildren = node.children
    .map((child) => filterTreeNode(child, filters))
    .filter((child): child is BeadTreeNode => child !== null);

  if (matchesDirectFilter(node, filters) || filteredChildren.length > 0) {
    return { ...node, children: filteredChildren };
  }
  return null;
}

function renderNodeElement(
  node: BeadTreeNode,
  selectedId: string | null,
  collapsedIds: Set<string>,
  onSelect: (issue: BeadIssue) => void,
  onToggleCollapse: (id: string) => void
): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'bv-node';

  const row = document.createElement('div');
  row.className = 'bv-node-row';

  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsedIds.has(node.id);

  if (hasChildren) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'bv-tree-toggle';
    toggle.setAttribute('data-testid', `tree-toggle-${node.id}`);
    toggle.setAttribute('aria-expanded', String(!isCollapsed));
    toggle.textContent = isCollapsed ? '+' : '-';
    toggle.addEventListener('click', () => onToggleCollapse(node.id));
    row.appendChild(toggle);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'bv-tree-spacer';
    row.appendChild(spacer);
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bv-node-btn';
  if (selectedId === node.id) {
    btn.classList.add('is-selected');
  }
  btn.setAttribute('data-testid', `tree-node-${node.id}`);

  const stats = computeCompletion(node);
  const labelWrap = document.createElement('span');
  labelWrap.className = 'bv-node-title-wrap';

  const depthPill = document.createElement('span');
  depthPill.className = 'bv-depth-pill';
  depthPill.textContent = `L${node.depth}`;

  const labelText = document.createElement('span');
  labelText.textContent = `${node.id}: ${node.title}`;
  labelWrap.append(depthPill, labelText);

  const meta = document.createElement('span');
  meta.className = 'bv-meta';
  meta.textContent = `P${node.priority ?? 2} | ${node.status ?? 'open'} (${stats.closed}/${stats.total})`;

  const progressTrack = document.createElement('span');
  progressTrack.className = 'bv-progress-track';
  const progressFill = document.createElement('span');
  progressFill.className = 'bv-progress-fill';
  const pct = stats.total > 0 ? Math.round((stats.closed / stats.total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  progressTrack.appendChild(progressFill);

  const rightCol = document.createElement('span');
  rightCol.className = 'bv-node-meta-col';
  rightCol.append(meta, progressTrack);

  btn.append(labelWrap, rightCol);
  btn.addEventListener('click', () => onSelect(node));
  row.appendChild(btn);
  wrapper.appendChild(row);

  if (hasChildren && !isCollapsed) {
    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'bv-node-children';
    for (const child of node.children) {
      childrenWrap.appendChild(
        renderNodeElement(child, selectedId, collapsedIds, onSelect, onToggleCollapse)
      );
    }
    wrapper.appendChild(childrenWrap);
  }

  return wrapper;
}

/**
 * Render the Epic Tree panel into the target container element.
 */
export function renderEpicTreeView(
  container: HTMLElement,
  snapshot: BeadSnapshot,
  selectedId: string | null,
  collapsedIds: Set<string>,
  filters: TreeFilterState,
  onSelect: (issue: BeadIssue) => void,
  onToggleCollapse: (id: string) => void
): void {
  container.replaceChildren();
  const roots = buildEpicTree(snapshot.issues)
    .roots.map((root) => filterTreeNode(root, filters))
    .filter((root): root is BeadTreeNode => root !== null);

  if (roots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bv-empty-state';
    empty.textContent = 'No epics or tasks match the active filters.';
    container.appendChild(empty);
    return;
  }

  for (const root of roots) {
    container.appendChild(
      renderNodeElement(root, selectedId, collapsedIds, onSelect, onToggleCollapse)
    );
  }
}
