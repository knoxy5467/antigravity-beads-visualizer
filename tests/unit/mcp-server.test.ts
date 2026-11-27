import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

test('bundled MCP stdio binary emits only valid JSON-RPC on stdout during initialize', async () => {
  const bundlePath = resolve(process.cwd(), 'dist', 'plugin', 'bin', 'beads-visualizer-mcp.mjs');
  assert.equal(existsSync(bundlePath), true, 'Expected built MCP bundle at dist/plugin/bin/beads-visualizer-mcp.mjs');

  const child = spawn(process.execPath, [bundlePath], {
    cwd: tmpdir(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf-8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
  });

  const initMsg = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'stdio-regression', version: '1.0.0' },
    },
  });
  child.stdin.write(`${initMsg}\n`);

  const responseLine = await new Promise<string>((resolveLine, rejectLine) => {
    const timer = setTimeout(() => {
      rejectLine(new Error(`Timed out waiting for initialize response. stdout=${stdout} stderr=${stderr}`));
    }, 10000);
    const onData = () => {
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length > 0) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolveLine(lines[0] || '');
      }
    };
    child.stdout.on('data', onData);
  });

  child.stdin.end();
  child.kill();

  const nonEmptyLines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  assert.ok(nonEmptyLines.length >= 1);
  for (const line of nonEmptyLines) {
    assert.doesNotThrow(() => JSON.parse(line), `Non-JSON stdout line detected: ${line}`);
  }
  const parsed = JSON.parse(responseLine) as { result?: { serverInfo?: { name?: string } } };
  assert.equal(parsed.result?.serverInfo?.name, 'beads-visualizer');
});

test('createBeadsMcpServer catches bd failures and returns clean isError messages without Command failed', async () => {
  const emptyWs = mkdtempSync(join(tmpdir(), 'bv-mcp-empty-'));
  mkdirSync(join(emptyWs, '.beads'), { recursive: true });
  const prevWorkspaces = process.env.BEADS_WORKSPACES;
  const prevFixture = process.env.BEADS_FIXTURE_PATH;
  delete process.env.BEADS_FIXTURE_PATH;
  process.env.BEADS_WORKSPACES = emptyWs;

  const server = createBeadsMcpServer({ cwd: emptyWs });
  const client = new Client({ name: 'test-error-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const snapResult = await client.callTool({
      name: 'beads_get_snapshot',
      arguments: { workspace: emptyWs },
    });
    assert.equal(snapResult.isError, true);
    const content = snapResult.content as Array<{ type: string; text?: string }>;
    const msg = content.find((item) => item.type === 'text')?.text ?? '';
    assert.ok(msg.length > 0);
    assert.doesNotMatch(msg, /Command failed:/);

    const openResult = await client.callTool({
      name: 'beads_open_visualizer',
      arguments: { workspace: emptyWs },
    });
    assert.equal(openResult.isError, true);
    const openContent = openResult.content as Array<{ type: string; text?: string }>;
    const openMsg = openContent.find((item) => item.type === 'text')?.text ?? '';
    assert.ok(openMsg.length > 0);
    assert.doesNotMatch(openMsg, /Command failed:/);
  } finally {
    await Promise.all([client.close(), server.close()]);
    if (prevWorkspaces === undefined) delete process.env.BEADS_WORKSPACES;
    else process.env.BEADS_WORKSPACES = prevWorkspaces;
    if (prevFixture !== undefined) process.env.BEADS_FIXTURE_PATH = prevFixture;
    rmSync(emptyWs, { recursive: true, force: true });
  }
});

test('createBeadsMcpServer catches errors in beads_list_workspaces and returns isError', async () => {
  const server = createBeadsMcpServer({
    fixturePath: 'tests/fixtures/does-not-exist-synthetic.json',
  });
  const client = new Client({ name: 'test-ws-error-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const res = await client.callTool({
      name: 'beads_list_workspaces',
      arguments: {},
    });
    assert.equal(res.isError, true);
    const content = res.content as Array<{ type: string; text?: string }>;
    const msg = content.find((item) => item.type === 'text')?.text ?? '';
    assert.ok(msg.length > 0);
    assert.doesNotMatch(msg, /BD_PATH/i);
    assert.match(msg, /ENOENT|no such file/i);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
