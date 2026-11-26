// @scry.entry
// id: src.ui-dag~981afd17
// kind: code
// summary: >-
//   Render the interactive SVG Dependency DAG with edge filters, zoom controls, and neighbor highlights.
//   Also: ui, dag, svg, dependency-graph, zoom, highlight
// status: active
// weight: 0.85
// tags: ["topic:ui", "ui", "scope:src", "src", "dag", "typescript"]
// rationale: >-
//   Visualizes directed dependency edges and highlights upstream and downstream neighbors on click.
// applies: rendering svg dependency graph, filtering edge types, zooming graph canvas
// seeded_questions:
//   - "How does dag.ts render directed edges and neighbor highlights in SVG?"
//   - "src/ui/views/dag.ts renderDagView"
// @scry.entry.end

import { buildDagLayout, getNeighborHighlight } from '../../core/dag.js';
import type { BeadIssue, BeadSnapshot } from '../../core/graph.js';

export interface DagViewState {
  visibleTypes: Set<string>;
  zoom: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const EDGE_TYPES = ['blocks', 'parent-child', 'discovered-from', 'relates-to'] as const;
const NODE_WIDTH = 190;
const NODE_HEIGHT = 56;

/**
 * Render the Dependency DAG view with toolbar and SVG canvas.
 */
export function renderDagView(
  container: HTMLElement,
  snapshot: BeadSnapshot,
  selectedId: string | null,
  state: DagViewState,
  onSelect: (issue: BeadIssue) => void,
  onStateChange: () => void
): void {
  container.replaceChildren();

  const toolbar = document.createElement('div');
  toolbar.className = 'bv-subtoolbar';

  const filterGroup = document.createElement('div');
  filterGroup.className = 'bv-filter-group';
  for (const edgeType of EDGE_TYPES) {
    const label = document.createElement('label');
    label.className = 'bv-checkbox-label';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.visibleTypes.has(edgeType);
    checkbox.setAttribute('data-testid', `dag-filter-${edgeType}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.visibleTypes.add(edgeType);
      else state.visibleTypes.delete(edgeType);
      onStateChange();
    });

    const text = document.createElement('span');
    text.textContent = edgeType;
    label.append(checkbox, text);
    filterGroup.appendChild(label);
  }

  const zoomGroup = document.createElement('div');
  zoomGroup.className = 'bv-zoom-group';

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.type = 'button';
  zoomOutBtn.className = 'bv-btn bv-btn-sm';
  zoomOutBtn.textContent = '-';
  zoomOutBtn.setAttribute('data-testid', 'dag-zoom-out');
  zoomOutBtn.addEventListener('click', () => {
    state.zoom = Math.max(0.55, Number((state.zoom - 0.15).toFixed(2)));
    onStateChange();
  });

  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'bv-zoom-label';
  zoomLabel.setAttribute('data-testid', 'dag-zoom-label');
  zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;

  const zoomInBtn = document.createElement('button');
  zoomInBtn.type = 'button';
  zoomInBtn.className = 'bv-btn bv-btn-sm';
  zoomInBtn.textContent = '+';
  zoomInBtn.setAttribute('data-testid', 'dag-zoom-in');
  zoomInBtn.addEventListener('click', () => {
    state.zoom = Math.min(1.6, Number((state.zoom + 0.15).toFixed(2)));
    onStateChange();
  });

  const zoomResetBtn = document.createElement('button');
  zoomResetBtn.type = 'button';
  zoomResetBtn.className = 'bv-btn bv-btn-sm';
  zoomResetBtn.textContent = 'Reset';
  zoomResetBtn.setAttribute('data-testid', 'dag-zoom-reset');
  zoomResetBtn.addEventListener('click', () => {
    state.zoom = 1;
    onStateChange();
  });

  zoomGroup.append(zoomOutBtn, zoomLabel, zoomInBtn, zoomResetBtn);
  toolbar.append(filterGroup, zoomGroup);
  container.appendChild(toolbar);

  const layout = buildDagLayout(snapshot.issues);
  if (layout.nodes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bv-empty-state';
    empty.textContent = 'No nodes available for the Dependency DAG.';
    container.appendChild(empty);
    return;
  }

  const issueById = new Map(snapshot.issues.map((issue) => [issue.id, issue]));
  const posById = new Map<string, { x: number; y: number }>();
  for (const node of layout.nodes) {
    posById.set(node.id, { x: node.x, y: node.y });
  }

  const baseWidth = layout.width;
  const baseHeight = layout.height;
  const highlight = selectedId
    ? getNeighborHighlight(selectedId, layout.edges)
    : { upstream: new Set<string>(), downstream: new Set<string>() };

  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'bv-dag-scroll';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('data-testid', 'bv-dag-svg');
  svg.setAttribute('viewBox', `0 0 ${baseWidth} ${baseHeight}`);
  svg.setAttribute('width', String(Math.round(baseWidth * state.zoom)));
  svg.setAttribute('height', String(Math.round(baseHeight * state.zoom)));
  svg.classList.add('bv-dag-svg');

  const defs = document.createElementNS(SVG_NS, 'defs');
  const marker = document.createElementNS(SVG_NS, 'marker');
  marker.setAttribute('id', 'bv-arrow');
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '8');
  marker.setAttribute('refX', '7');
  marker.setAttribute('refY', '3');
  marker.setAttribute('orient', 'auto');
  const arrowPath = document.createElementNS(SVG_NS, 'path');
  arrowPath.setAttribute('d', 'M0,0 L0,6 L7,3 z');
  arrowPath.setAttribute('fill', 'currentColor');
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  svg.appendChild(defs);

  for (const edge of layout.edges) {
    if (!state.visibleTypes.has(edge.type)) continue;
    const fromPos = posById.get(edge.from);
    const toPos = posById.get(edge.to);
    if (!fromPos || !toPos) continue;

    const x1 = fromPos.x + NODE_WIDTH;
    const y1 = fromPos.y + NODE_HEIGHT / 2;
    const x2 = toPos.x;
    const y2 = toPos.y + NODE_HEIGHT / 2;
    const midX = (x1 + x2) / 2;

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`);
    path.setAttribute('data-testid', `dag-edge-${edge.type}`);
    path.setAttribute('class', `bv-dag-edge bv-edge-${edge.type}`);
    path.setAttribute('marker-end', 'url(#bv-arrow)');
    if (selectedId && (edge.from === selectedId || edge.to === selectedId)) {
      path.classList.add('is-highlighted');
    }
    svg.appendChild(path);
  }

  for (const node of layout.nodes) {
    const pos = posById.get(node.id);
    const issue = issueById.get(node.id);
    if (!pos || !issue) continue;

    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-testid', `dag-node-${node.id}`);
    group.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);
    group.classList.add('bv-dag-node');
    if (selectedId === node.id) {
      group.classList.add('is-selected');
    } else if (highlight.upstream.has(node.id) || highlight.downstream.has(node.id)) {
      group.classList.add('is-neighbor');
    }

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('width', String(NODE_WIDTH));
    rect.setAttribute('height', String(NODE_HEIGHT));
    rect.setAttribute('rx', '8');
    rect.classList.add('bv-dag-rect');

    const titleText = document.createElementNS(SVG_NS, 'text');
    titleText.setAttribute('x', '10');
    titleText.setAttribute('y', '21');
    titleText.classList.add('bv-dag-id');
    titleText.textContent = `${node.id} (${node.status})`;

    const subText = document.createElementNS(SVG_NS, 'text');
    subText.setAttribute('x', '10');
    subText.setAttribute('y', '40');
    subText.classList.add('bv-dag-title');
    subText.textContent = node.title.length > 23 ? `${node.title.slice(0, 22)}...` : node.title;

    group.append(rect, titleText, subText);
    group.addEventListener('click', () => onSelect(issue));
    svg.appendChild(group);
  }

  scrollWrap.appendChild(svg);
  container.appendChild(scrollWrap);
}
