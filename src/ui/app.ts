// @scry.entry
// id: src.ui-app~d94924b2
// kind: code
// summary: >-
//   Coordinate the 4-tab Beads Visualizer shell, live refresh, filters, and inspector bridge.
//   Also: ui, app, tabs, live-refresh, inspector, quote-pill, typescript
// status: active
// weight: 0.85
// tags: ["topic:ui", "ui", "scope:src", "src", "beads", "inspector", "typescript"]
// rationale: >-
//   Binds the Epic Tree, Dependency DAG, Workflow Board, Gates view, and Issue Inspector together.
// applies: initializing visualizer ui, switching tabs, polling beads snapshots
// seeded_questions:
//   - "How does app.ts coordinate tab views, live polling, and inspector actions?"
//   - "src/ui/app.ts renderAllViews"
// @scry.entry.end

import type { BeadIssue, BeadSnapshot } from '../core/graph.js';
import type { LaneGroupBy } from '../core/lanes.js';
import { createHostBridge } from './host-bridge.js';
import { renderBoardView } from './views/board.js';
import { renderDagView, type DagViewState } from './views/dag.js';
import { renderGatesView } from './views/gates.js';
import { renderInspector } from './views/inspector.js';
import { renderEpicTreeView, type TreeFilterState } from './views/tree.js';

type TabKey = 'tree' | 'dag' | 'board' | 'gates';

const bridge = createHostBridge();
let currentSnapshot: BeadSnapshot | null = null;
let selectedIssue: BeadIssue | null = null;
let selectedWorkspace = '';
let activeTab: TabKey = 'tree';
let pollTimer: number | null = null;
let autoPollEnabled = true;
let isRefreshing = false;
let snapshotRequestId = 0;
let lastLoadError: string | null = null;

const collapsedIds = new Set<string>();
const treeFilters: TreeFilterState = {
  search: '',
  status: 'all',
  priority: 'all',
};
const dagState: DagViewState = {
  visibleTypes: new Set(['blocks', 'parent-child', 'discovered-from', 'relates-to']),
  zoom: 1,
};
let boardGroupBy: LaneGroupBy = 'all';

function setActionStatus(text: string): void {
  const statusEl = document.getElementById('action-status');
  if (statusEl) statusEl.textContent = text;
}

function renderLoadError(message: string): void {
  const panel = document.getElementById(`view-${activeTab}`);
  if (!panel) return;
  const box = document.createElement('div');
  box.className = 'bv-load-error';
  box.dataset.testid = 'bv-load-error';
  box.textContent = message;
  panel.replaceChildren(box);
}

function resetWorkspaceViewState(): void {
  currentSnapshot = null;
  selectedIssue = null;
  lastLoadError = null;

  const tabKeys: TabKey[] = ['tree', 'dag', 'board', 'gates'];
  for (const key of tabKeys) {
    document.getElementById(`view-${key}`)?.replaceChildren();
  }

  const bodyEl = document.getElementById('inspector-body');
  if (bodyEl) {
    bodyEl.textContent = 'Select an epic or task to inspect details.';
  }
  const quoteBtn = document.getElementById('quote-btn') as HTMLButtonElement | null;
  if (quoteBtn) quoteBtn.disabled = true;
  const quotePreview = document.getElementById('quote-preview');
  if (quotePreview) quotePreview.textContent = '';

  const badgeEl = document.querySelector('[data-testid="bv-workspace-badge"]');
  if (badgeEl) badgeEl.textContent = 'loading...';
}

async function handleQuote(issue: BeadIssue): Promise<void> {
  const previewEl = document.getElementById('quote-preview');
  const payload = await bridge.quoteBead(issue);
  if (previewEl) previewEl.textContent = payload;
  setActionStatus(`Prepared quote pill for ${issue.id}.`);
}

async function handleAgentMessage(issue: BeadIssue, target: 'current' | 'new'): Promise<void> {
  const msg = `Regarding ${issue.id} (${issue.title}) [${issue.status ?? 'open'}]: please review and proceed.`;
  const result = await bridge.sendAgentMessage(msg, target);
  setActionStatus(result);
}

