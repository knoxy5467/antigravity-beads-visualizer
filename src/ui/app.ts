// @scry.entry
// id: src.ui-app~d94924b2
// kind: code
// summary: >-
//   Render the interactive Beads epic tree, issue inspector, and quote pill preview in TypeScript.
//   Also: ui, app, tree-render, inspector, quote-pill, playwright, typescript
// status: active
// weight: 0.8
// tags: ["topic:ui", "ui", "scope:src", "src", "beads", "inspector", "typescript"]
// rationale: >-
//   Drives the standalone and embedded browser DOM from read-only Beads snapshots.
// applies: rendering epic trees, inspecting bead details, preparing quote payloads
// seeded_questions:
//   - "How does app.ts render nested epics and populate the issue inspector?"
//   - "src/ui/app.ts renderNode"
// @scry.entry.end

import {
  buildEpicTree,
  computeCompletion,
  formatQuotePayload,
  type BeadIssue,
  type BeadSnapshot,
  type BeadTreeNode,
} from '../core/graph.js';

let currentSnapshot: BeadSnapshot | null = null;
let selectedIssue: BeadIssue | null = null;

function renderNode(node: BeadTreeNode): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'bv-node';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bv-node-btn';
  btn.setAttribute('data-testid', `tree-node-${node.id}`);

  const stats = computeCompletion(node);
  const labelWrap = document.createElement('span');
  const depthPill = document.createElement('span');
  depthPill.className = 'bv-depth-pill';
  depthPill.textContent = `L${node.depth}`;
  const labelText = document.createElement('span');
  labelText.textContent = `${node.id}: ${node.title}`;
  labelWrap.append(depthPill, labelText);

  const meta = document.createElement('span');
  meta.className = 'bv-meta';
  meta.textContent = `P${node.priority ?? 2} | ${node.status ?? 'open'} (${stats.closed}/${stats.total})`;

  btn.append(labelWrap, meta);
  btn.addEventListener('click', () => selectIssue(node));
  wrapper.appendChild(btn);

  for (const child of node.children) {
    wrapper.appendChild(renderNode(child));
  }
  return wrapper;
}

function appendLabeledParagraph(parent: HTMLElement, label: string, value: string): void {
  const p = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = `${label}: `;
  p.append(strong, document.createTextNode(value));
  parent.appendChild(p);
}

function selectIssue(issue: BeadIssue): void {
  selectedIssue = issue;
  const body = document.getElementById('inspector-body');
  const quoteBtn = document.getElementById('quote-btn') as HTMLButtonElement | null;
  const quotePreview = document.getElementById('quote-preview');
  if (!body || !quoteBtn || !quotePreview) return;

  quoteBtn.disabled = false;
  quotePreview.textContent = '';
  body.replaceChildren();

  const heading = document.createElement('h3');
  heading.textContent = `${issue.id} - ${issue.title}`;
  body.appendChild(heading);

  appendLabeledParagraph(body, 'Status', `${issue.status ?? 'open'} | Priority: P${issue.priority ?? 2}`);
  appendLabeledParagraph(body, 'Description', issue.description || 'No description.');
  appendLabeledParagraph(body, 'Acceptance', issue.acceptance || 'None');
  appendLabeledParagraph(body, 'Notes', issue.notes || 'None');

  const commentsWrap = document.createElement('div');
  const commentsTitle = document.createElement('strong');
  commentsTitle.textContent = 'Comments:';
  const list = document.createElement('ul');
  const comments = issue.comments || [];
  if (comments.length === 0) {
    const emptyItem = document.createElement('li');
    emptyItem.textContent = 'None';
    list.appendChild(emptyItem);
  } else {
    for (const c of comments) {
      const item = document.createElement('li');
      const author = document.createElement('strong');
      author.textContent = `${c.author}: `;
      item.append(author, document.createTextNode(c.text));
      list.appendChild(item);
    }
  }
  commentsWrap.append(commentsTitle, list);
  body.appendChild(commentsWrap);
}

async function loadAndRender(): Promise<void> {
  const res = await fetch('/api/snapshot');
  currentSnapshot = (await res.json()) as BeadSnapshot;

  const envBanner = document.querySelector('[data-testid="bv-env-banner"]');
  if (envBanner) {
    envBanner.textContent =
      currentSnapshot.testEnv === 'synthetic' ? 'Synthetic Test Environment' : 'Live Workspace';
  }

  const badge = document.querySelector('[data-testid="bv-workspace-badge"]');
  if (badge) {
    badge.textContent = `${currentSnapshot.workspace} (${currentSnapshot.testEnv})`;
  }

  const treeContainer = document.getElementById('epic-tree');
  if (!treeContainer) return;
  treeContainer.replaceChildren();
  const { roots } = buildEpicTree(currentSnapshot.issues || []);
  for (const root of roots) {
    treeContainer.appendChild(renderNode(root));
  }
}

document.getElementById('refresh-btn')?.addEventListener('click', () => {
  void loadAndRender();
});
document.getElementById('quote-btn')?.addEventListener('click', () => {
  if (!selectedIssue) return;
  const preview = document.getElementById('quote-preview');
  if (preview) {
    preview.textContent = formatQuotePayload(selectedIssue);
  }
});

void loadAndRender();
