import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const BUNDLE_PATH = resolve(process.cwd(), 'dist', 'mcp-app', 'app.html');
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;

test('bundled MCP App HTML is self-contained, under 10 MiB, and renders without runtime errors', async ({
  page,
}) => {
  expect(existsSync(BUNDLE_PATH)).toBe(true);
  const stats = statSync(BUNDLE_PATH);
  expect(stats.size).toBeGreaterThan(0);
  expect(stats.size).toBeLessThan(MAX_BUNDLE_BYTES);

  const html = readFileSync(BUNDLE_PATH, 'utf-8');
  expect(html).toContain('<style>');
  expect(html).toContain('<script>');

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(0);
  await expect(page.locator('script[src]')).toHaveCount(0);
  await expect(page.getByTestId('bv-title')).toContainText('Beads Visualizer');
  await expect(page.getByTestId('tab-tree')).toBeVisible();
  await expect(page.getByTestId('tab-dag')).toBeVisible();
  await expect(page.getByTestId('tab-board')).toBeVisible();
  await expect(page.getByTestId('tab-gates')).toBeVisible();
  expect(pageErrors).toEqual([]);
});
