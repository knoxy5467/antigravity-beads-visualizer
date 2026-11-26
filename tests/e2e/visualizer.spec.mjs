import { expect, test } from '@playwright/test';

test('renders nested synthetic epics, opens inspector, and captures clean media', async ({ page }) => {
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

  await leafNode.click();
  const inspector = page.getByTestId('bv-inspector');
  await expect(inspector).toContainText('bv-task-gate-check');
  await expect(inspector).toContainText('Blocked until inspector panel renders six-key notes.');

  await page.getByTestId('bv-quote-btn').click();
  await expect(page.getByTestId('bv-quote-preview')).toContainText('bv-task-gate-check');

  await page.screenshot({ path: 'test-results/pr-media/synthetic-overview.png', fullPage: true });
});
