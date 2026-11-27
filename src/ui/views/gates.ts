// @scry.entry
// id: src.ui-gates~3709746f
// kind: code
// summary: >-
//   Render the Gates and Approvals view with blocker chips, sidecar monitor, and host bridge actions.
//   Also: ui, gates, approvals, blockers, sidecar, agents, a2a
// status: active
// weight: 0.85
// tags: ["topic:ui", "ui", "scope:src", "src", "gates", "typescript"]
// rationale: >-
//   Surfaces open and resolved gates with blocker links, sidecar health, and worker dispatch controls.
// applies: rendering gates panel, inspecting gate blockers, queuing gate resolution and worker spawns
// seeded_questions:
//   - "How does gates.ts display sidecar health, managed agents, and gate controls?"
//   - "src/ui/views/gates.ts renderGatesView"
// @scry.entry.end

import type { BeadIssue, BeadSnapshot } from '../../core/graph.js';
import type { ManagedAgentRuntime, SidecarStateSnapshot } from '../../../sidecars/beads-gatekeeper/types.js';

/**
 * Render the Gates and Approvals view with sidecar status and worker controls.
 */
export function renderGatesView(
  container: HTMLElement,
  snapshot: BeadSnapshot,
  selectedId: string | null,
  onSelect: (issue: BeadIssue) => void,
  onQuote: (issue: BeadIssue) => void,
  onSendDecision: (issue: BeadIssue) => void,
  sidecarState?: SidecarStateSnapshot | null,
  onResolveGate?: (issue: BeadIssue) => void,
  onSpawnAgent?: (beadId: string, runtime: ManagedAgentRuntime, prompt: string) => void
): void {
  container.replaceChildren();

  const sidecarPanel = document.createElement('section');
  sidecarPanel.className = 'bv-sidecar-panel';
  sidecarPanel.setAttribute('data-testid', 'bv-sidecar-status');

  const sidecarHeader = document.createElement('h3');
  sidecarHeader.className = 'bv-section-title';
  sidecarHeader.textContent = 'Sidecar Gatekeeper and Workers';
  sidecarPanel.appendChild(sidecarHeader);

  const doltGrid = document.createElement('div');
  doltGrid.className = 'bv-sidecar-grid';
  if (sidecarState && sidecarState.doltStates.length > 0) {
    for (const dolt of sidecarState.doltStates) {
      const badge = document.createElement('span');
      badge.className = 'bv-badge';
      badge.textContent = `Dolt ${dolt.database}:${dolt.port} (${dolt.status})`;
      doltGrid.appendChild(badge);
    }
  } else {
    const idleNote = document.createElement('span');
    idleNote.className = 'bv-muted-label';
    idleNote.textContent = 'No opt-in Dolt servers reported by sidecar.';
    doltGrid.appendChild(idleNote);
  }
  sidecarPanel.appendChild(doltGrid);

  const agentsWrap = document.createElement('div');
  agentsWrap.className = 'bv-sidecar-agents';
  agentsWrap.setAttribute('data-testid', 'bv-sidecar-agents');
  if (sidecarState && sidecarState.agents.length > 0) {
    for (const agent of sidecarState.agents) {
      const row = document.createElement('div');
      row.className = 'bv-sidecar-agent-row';
      row.textContent = `${agent.id} | ${agent.runtime} | ${agent.beadId} | ${agent.status}`;
      agentsWrap.appendChild(row);
    }
  } else {
    const none = document.createElement('div');
    none.className = 'bv-muted-label';
    none.textContent = 'No managed workers active.';
    agentsWrap.appendChild(none);
  }
  sidecarPanel.appendChild(agentsWrap);

  if (onSpawnAgent) {
    const form = document.createElement('form');
    form.className = 'bv-spawn-form';
    const defaultBeadId =
      selectedId ?? snapshot.issues.find((item) => item.issue_type === 'task')?.id ?? 'bv-task-inspector';

    const beadInput = document.createElement('input');
    beadInput.type = 'text';
    beadInput.className = 'bv-input';
    beadInput.value = defaultBeadId;
    beadInput.setAttribute('aria-label', 'Bead ID');
    beadInput.setAttribute('data-testid', 'sidecar-spawn-bead');

    const runtimeSelect = document.createElement('select');
    runtimeSelect.className = 'bv-select';
    runtimeSelect.setAttribute('aria-label', 'Worker Runtime');
    runtimeSelect.setAttribute('data-testid', 'sidecar-spawn-runtime');
    for (const rt of ['desktop', 'agy'] as const) {
      const opt = document.createElement('option');
      opt.value = rt;
      opt.textContent = rt;
      runtimeSelect.appendChild(opt);
    }

    const promptInput = document.createElement('input');
    promptInput.type = 'text';
    promptInput.className = 'bv-input';
    promptInput.value = 'Run task verification for assigned bead.';
    promptInput.setAttribute('aria-label', 'Worker Prompt');
    promptInput.setAttribute('data-testid', 'sidecar-spawn-prompt');

    const spawnBtn = document.createElement('button');
    spawnBtn.type = 'submit';
    spawnBtn.className = 'bv-btn bv-btn-sm bv-btn-primary';
    spawnBtn.textContent = 'Spawn Worker';
    spawnBtn.setAttribute('data-testid', 'sidecar-spawn-btn');

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const beadId = beadInput.value.trim();
      const runtime = runtimeSelect.value === 'agy' ? 'agy' : 'desktop';
      const prompt = promptInput.value.trim();
      if (beadId && prompt) {
        onSpawnAgent(beadId, runtime, prompt);
      }
    });

    form.append(beadInput, runtimeSelect, promptInput, spawnBtn);
    sidecarPanel.appendChild(form);
  }

  container.appendChild(sidecarPanel);

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

    if (onResolveGate && gate.status !== 'closed') {
      const resolveBtn = document.createElement('button');
      resolveBtn.type = 'button';
      resolveBtn.className = 'bv-btn bv-btn-sm';
      resolveBtn.textContent = 'Resolve Gate';
      resolveBtn.setAttribute('data-testid', `gate-resolve-${gate.id}`);
      resolveBtn.addEventListener('click', () => onResolveGate(gate));
      actions.appendChild(resolveBtn);
    }

    card.appendChild(actions);
    list.appendChild(card);
  }

  container.appendChild(list);
}