async function selectIssue(issue: BeadIssue): Promise<void> {
  selectedIssue = issue;
  const bodyEl = document.getElementById('inspector-body');
  const quoteBtn = document.getElementById('quote-btn') as HTMLButtonElement | null;
  const quotePreview = document.getElementById('quote-preview');
  if (!bodyEl || !quoteBtn || !quotePreview || !currentSnapshot) return;

  quoteBtn.disabled = false;
  quotePreview.textContent = '';

  let comments = issue.comments || [];
  try {
    const fetched = await bridge.fetchIssueComments(issue.id, selectedWorkspace || undefined);
    if (fetched.length > 0) comments = fetched;
  } catch {
    // Keep snapshot comments when detail fetch is unavailable.
  }

  renderInspector(bodyEl, issue, comments, currentSnapshot, {
    onSelectIssue: (targetIssue) => void selectIssue(targetIssue),
    onQuoteIssue: (targetIssue) => void handleQuote(targetIssue),
    onMessageAgent: (targetIssue, target) => void handleAgentMessage(targetIssue, target),
    onCopyText: (text) => {
      setActionStatus(`Spec path: ${text}`);
    },
  });

  renderAllViews();
}

function switchTab(nextTab: TabKey): void {
  activeTab = nextTab;
  const tabKeys: TabKey[] = ['tree', 'dag', 'board', 'gates'];
  for (const key of tabKeys) {
    const tabBtn = document.getElementById(`tab-${key}`);
    const panel = document.getElementById(`view-${key}`);
    if (tabBtn) tabBtn.classList.toggle('is-active', key === activeTab);
    if (panel) panel.classList.toggle('is-hidden', key !== activeTab);
  }
  const treeToolbar = document.getElementById('tree-toolbar');
  if (treeToolbar) {
    treeToolbar.classList.toggle('is-hidden', activeTab !== 'tree');
  }
  renderAllViews();
}

function renderAllViews(): void {
  if (!currentSnapshot) {
    if (lastLoadError) {
      renderLoadError(lastLoadError);
    }
    return;
  }
  const selectedId = selectedIssue ? selectedIssue.id : null;

  const treeEl = document.getElementById('view-tree');
  if (treeEl && activeTab === 'tree') {
    renderEpicTreeView(
      treeEl,
      currentSnapshot,
      selectedId,
      collapsedIds,
      treeFilters,
      (issue) => void selectIssue(issue),
      (id) => {
        if (collapsedIds.has(id)) collapsedIds.delete(id);
        else collapsedIds.add(id);
        renderAllViews();
      }
    );
  }

  const dagEl = document.getElementById('view-dag');
  if (dagEl && activeTab === 'dag') {
    renderDagView(
      dagEl,
      currentSnapshot,
      selectedId,
      dagState,
      (issue) => void selectIssue(issue),
      () => renderAllViews()
    );
  }

  const boardEl = document.getElementById('view-board');
  if (boardEl && activeTab === 'board') {
    renderBoardView(
      boardEl,
      currentSnapshot,
      selectedId,
      boardGroupBy,
      (nextGroup) => {
        boardGroupBy = nextGroup;
        renderAllViews();
      },
      (issue) => void selectIssue(issue)
    );
  }

  const gatesEl = document.getElementById('view-gates');
  if (gatesEl && activeTab === 'gates') {
    renderGatesView(
      gatesEl,
      currentSnapshot,
      selectedId,
      (issue) => void selectIssue(issue),
      (issue) => void handleQuote(issue),
      (issue) => void handleAgentMessage(issue, 'current')
    );
  }
}

async function loadWorkspaces(): Promise<void> {
  const selectEl = document.getElementById('workspace-select') as HTMLSelectElement | null;
  if (!selectEl) return;
  try {
    const workspaces = await bridge.fetchWorkspaces();
    selectEl.replaceChildren();
    for (const ws of workspaces) {
      const opt = document.createElement('option');
      opt.value = ws;
      opt.textContent = ws;
      selectEl.appendChild(opt);
    }
    if (workspaces.length > 0 && !selectedWorkspace) {
      selectedWorkspace = workspaces[0] || '';
      selectEl.value = selectedWorkspace;
    }
  } catch {
    // Ignore workspace dropdown errors during initialization.
  }
}

