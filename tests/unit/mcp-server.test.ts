import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { APP_RESOURCE_URI, createBeadsMcpServer } from '../../src/mcp/server.js';

test('createBeadsMcpServer exposes MCP App resource, entrypoints, and app-only tools', async () => {
  const server = createBeadsMcpServer({
    fixturePath: 'tests/fixtures/synthetic-beads.json',
    testEnv: 'synthetic',
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const resources = await client.listResources();
    const appResource = resources.resources.find((r) => r.uri === APP_RESOURCE_URI);
    assert.ok(appResource);
    assert.equal(appResource.mimeType, 'text/html;profile=mcp-app');

    const tools = await client.listTools();
    const byName = new Map(tools.tools.map((t) => [t.name, t]));

    const openTool = byName.get('beads_open_visualizer');
    assert.ok(openTool);
    const openMeta = openTool._meta as Record<string, unknown> | undefined;
    assert.deepEqual((openMeta?.ui as Record<string, unknown> | undefined)?.resourceUri, APP_RESOURCE_URI);
    const agyUi = openMeta?.['com.google.antigravity/ui'] as { entrypoints?: Array<{ type: string }> } | undefined;
    assert.deepEqual(
      agyUi?.entrypoints?.map((e) => e.type),
      ['aux_pane', 'global']
    );

    for (const appToolName of ['beads_list_workspaces', 'beads_get_snapshot', 'beads_get_issue_comments']) {
      const tool = byName.get(appToolName);
      assert.ok(tool, `Missing tool ${appToolName}`);
      const meta = tool._meta as { ui?: { visibility?: string[] } } | undefined;
      assert.deepEqual(meta?.ui?.visibility, ['app']);
    }

    const openResult = await client.callTool({ name: 'beads_open_visualizer', arguments: {} });
    assert.equal(openResult.isError, undefined);
    const openStructured = openResult.structuredContent as { workspace?: string; stats?: { total_issues?: number } };
    assert.equal(openStructured.workspace, '/synthetic/workspace/beads-demo');
    assert.equal(openStructured.stats?.total_issues, 8);

    const snapResult = await client.callTool({ name: 'beads_get_snapshot', arguments: {} });
    const snapStructured = snapResult.structuredContent as { issues?: unknown[] };
    assert.equal(snapStructured.issues?.length, 8);

    const commentsResult = await client.callTool({
      name: 'beads_get_issue_comments',
      arguments: { id: 'bv-meta-demo' },
    });
    const commentsStructured = commentsResult.structuredContent as { comments?: unknown[] };
    assert.equal(commentsStructured.comments?.length, 1);

    const invalidComments = await client.callTool({
      name: 'beads_get_issue_comments',
      arguments: { id: 'add' },
    });
    assert.equal(invalidComments.isError, true);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
