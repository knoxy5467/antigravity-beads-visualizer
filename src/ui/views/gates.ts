// @scry.entry
// id: src.ui-gates~3709746f
// kind: code
// summary: >-
//   Render the Gates and Approvals view with blocker chips and host bridge actions.
//   Also: ui, gates, approvals, blockers, quote, a2a
// status: active
// weight: 0.85
// tags: ["topic:ui", "ui", "scope:src", "src", "gates", "typescript"]
// rationale: >-
//   Surfaces open and resolved gates with blocker links and one-click quote or approval dispatch.
// applies: rendering gates panel, inspecting gate blockers, preparing gate decisions
// seeded_questions:
//   - "How does gates.ts display blocker chips and trigger gate actions?"
//   - "src/ui/views/gates.ts renderGatesView"
// @scry.entry.end

import type { BeadIssue, BeadSnapshot } from '../../core/graph.js';

/**
 * Render the Gates and Approvals view into the target container.
 */
export function renderGatesView(
  container: HTMLElement,
  snapshot: BeadSnapshot,
  selectedId: string | null,
  onSelect: (issue: BeadIssue) => void,
  onQuote: (issue: BeadIssue) => void,
  onSendDecision: (issue: BeadIssue) => void
): void {
  container.replaceChildren();

  const gates = snapshot.issues.filter((issue) => issue.issue_type === 'gate');
  if (gates.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bv-empty-state';
    empty.textContent = 'No gate issues found in this workspace.';
    container.appendChild(empty);
    return;
  }

  const issueById = new Map(snapshot.issues.map((issue) => [issue.id, issue]));
  const list = document.createElement('div');
  list.className = 'bv-gates-list';

  for (const gate of gates) {
    const card = document.createElement('article');
    card.className = 'bv-gate-card';
    if (selectedId === gate.id) card.classList.add('is-selected');
    card.setAttribute('data-testid', `gate-card-${gate.id}`);

    const topRow = document.createElement('div');
    topRow.className = 'bv-gate-top';

    const titleBtn = document.createElement('button');
    titleBtn.type = 'button';
    titleBtn.className = 'bv-gate-title-btn';
    titleBtn.textContent = `${gate.id}: ${gate.title}`;
    titleBtn.addEventListener('click', () => onSelect(gate));

    const statusBadge = document.createElement('span');
    statusBadge.className = 'bv-badge';
    statusBadge.textContent = gate.status || 'open';

    topRow.append(titleBtn, statusBadge);
    card.appendChild(topRow);

    if (gate.description) {
      const desc = document.createElement('p');
      desc.className = 'bv-gate-desc';
      desc.textContent = gate.description;
      card.appendChild(desc);
    }

    const blockers = (gate.dependencies || [])
      .filter((dep) => dep.type === 'blocks' && dep.depends_on_id)
      .map((dep) => dep.depends_on_id as string);

    if (blockers.length > 0) {
      const chipsWrap = document.createElement('div');
      chipsWrap.className = 'bv-blocker-chips';
      const label = document.createElement('span');
      label.className = 'bv-muted-label';
      label.textContent = 'Blocked by: ';
      chipsWrap.appendChild(label);

      for (const blockerId of blockers) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'bv-chip';
        chip.textContent = blockerId;
        const targetIssue = issueById.get(blockerId);
        if (targetIssue) {
          chip.addEventListener('click', () => onSelect(targetIssue));
        }
        chipsWrap.appendChild(chip);
      }
      card.appendChild(chipsWrap);
    }

    const actions = document.createElement('div');
    actions.className = 'bv-gate-actions';

    const quoteBtn = document.createElement('button');
    quoteBtn.type = 'button';
    quoteBtn.className = 'bv-btn bv-btn-sm';
    quoteBtn.textContent = 'Quote Gate';
    quoteBtn.setAttribute('data-testid', `gate-quote-${gate.id}`);
    quoteBtn.addEventListener('click', () => onQuote(gate));

    const decideBtn = document.createElement('button');
    decideBtn.type = 'button';
    decideBtn.className = 'bv-btn bv-btn-sm bv-btn-primary';
    decideBtn.textContent = 'Send Gate Decision';
    decideBtn.setAttribute('data-testid', `gate-decision-${gate.id}`);
    decideBtn.addEventListener('click', () => onSendDecision(gate));

    actions.append(quoteBtn, decideBtn);
    card.appendChild(actions);
    list.appendChild(card);
  }

  container.appendChild(list);
}