function clearPollTimer(): void {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function scheduleNextPoll(): void {
  clearPollTimer();
  if (!autoPollEnabled) return;
  pollTimer = window.setTimeout(() => {
    pollTimer = null;
    void refreshSnapshot(false, true);
  }, 5000);
}

async function refreshSnapshot(forceFull = false, fromAutoPoll = false): Promise<void> {
  if (fromAutoPoll && isRefreshing) {
    return;
  }

  const badgeEl = document.querySelector('[data-testid="bv-workspace-badge"]');
  const bannerEl = document.querySelector('[data-testid="bv-env-banner"]');
  const statusEl = document.getElementById('action-status');
  const reqId = ++snapshotRequestId;
  clearPollTimer();
  isRefreshing = true;

  try {
    const etag = forceFull ? undefined : currentSnapshot?.etag;
    const data = await bridge.fetchSnapshot(etag, selectedWorkspace || undefined);
    if (reqId !== snapshotRequestId) return;
    if (data.unchanged) return;

    currentSnapshot = data;
    lastLoadError = null;
    if (badgeEl) badgeEl.textContent = data.workspace;
    if (bannerEl) {
      bannerEl.textContent = data.testEnv === 'synthetic' ? 'Synthetic Test Environment' : 'Live Mode';
    }
    if (statusEl?.textContent?.startsWith('Snapshot load failed:')) {
      setActionStatus('');
    }

    if (selectedIssue) {
      const updated = data.issues.find((item) => item.id === selectedIssue?.id);
      if (updated) selectedIssue = updated;
    }
    renderAllViews();
  } catch (err) {
    if (reqId !== snapshotRequestId) return;
    const message = err instanceof Error ? err.message : String(err);
    lastLoadError = message;
    setActionStatus(`Snapshot load failed: ${message}`);
    if (badgeEl && (!currentSnapshot || badgeEl.textContent === 'loading...')) {
      badgeEl.textContent = selectedWorkspace || 'unavailable';
    }
    if (!currentSnapshot) {
      renderLoadError(message);
    }
  } finally {
    if (reqId === snapshotRequestId) {
      isRefreshing = false;
      scheduleNextPoll();
    }
  }
}

function updateAutoPoll(enabled: boolean): void {
  autoPollEnabled = enabled;
  if (!enabled) {
    clearPollTimer();
    return;
  }
  if (!isRefreshing) {
    scheduleNextPoll();
  }
}

function bindEvents(): void {
  document.getElementById('tab-tree')?.addEventListener('click', () => switchTab('tree'));
  document.getElementById('tab-dag')?.addEventListener('click', () => switchTab('dag'));
  document.getElementById('tab-board')?.addEventListener('click', () => switchTab('board'));
  document.getElementById('tab-gates')?.addEventListener('click', () => switchTab('gates'));

  document.getElementById('refresh-btn')?.addEventListener('click', () => {
    void refreshSnapshot(true);
  });

  document.getElementById('quote-btn')?.addEventListener('click', () => {
    if (selectedIssue) void handleQuote(selectedIssue);
  });

  const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
  searchInput?.addEventListener('input', () => {
    treeFilters.search = searchInput.value;
    renderAllViews();
  });

  const statusSelect = document.getElementById('status-filter') as HTMLSelectElement | null;
  statusSelect?.addEventListener('change', () => {
    treeFilters.status = statusSelect.value;
    renderAllViews();
  });

  const prioritySelect = document.getElementById('priority-filter') as HTMLSelectElement | null;
  prioritySelect?.addEventListener('change', () => {
    treeFilters.priority = prioritySelect.value;
    renderAllViews();
  });

  const workspaceSelect = document.getElementById('workspace-select') as HTMLSelectElement | null;
  workspaceSelect?.addEventListener('change', () => {
    selectedWorkspace = workspaceSelect.value;
    resetWorkspaceViewState();
    void refreshSnapshot(true);
  });

  const autoPollToggle = document.getElementById('auto-poll-toggle') as HTMLInputElement | null;
  autoPollToggle?.addEventListener('change', () => {
    updateAutoPoll(autoPollToggle.checked);
  });
}

async function init(): Promise<void> {
  bindEvents();
  const autoPollToggle = document.getElementById('auto-poll-toggle') as HTMLInputElement | null;
  autoPollEnabled = autoPollToggle ? autoPollToggle.checked : true;
  await loadWorkspaces();
  await refreshSnapshot(true);
}

void init();
