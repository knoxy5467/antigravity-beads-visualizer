// @scry.entry
// id: src.mcp-server~75396627
// kind: code
// summary: >-
//   Serve the Beads Visualizer MCP App resource and read-only Beads tools over stdio.
//   Also: mcp, server, mcp-app, ui-resource, visibility-app, beads-readonly
// status: active
// weight: 0.85
// tags: ["topic:mcp", "mcp", "scope:src", "src", "beads", "typescript"]
// rationale: >-
//   Provides lazy app-only data tools and Antigravity side-pane and global entrypoints without model bloat.
// applies: serving mcp app html, listing workspaces, loading beads snapshots
// seeded_questions:
//   - "How does src/mcp/server.ts configure app-only visibility and Antigravity entrypoints?"
//   - "src/mcp/server.ts createBeadsMcpServer"
// @scry.entry.end

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  formatBdCommandError,
  isValidBeadId,
  listBeadsWorkspaces,
  loadBeadsSnapshot,
  loadIssueComments,
  loadSidecarStatus,
  validateWorkspaceParam,
} from '../standalone/server.js';
import { resolvePluginDataDir, SidecarStateStore } from '../../sidecars/beads-gatekeeper/state-store.js';

export const APP_RESOURCE_URI = 'ui://beads-visualizer/app.html';

