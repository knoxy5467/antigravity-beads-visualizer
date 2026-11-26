// @scry.entry
// id: src.ui-inspector~4f807580
// kind: code
// summary: >-
//   Render the Issue Inspector with six-key notes grid, dependencies, comments, and actions.
//   Also: ui, inspector, six-key-notes, dependencies, quote, a2a
// status: active
// weight: 0.85
// tags: ["topic:ui", "ui", "scope:src", "src", "inspector", "typescript"]
// rationale: >-
//   Displays structured Bead metadata and lets users jump across dependencies or send messages.
// applies: rendering issue details, parsing six-key notes, triggering quote or agent messages
// seeded_questions:
//   - "How does inspector.ts render six-key notes and clickable dependency jump links?"
//   - "src/ui/views/inspector.ts renderInspector"
// @scry.entry.end

import type { BeadComment, BeadIssue, BeadSnapshot } from '../../core/graph.js';
import { parseSixKeyNotes } from '../../core/notes.js';

export interface InspectorCallbacks {
  onSelectIssue: (issue: BeadIssue) => void;
  onQuoteIssue: (issue: BeadIssue) => void;
  onMessageAgent: (issue: BeadIssue, target: 'current' | 'new') => void;
  onCopyText: (text: string) => void;
}

function appendField(parent: HTMLElement, label: string, value: string): void {
  const p = document.createElement('p');
  p.className = 'bv-inspector-field';
  const strong = document.createElement('strong');
  strong.textContent = `${label}: `;
  p.append(strong, document.createTextNode(value));
  parent.appendChild(p);
}

/**
 * Render the Issue Inspector body for the selected Bead issue.
 */
export function renderInspector(
  bodyEl: HTMLElement,
  issue: BeadIssue,
  comments: BeadComment[],
  snapshot: BeadSnapshot,
  callbacks: InspectorCallbacks
): void {
  bodyEl.replaceChildren();

  const heading = document.createElement('h3');
  heading.textContent = `${issue.id} - ${issue.title}`;
  bodyEl.appendChild(heading);

  appendField(
    bodyEl,
    'Status',
    `${issue.status ?? 'open'} | Priority: P${issue.priority ?? 2} | Type: ${issue.issue_type ?? 'task'} | Assignee: ${issue.assignee || 'unassigned'}`
  );
  appendField(bodyEl, 'Description', issue.description || 'No description.');
  appendField(bodyEl, 'Acceptance', issue.acceptance_criteria || issue.acceptance || 'None');

  if (issue.design) {
    const specRow = document.createElement('p');
    specRow.className = 'bv-inspector-field';
    const specLabel = document.createElement('strong');
    specLabel.textContent = 'Design Spec: ';
    const specBtn = document.createElement('button');
    specBtn.type = 'button';
    specBtn.className = 'bv-link-btn';
    specBtn.setAttribute('data-testid', 'inspector-spec-link');
    specBtn.textContent = issue.design;
    specBtn.addEventListener('click', () => callbacks.onCopyText(issue.design || ''));
    specRow.append(specLabel, specBtn);
    bodyEl.appendChild(specRow);
  }

  const parsedNotes = parseSixKeyNotes(issue.notes);
  const notesTitle = document.createElement('h4');
  notesTitle.className = 'bv-section-title';
  notesTitle.textContent = 'Six-Key Handoff Notes';
  bodyEl.appendChild(notesTitle);

  const notesGrid = document.createElement('div');
  notesGrid.className = 'bv-notes-grid';
  notesGrid.setAttribute('data-testid', 'inspector-notes-grid');
  const noteRows: Array<[string, string | undefined]> = [
    ['COMPLETED', parsedNotes.completed],
    ['IN PROGRESS', parsedNotes.inProgress],
    ['NEXT', parsedNotes.next],
    ['BLOCKERS', parsedNotes.blockers],
    ['KEY DECISION', parsedNotes.keyDecision],
    ['REFERENCE', parsedNotes.reference],
  ];
  for (const [label, value] of noteRows) {
    const cell = document.createElement('div');
    cell.className = 'bv-note-cell';
    const keyEl = document.createElement('span');
    keyEl.className = 'bv-note-key';
    keyEl.textContent = label;
    const valEl = document.createElement('span');
    valEl.className = 'bv-note-val';
    valEl.textContent = value || 'None';
    cell.append(keyEl, valEl);
    notesGrid.appendChild(cell);
  }
  bodyEl.appendChild(notesGrid);

  const issueById = new Map(snapshot.issues.map((item) => [item.id, item]));
  const deps = (issue.dependencies || []).filter((d) => d.depends_on_id);
  if (deps.length > 0) {
    const depTitle = document.createElement('h4');
    depTitle.className = 'bv-section-title';
    depTitle.textContent = 'Dependencies';
    bodyEl.appendChild(depTitle);

    const depWrap = document.createElement('div');
    depWrap.className = 'bv-dep-links';
    for (const dep of deps) {
      const targetId = dep.depends_on_id as string;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'bv-chip';
      chip.setAttribute('data-testid', `inspector-dep-link-${targetId}`);
      chip.textContent = `${dep.type || 'relates-to'}: ${targetId}`;
      const target = issueById.get(targetId);
      if (target) {
        chip.addEventListener('click', () => callbacks.onSelectIssue(target));
      }
      depWrap.appendChild(chip);
    }
    bodyEl.appendChild(depWrap);
  }

  const commentsTitle = document.createElement('h4');
  commentsTitle.className = 'bv-section-title';
  commentsTitle.textContent = 'Comments';
  bodyEl.appendChild(commentsTitle);

  const list = document.createElement('ul');
  list.className = 'bv-comments-list';
  if (comments.length === 0) {
    const emptyItem = document.createElement('li');
    emptyItem.textContent = 'None';
    list.appendChild(emptyItem);
  } else {
    for (const c of comments) {
      const li = document.createElement('li');
      const author = c.author || 'unknown';
      const bodyText = c.text || '';
      li.textContent = `${author}: ${bodyText}`;
      list.appendChild(li);
    }
  }
  bodyEl.appendChild(list);

  const actionRow = document.createElement('div');
  actionRow.className = 'bv-inspector-actions';

  const msgBtn = document.createElement('button');
  msgBtn.type = 'button';
  msgBtn.className = 'bv-btn bv-btn-sm';
  msgBtn.textContent = 'Message Agent';
  msgBtn.setAttribute('data-testid', 'bv-message-agent-btn');
  msgBtn.addEventListener('click', () => callbacks.onMessageAgent(issue, 'current'));

  const newConvBtn = document.createElement('button');
  newConvBtn.type = 'button';
  newConvBtn.className = 'bv-btn bv-btn-sm';
  newConvBtn.textContent = 'Start New Conversation';
  newConvBtn.setAttribute('data-testid', 'bv-new-conv-btn');
  newConvBtn.addEventListener('click', () => callbacks.onMessageAgent(issue, 'new'));

  actionRow.append(msgBtn, newConvBtn);
  bodyEl.appendChild(actionRow);
}
