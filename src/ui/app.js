// @scry.entry
// id: src.ui-app~d94924b2
// kind: code
// summary: >-
//   Render the interactive Beads epic tree, issue inspector, and quote pill preview.
//   Also: ui, app, tree-render, inspector, quote-pill, playwright
// status: active
// weight: 0.8
// tags: ["topic:ui", "ui", "scope:src", "src", "beads", "inspector"]
// rationale: >-
//   Drives the standalone and embedded browser DOM from read-only Beads snapshots.
// applies: rendering epic trees, inspecting bead details, preparing quote payloads
// seeded_questions:
//   - "How does app.js render nested epics and populate the issue inspector?"
//   - "src/ui/app.js renderTree"
// @scry.entry.end

import { buildEpicTree, computeCompletion, formatQuotePayload } from '/core/graph.mjs';

let currentSnapshot = null;
let selectedIssue = null;

function renderNode(node) {
  const wrapper = document.createElement('div');
  wrapper.className = 'bv-node';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bv-node-btn';
  btn.setAttribute('data-testid', `tree-node-${node.id}`);

  const stats = computeCompletion(node);
  const label = document.createElement('span');
  label.textContent = `${node.id}: ${node.title}`;

  const meta = document.createElement('span');
  meta.className = 'bv-meta';
  meta.textContent = `P${node.priority ?? 2} | ${node.status} (${stats.closed}/${stats.total})`;

  btn.append(label, meta);
  btn.addEventListener('click', () => selectIssue(node));
  wrapper.appendChild(btn);

  for (const child of node.children || []) {
    wrapper.appendChild(renderNode(child));
  }
  return wrapper;
}

function selectIssue(issue) {
  selectedIssue = issue;
  const body = document.getElementById('inspector-body');
  const quoteBtn = document.getElementById('quote-btn');
  const quotePreview = document.getElementById('quote-preview');

  quoteBtn.disabled = false;
  quotePreview.textContent = '';

  const commentsHtml = (issue.comments || [])
    .map((c) => `<li><strong>${c.author}:</strong> ${c.text}</li>`)
    .join('');

  body.innerHTML = `
    <h3>${issue.id} — ${issue.title}</h3>
    <p><strong>Status:</strong> ${issue.status} | <strong>Priority:</strong> P${issue.priority ?? 2}</p>
    <p>${issue.description || 'No description.'}</p>
    <p><strong>Acceptance:</strong> ${issue.acceptance || 'None'}</p>
    <p><strong>Notes:</strong> ${issue.notes || 'None'}</p>
    <div><strong>Comments:</strong><ul>${commentsHtml || '<li>None</li>'}</ul></div>
  `;
}

async function loadAndRender() {
  const res = await fetch('/api/snapshot');
  currentSnapshot = await res.json();

  const badge = document.getElementById('bv-workspace-badge') || document.querySelector('[data-testid="bv-workspace-badge"]');
  badge.textContent = `${currentSnapshot.workspace} (${currentSnapshot.testEnv})`;

  const treeContainer = document.getElementById('epic-tree');
  treeContainer.innerHTML = '';
  const { roots } = buildEpicTree(currentSnapshot.issues || []);
  for (const root of roots) {
    treeContainer.appendChild(renderNode(root));
  }
}

document.getElementById('refresh-btn').addEventListener('click', loadAndRender);
document.getElementById('quote-btn').addEventListener('click', () => {
  if (!selectedIssue) return;
  document.getElementById('quote-preview').textContent = formatQuotePayload(selectedIssue);
});

loadAndRender();