export interface McpServerOptions {
  cwd?: string;
  fixturePath?: string;
  testEnv?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the self-contained MCP App HTML path across installed plugin and repo builds.
 */
export function resolveBundledAppHtmlPath(): string {
  const envOverride = process.env.BEADS_APP_HTML;
  if (envOverride && existsSync(envOverride)) {
    return envOverride;
  }

  const candidates = [
    resolve(__dirname, '..', 'assets', 'app.html'),
    resolve(__dirname, '..', '..', 'dist', 'mcp-app', 'app.html'),
    resolve(__dirname, '..', '..', '..', 'dist', 'mcp-app', 'app.html'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

function handleToolError(toolName: string, err: unknown) {
  const message = formatBdCommandError(err);
  process.stderr.write(`[beads-visualizer] ${toolName} failed: ${message}\n`);
  return errorResult(message);
}

/**
 * Create the read-only Beads Visualizer MCP App server instance.
 */
export function createBeadsMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'beads-visualizer',
    version: '0.1.0',
  });

  server.registerResource(
    'beads-visualizer-app',
    APP_RESOURCE_URI,
    {
      title: 'Beads Visualizer UI',
      description: 'Interactive Beads epic tree, dependency DAG, workflow lanes, and gates view.',
      mimeType: 'text/html;profile=mcp-app',
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    async () => {
      const htmlPath = resolveBundledAppHtmlPath();
      const html = existsSync(htmlPath)
        ? await readFile(htmlPath, 'utf-8')
        : '<!DOCTYPE html><html><body><p>Run npm run build:plugin to generate app.html.</p></body></html>';
      return {
        contents: [
          {
            uri: APP_RESOURCE_URI,
            mimeType: 'text/html;profile=mcp-app',
            text: html,
          },
        ],
      };
    }
  );

  server.registerTool(
    'beads_open_visualizer',
    {
      title: 'Beads Visualizer',
      description: 'Open the interactive Beads Visualizer for nested epics, dependencies, lanes, and gates.',
      inputSchema: {
        workspace: z.string().optional().describe('Optional Beads workspace path.'),
        tab: z.enum(['tree', 'dag', 'board', 'gates']).optional().describe('Optional initial view tab.'),
      },
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
          visibility: ['model', 'app'],
        },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'Beads Visualizer' },
            { type: 'global', title: 'Beads Visualizer' },
          ],
        },
      },
    },
    async (args) => {
      try {
        const validatedWorkspace = await validateWorkspaceParam(args.workspace ?? null, options);
        if (validatedWorkspace === null) {
          return errorResult('Workspace is not in allowed Beads workspaces.');
        }
        const snapshot = await loadBeadsSnapshot({ ...options, cwd: validatedWorkspace });
        const summary = [
          `Workspace: ${snapshot.workspace}`,
          `Total: ${snapshot.stats.total_issues}`,
          `Ready: ${snapshot.stats.ready_issues}`,
          `In Progress: ${snapshot.stats.in_progress_issues}`,
          `Blocked: ${snapshot.stats.blocked_issues}`,
          `Closed: ${snapshot.stats.closed_issues}`,
        ].join(' | ');
        return {
          content: [{ type: 'text' as const, text: summary }],
          structuredContent: {
            workspace: snapshot.workspace,
            stats: snapshot.stats,
            testEnv: snapshot.testEnv,
            tab: args.tab ?? 'tree',
          },
        };
      } catch (err) {
        return handleToolError('beads_open_visualizer', err);
      }
    }
  );

  server.registerTool(
    'beads_list_workspaces',
    {
      title: 'List Beads Workspaces',
      description: 'Return discovered Beads workspace paths for the UI.',
      inputSchema: {},
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
          visibility: ['app'],
        },
      },
    },
    async () => {
      try {
        const workspaces = await listBeadsWorkspaces(options);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ workspaces }) }],
          structuredContent: { workspaces },
        };
      } catch (err) {
        return handleToolError('beads_list_workspaces', err);
      }
    }
  );

  server.registerTool(
    'beads_get_snapshot',
    {
      title: 'Get Beads Snapshot',
      description: 'Return a read-only Beads snapshot for the visualizer UI.',
      inputSchema: {
        workspace: z.string().optional().describe('Optional Beads workspace path.'),
        etag: z.string().optional().describe('Optional client snapshot ETag.'),
      },
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
          visibility: ['app'],
        },
      },
    },
    async (args) => {
      try {
        const validatedWorkspace = await validateWorkspaceParam(args.workspace ?? null, options);
        if (validatedWorkspace === null) {
          return errorResult('Workspace is not in allowed Beads workspaces.');
        }
        const snapshot = await loadBeadsSnapshot({ ...options, cwd: validatedWorkspace });
        if (args.etag && args.etag === snapshot.etag) {
          const unchanged = { unchanged: true, etag: snapshot.etag };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(unchanged) }],
            structuredContent: unchanged,
          };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(snapshot) }],
          structuredContent: snapshot as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return handleToolError('beads_get_snapshot', err);
      }
    }
  );

  server.registerTool(
    'beads_get_issue_comments',
    {
      title: 'Get Bead Issue Comments',
      description: 'Return read-only comments for a single Bead issue ID.',
      inputSchema: {
        id: z.string().describe('Bead issue identifier.'),
        workspace: z.string().optional().describe('Optional Beads workspace path.'),
      },
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
          visibility: ['app'],
        },
      },
    },
    async (args) => {
      try {
        if (!isValidBeadId(args.id)) {
          return errorResult('Invalid or missing id parameter.');
        }
        const validatedWorkspace = await validateWorkspaceParam(args.workspace ?? null, options);
        if (validatedWorkspace === null) {
          return errorResult('Workspace is not in allowed Beads workspaces.');
        }
        const comments = await loadIssueComments(args.id, { ...options, cwd: validatedWorkspace });
        const payload = { id: args.id, comments };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      } catch (err) {
        return handleToolError('beads_get_issue_comments', err);
      }
    }
  );

  server.registerTool(
    'beads_gate_monitor_status',
    {
      title: 'Get Sidecar Gate Monitor Status',
      description: 'Return Dolt server, gatekeeper, and managed agent state from the sidecar.',
      inputSchema: {},
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
          visibility: ['app'],
        },
      },
    },
    async () => {
      try {
        const status = await loadSidecarStatus({ fixturePath: options.fixturePath });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(status) }],
          structuredContent: status as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return handleToolError('beads_gate_monitor_status', err);
      }
    }
  );

  server.registerTool(
    'beads_resolve_gate',
    {
      title: 'Queue Gate Resolution',
      description: 'Queue a human gate resolution command for the Beads Gatekeeper sidecar.',
      inputSchema: {
        gateId: z.string().describe('Gate issue identifier.'),
        reason: z.string().min(1).describe('Resolution reason.'),
        workspace: z.string().optional().describe('Optional Beads workspace path.'),
      },
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
          visibility: ['app'],
        },
      },
    },
    async (args) => {
      try {
        if (!isValidBeadId(args.gateId)) {
          return errorResult('Invalid or missing gateId parameter.');
        }
        const reason = args.reason.trim();
        if (!reason) {
          return errorResult('Reason cannot be empty.');
        }
        const validatedWorkspace = await validateWorkspaceParam(args.workspace ?? null, options);
        if (validatedWorkspace === null) {
          return errorResult('Workspace is not in allowed Beads workspaces.');
        }
        const fixturePath = options.fixturePath ?? process.env.BEADS_FIXTURE_PATH;
        if (!fixturePath) {
          const targetWorkspace = validatedWorkspace ?? options.cwd ?? process.cwd();
          await new SidecarStateStore(resolvePluginDataDir()).appendCommand({
            type: 'resolve_gate',
            workspacePath: targetWorkspace,
            gateId: args.gateId,
            reason,
            requestedAt: new Date().toISOString(),
          });
        }
        const payload = {
          ok: true,
          queued: true,
          gateId: args.gateId,
          workspace: validatedWorkspace ?? null,
          synthetic: Boolean(fixturePath),
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      } catch (err) {
        return handleToolError('beads_resolve_gate', err);
      }
    }
  );

  server.registerTool(
    'beads_spawn_agent',
    {
      title: 'Queue Agent Worker Spawn',
      description: 'Queue a worker spawn command for desktop or agy runtime.',
      inputSchema: {
        beadId: z.string().describe('Bead issue identifier.'),
        runtime: z.enum(['desktop', 'agy']).describe('Target worker runtime.'),
        prompt: z.string().min(1).describe('Initial task prompt for the worker.'),
        workspace: z.string().optional().describe('Optional Beads workspace path.'),
      },
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
          visibility: ['app'],
        },
      },
    },
    async (args) => {
      try {
        if (!isValidBeadId(args.beadId)) {
          return errorResult('Invalid or missing beadId parameter.');
        }
        const prompt = args.prompt.trim();
        if (!prompt) {
          return errorResult('Prompt cannot be empty.');
        }
        const validatedWorkspace = await validateWorkspaceParam(args.workspace ?? null, options);
        if (validatedWorkspace === null) {
          return errorResult('Workspace is not in allowed Beads workspaces.');
        }
        const fixturePath = options.fixturePath ?? process.env.BEADS_FIXTURE_PATH;
        if (!fixturePath) {
          const targetWorkspace = validatedWorkspace ?? options.cwd ?? process.cwd();
          await new SidecarStateStore(resolvePluginDataDir()).appendCommand({
            type: 'spawn_agent',
            workspacePath: targetWorkspace,
            beadId: args.beadId,
            runtime: args.runtime,
            prompt,
            requestedAt: new Date().toISOString(),
          });
        }
        const payload = {
          ok: true,
          queued: true,
          beadId: args.beadId,
          runtime: args.runtime,
          workspace: validatedWorkspace ?? null,
          synthetic: Boolean(fixturePath),
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      } catch (err) {
        return handleToolError('beads_spawn_agent', err);
      }
    }
  );

  return server;
}

const isMainModule =
  (Boolean(process.argv[1]) &&
    resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) ||
  process.env.BEADS_MCP_STDIO === '1';

if (isMainModule) {
  const server = createBeadsMcpServer();
  const transport = new StdioServerTransport();
  void server.connect(transport);
}

export const DEFAULT_PLUGIN_META_EXAMPLE = join('assets', 'app.html');
