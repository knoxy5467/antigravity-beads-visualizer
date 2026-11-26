// @scry.entry
// id: src.ui-board~fb6a96e2
// kind: code
// summary: >-
//   Render the four-lane Workflow Board with All, By Epic, and By Assignee grouping.
//   Also: ui, board, workflow-lanes, grouping, kanban
// status: active
// weight: 0.85
// tags: ["topic:ui", "ui", "scope:src", "src", "lanes", "typescript"]
// rationale: >-
//   Groups Ready, In Progress, Blocked, and Closed items in a read-only four-column board.
// applies: rendering workflow board lanes, switching group-by mode
// seeded_questions:
//   - "How does board.ts classify and group issues across the four workflow lanes?"
//   - "src/ui/views/board.ts renderBoardView"
// @scry.entry.end

import type { BeadIssue, BeadSnapshot } from '../../core/graph.js';
import {
  buildWorkflowLanes,
  groupLaneItems,
  type LaneGroupBy,
} from '../../core/lanes.js';

const LANE_DEFS = [
  { key: 'ready', label: 'Ready' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'closed', label: 'Closed' },
] as const;

/**
 * Render the Workflow Board with four lanes and a group-by selector.
 */
export function renderBoardView(
  container: HTMLElement,
  snapshot: BeadSnapshot,
  selectedId: string | null,
  groupBy: LaneGroupBy,
  onGroupByChange: (next: LaneGroupBy) => void,
  onSelect: (issue: BeadIssue) => void
): void {
  container.replaceChildren();

  const toolbar = document.createElement('div');
  toolbar.className = 'bv-subtoolbar';

  const groupLabel = document.createElement('label');
  groupLabel.className = 'bv-select-label';
  groupLabel.textContent = 'Group By: ';

  const select = document.createElement('select');
  select.className = 'bv-select';
  select.setAttribute('data-testid', 'board-group-select');
  const options: Array<{ value: LaneGroupBy; text: string }> = [
    { value: 'all', text: 'All' },
    { value: 'epic', text: 'By Epic' },
    { value: 'assignee', text: 'By Assignee' },
  ];
  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.text;
    el.selected = groupBy === opt.value;
    select.appendChild(el);
  }
  select.addEventListener('change', () => {
    onGroupByChange(select.value as LaneGroupBy);
  });

  groupLabel.appendChild(select);
  toolbar.appendChild(groupLabel);
  container.appendChild(toolbar);

  const lanes = buildWorkflowLanes(snapshot.issues, snapshot.blocked);
  const grid = document.createElement('div');
  grid.className = 'bv-board-grid';

  for (const def of LANE_DEFS) {
    const col = document.createElement('section');
    col.className = 'bv-lane';
    col.setAttribute('data-testid', `lane-${def.key}`);

    const items = lanes[def.key];
    const header = document.createElement('div');
    header.className = 'bv-lane-header';
    const title = document.createElement('h3');
    title.textContent = def.label;
    const count = document.createElement('span');
    count.className = 'bv-badge';
    count.textContent = String(items.length);
    header.append(title, count);
    col.appendChild(header);

    const groups = groupLaneItems(items, groupBy);
    for (const [groupKey, groupItems] of groups.entries()) {
      if (groupBy !== 'all') {
        const groupHeader = document.createElement('div');
        groupHeader.className = 'bv-lane-group-title';
        groupHeader.textContent = groupKey;
        col.appendChild(groupHeader);
      }
      for (const item of groupItems) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'bv-lane-card';
        if (selectedId === item.id) card.classList.add('is-selected');
        card.setAttribute('data-testid', `board-card-${item.id}`);

        const cardId = document.createElement('div');
        cardId.className = 'bv-card-id';
        cardId.textContent = `${item.id} | P${item.priority ?? 2}`;

        const cardTitle = document.createElement('div');
        cardTitle.className = 'bv-card-title';
        cardTitle.textContent = item.title;

        const cardMeta = document.createElement('div');
        cardMeta.className = 'bv-card-meta';
        cardMeta.textContent = item.assignee || 'unassigned';

        card.append(cardId, cardTitle, cardMeta);
        card.addEventListener('click', () => onSelect(item));
        col.appendChild(card);
      }
    }

    grid.appendChild(col);
  }

  container.appendChild(grid);
}
