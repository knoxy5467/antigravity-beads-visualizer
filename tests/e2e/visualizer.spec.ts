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

  test('clears stale views and inspector across tabs when switching to a failing workspace and ignores late responses', async ({
    page,
  }) => {
    const wsOk = '/synthetic/workspace/beads-demo';
    const wsBroken = '/synthetic/workspace/schema-old';
    const wsSlow = '/synthetic/workspace/slow-demo';
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    await page.route('**/api/workspaces', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ workspaces: [wsOk, wsBroken, wsSlow] }),
      });
    });

    await page.route('**/api/snapshot*', async (route) => {
      const url = new URL(route.request().url());
      const ws = url.searchParams.get('workspace');
      if (ws === wsBroken) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Beads database schema is out of date for this workspace.',
          }),
        });
        return;
      }
      if (ws === wsSlow) {
        await slowGate;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            testEnv: 'synthetic',
            workspace: wsSlow,
            issues: [{ id: 'bv-stale-late', title: 'Late Stale Issue', status: 'open', priority: 1 }],
            blocked: [],
            stats: {
              total_issues: 1,
              open_issues: 1,
              in_progress_issues: 0,
              blocked_issues: 0,
              closed_issues: 0,
              ready_issues: 1,
            },
            etag: 'slow-etag',
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/');
    await page.getByTestId('auto-poll-toggle').uncheck();
    await expect(page.getByTestId('tree-node-bv-meta-demo')).toBeVisible();

    // Populate inspector and DAG panel from the working workspace.
    await page.getByTestId('tree-node-bv-task-gate-check').click();
    await expect(page.getByTestId('bv-inspector')).toContainText('bv-task-gate-check');
    await expect(page.getByTestId('bv-quote-btn')).toBeEnabled();
    await page.getByTestId('tab-dag').click();
    await expect(page.getByTestId('bv-dag-svg')).toBeVisible();
    await page.getByTestId('tab-tree').click();

    // Switch to failing workspace: inspector must reset and every tab must show the error, never stale data.
    await page.getByTestId('bv-workspace-select').selectOption(wsBroken);
    await expect(page.getByTestId('bv-load-error')).toContainText('schema is out of date');
    await expect(page.getByTestId('bv-inspector')).toContainText('Select an epic or task to inspect details.');
    await expect(page.getByTestId('bv-quote-btn')).toBeDisabled();

    await page.getByTestId('tab-dag').click();
    await expect(page.getByTestId('bv-dag-svg')).toHaveCount(0);
    await expect(page.locator('#view-dag [data-testid="bv-load-error"]')).toContainText('schema is out of date');

    // Switch to slow workspace, then immediately back to working workspace; late slow response must not clobber.
    await page.getByTestId('tab-tree').click();
    await page.getByTestId('bv-workspace-select').selectOption(wsSlow);
    await page.getByTestId('bv-workspace-select').selectOption(wsOk);
    await expect(page.getByTestId('tree-node-bv-meta-demo')).toBeVisible();
    await expect(page.getByTestId('bv-workspace-badge')).toContainText(wsOk);

    releaseSlow();
    await page.waitForTimeout(300);
    await expect(page.getByTestId('bv-workspace-badge')).toContainText(wsOk);
    await expect(page.getByTestId('tree-node-bv-meta-demo')).toBeVisible();
  });

  test('does not overlap auto-poll snapshot requests while a slow request is in flight', async ({ page }) => {
    let inFlight = 0;
    let maxConcurrent = 0;
    let totalRequests = 0;

    await page.route('**/api/snapshot*', async (route) => {
      totalRequests += 1;
      inFlight += 1;
      if (inFlight > maxConcurrent) maxConcurrent = inFlight;
      if (totalRequests >= 2) {
        await new Promise((resolve) => setTimeout(resolve, 6500));
      }
      inFlight -= 1;
      await route.continue();
    });

    await page.goto('/');
    await expect(page.getByTestId('tree-node-bv-meta-demo')).toBeVisible();

    // Wait long enough for the first auto-poll (5s) and overlap window (6.5s).
    await page.waitForTimeout(12500);
    expect(totalRequests).toBeGreaterThanOrEqual(2);
    expect(maxConcurrent).toBe(1);
  });

  test('ignores late issue comment responses after workspace switch without page errors', async ({ page }) => {
    const wsOk = '/synthetic/workspace/beads-demo';
    const wsBroken = '/synthetic/workspace/schema-old';
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    let releaseComments!: () => void;
    const commentsGate = new Promise<void>((resolve) => {
      releaseComments = resolve;
    });

    await page.route('**/api/workspaces', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ workspaces: [wsOk, wsBroken] }),
      });
    });

    await page.route('**/api/snapshot*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('workspace') === wsBroken) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Beads database schema is out of date for this workspace.' }),
        });
        return;
      }
      await route.continue();
    });

    await page.route('**/api/issue*', async (route) => {
      await commentsGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'bv-task-gate-check', comments: [{ author: 'tester', text: 'Late comment' }] }),
      });
    });

    await page.goto('/');
    await page.getByTestId('auto-poll-toggle').uncheck();
    await expect(page.getByTestId('tree-node-bv-task-gate-check')).toBeVisible();

    await page.getByTestId('tree-node-bv-task-gate-check').click();
    await page.getByTestId('bv-workspace-select').selectOption(wsBroken);
    await expect(page.getByTestId('bv-load-error')).toContainText('schema is out of date');

    releaseComments();
    await page.waitForTimeout(300);

    expect(pageErrors).toEqual([]);
    await expect(page.getByTestId('bv-inspector')).toContainText('Select an epic or task to inspect details.');
    await expect(page.getByTestId('bv-quote-btn')).toBeDisabled();
  });

  test('clears transient snapshot poll error when the next unchanged poll succeeds', async ({ page }) => {
    let callCount = 0;
    await page.route('**/api/snapshot*', async (route) => {
      callCount += 1;
      if (callCount === 2) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Transient Dolt timeout.' }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/');
    await expect(page.getByTestId('tree-node-bv-meta-demo')).toBeVisible();

    await expect(page.getByTestId('bv-action-status')).toContainText('Transient Dolt timeout.', { timeout: 8000 });
    await expect(page.getByTestId('bv-action-status')).toHaveText('', { timeout: 8000 });
  });

  test('renders sidecar monitor, managed agents, and dispatches resolve and spawn controls', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('auto-poll-toggle').uncheck();
    await page.getByTestId('tab-gates').click();

    await expect(page.getByTestId('bv-sidecar-status')).toContainText('running');
    await expect(page.getByTestId('bv-sidecar-status')).toContainText('3307');
    await expect(page.getByTestId('bv-sidecar-agents')).toContainText('agent-syn-1');
    await expect(page.getByTestId('bv-sidecar-agents')).toContainText('agent-syn-2');

    await page.getByTestId('gate-resolve-bv-task-gate-check').click();
    await expect(page.getByTestId('bv-action-status')).toContainText('bv-task-gate-check');

    await page.getByTestId('sidecar-spawn-bead').fill('bv-task-inspector');
    await page.getByTestId('sidecar-spawn-btn').click();
    await expect(page.getByTestId('bv-action-status')).toContainText('bv-task-inspector');

    await page.screenshot({ path: 'test-results/pr-media/synthetic-sidecar-gates.png', fullPage: true });
  });
});
