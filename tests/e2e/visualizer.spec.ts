import { expect, test } from '@playwright/test';

test.describe('Beads Visualizer 4-Tab Prototype', () => {
  test('renders Epic Tree, filters, expands/collapses, and inspects six-key notes', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('bv-title')).toContainText('Beads Visualizer');
    await expect(page.getByTestId('bv-env-banner')).toContainText('Synthetic Test Environment');
    await expect(page.getByTestId('bv-workspace-badge')).toContainText('/synthetic/workspace/beads-demo');

    const metaNode = page.getByTestId('tree-node-bv-meta-demo');
    const subNode = page.getByTestId('tree-node-bv-sub-tree');
    const leafNode = page.getByTestId('tree-node-bv-task-gate-check');
    await expect(metaNode).toBeVisible();
    await expect(metaNode).toContainText('L0');
    await expect(subNode).toBeVisible();
    await expect(subNode).toContainText('L1');
    await expect(leafNode).toBeVisible();
    await expect(leafNode).toContainText('L2');

    await page.getByTestId('tree-toggle-bv-sub-tree').click();
    await expect(page.getByTestId('tree-node-bv-task-tree-ui')).toBeHidden();
    await page.getByTestId('tree-toggle-bv-sub-tree').click();
    await expect(page.getByTestId('tree-node-bv-task-tree-ui')).toBeVisible();

    await page.getByTestId('bv-search-input').fill('inspector');
    await expect(page.getByTestId('tree-node-bv-task-inspector')).toBeVisible();
    await expect(page.getByTestId('tree-node-bv-task-ready-polish')).toBeHidden();
    await page.getByTestId('bv-search-input').fill('');

    await leafNode.click();
    const inspector = page.getByTestId('bv-inspector');
    await expect(inspector).toContainText('bv-task-gate-check');
    await expect(inspector).toContainText('Blocked until inspector panel renders six-key notes.');
    await expect(page.getByTestId('inspector-notes-grid')).toContainText('Waiting on bv-task-inspector.');
    await expect(page.getByTestId('inspector-spec-link')).toContainText('docs/specs/sample-view.md');

    await page.getByTestId('inspector-dep-link-bv-task-inspector').click();
    await expect(inspector).toContainText('bv-task-inspector');

    await page.getByTestId('bv-quote-btn').click();
    await expect(page.getByTestId('bv-quote-preview')).toContainText('bv-task-inspector');

    await page.getByTestId('bv-message-agent-btn').click();
    await expect(page.getByTestId('bv-action-status')).toContainText('Prepared message');

    await page.getByTestId('bv-new-conv-btn').click();
    await expect(page.getByTestId('bv-action-status')).toContainText('new conversation');

    await page.screenshot({ path: 'test-results/pr-media/synthetic-tree.png', fullPage: true });
  });

  test('renders Dependency DAG with edge filters, zoom controls, and node highlight', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-dag').click();

    const dagSvg = page.getByTestId('bv-dag-svg');
    await expect(dagSvg).toBeVisible();
    await expect(page.getByTestId('dag-node-bv-task-gate-check')).toBeVisible();
    await expect(page.getByTestId('dag-edge-blocks')).toHaveCount(1);

    await page.getByTestId('dag-filter-blocks').uncheck();
    await expect(page.getByTestId('dag-edge-blocks')).toHaveCount(0);
    await page.getByTestId('dag-filter-blocks').check();
    await expect(page.getByTestId('dag-edge-blocks')).toHaveCount(1);

    await page.getByTestId('dag-zoom-in').click();
    await expect(page.getByTestId('dag-zoom-label')).toContainText('115%');
    await page.getByTestId('dag-zoom-reset').click();
    await expect(page.getByTestId('dag-zoom-label')).toContainText('100%');

    await page.getByTestId('dag-node-bv-task-gate-check').click();
    await expect(page.getByTestId('bv-inspector')).toContainText('bv-task-gate-check');
    await expect(page.getByTestId('dag-node-bv-task-inspector')).toHaveClass(/is-neighbor/);

    await page.screenshot({ path: 'test-results/pr-media/synthetic-dag.png', fullPage: true });
  });

  test('renders Workflow Board with 4 lanes and group-by selector', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-board').click();

    await expect(page.getByTestId('lane-ready')).toContainText('bv-task-ready-polish');
    await expect(page.getByTestId('lane-in_progress')).toContainText('bv-task-inspector');
    await expect(page.getByTestId('lane-blocked')).toContainText('bv-task-gate-check');
    await expect(page.getByTestId('lane-closed')).toContainText('bv-task-tree-ui');

    await page.getByTestId('board-group-select').selectOption('assignee');
    await expect(page.getByTestId('lane-ready')).toContainText('agent-gamma');

    await page.getByTestId('board-group-select').selectOption('epic');
    await expect(page.getByTestId('lane-blocked')).toContainText('bv-sub-gates');

    await page.screenshot({ path: 'test-results/pr-media/synthetic-board.png', fullPage: true });
  });

  test('renders Gates & Approvals tab with blocker chips and gate actions', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-gates').click();

    const gateCard = page.getByTestId('gate-card-bv-task-gate-check');
    await expect(gateCard).toBeVisible();
    await expect(gateCard).toContainText('bv-task-inspector');
    await expect(page.getByTestId('gate-card-bv-gate-resolved-demo')).toContainText('closed');

    await page.getByTestId('gate-quote-bv-task-gate-check').click();
    await expect(page.getByTestId('bv-quote-preview')).toContainText('bv-task-gate-check');

    await page.getByTestId('gate-decision-bv-task-gate-check').click();
    await expect(page.getByTestId('bv-action-status')).toContainText('bv-task-gate-check');

    await page.getByTestId('auto-poll-toggle').uncheck();
    await page.getByTestId('refresh-btn').click();
    await expect(page.getByTestId('bv-workspace-badge')).toContainText('/synthetic/workspace/beads-demo');

    await page.screenshot({ path: 'test-results/pr-media/synthetic-gates.png', fullPage: true });
  });

  test('displays actionable snapshot errors and clears them after a successful refresh', async ({ page }) => {
    let failOnce = true;
    await page.route('**/api/snapshot*', async (route) => {
      if (failOnce) {
        failOnce = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Dolt server is not reachable at 127.0.0.1:3307. Start it with "bd dolt start" and click Refresh.',
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/');

    await expect(page.getByTestId('bv-action-status')).toContainText('Dolt server is not reachable at 127.0.0.1:3307');
    await expect(page.getByTestId('bv-load-error')).toContainText('Dolt server is not reachable at 127.0.0.1:3307');

    await page.getByTestId('refresh-btn').click();
    await expect(page.getByTestId('tree-node-bv-meta-demo')).toBeVisible();
    await expect(page.getByTestId('bv-action-status')).toHaveText('');
  });
});
