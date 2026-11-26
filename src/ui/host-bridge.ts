// @scry.entry
// id: src.ui-host-bridge~142678fa
// kind: code
// summary: >-
//   Provide the host bridge abstraction for standalone HTTP and embedded MCP App modes.
//   Also: ui, host-bridge, standalone, mcp-app, quote-pill, send-message
// status: active
// weight: 0.85
// tags: ["topic:ui", "ui", "scope:src", "src", "bridge", "typescript"]
// rationale: >-
//   Keeps all UI views independent of transport details between standalone HTTP and MCP App hosts.
// applies: fetching beads snapshots, quoting beads, sending agent messages
// seeded_questions:
//   - "How does host-bridge.ts switch between standalone HTTP and MCP App host calls?"
//   - "src/ui/host-bridge.ts createHostBridge"
// @scry.entry.end

import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import {
  formatQuotePayload,
  type BeadComment,
  type BeadIssue,
  type BeadSnapshot,
} from '../core/graph.js';

export interface SnapshotResponse extends BeadSnapshot {
  unchanged?: boolean;
}

export interface HostBridge {
  isEmbedded(): boolean;
  fetchWorkspaces(): Promise<string[]>;
  fetchSnapshot(etag?: string, workspace?: string): Promise<SnapshotResponse>;
  fetchIssueComments(id: string, workspace?: string): Promise<BeadComment[]>;
  quoteBead(issue: BeadIssue): Promise<string>;
  sendAgentMessage(text: string, target?: 'current' | 'new'): Promise<string>;
}

function isEmbeddedFrame(): boolean {
  try {
    return typeof window !== 'undefined' && window.parent !== window;
  } catch {
    return false;
  }
}

function parseToolPayload<T>(result: {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}): T {
  if (result.structuredContent !== undefined) {
    return result.structuredContent as T;
  }
  const firstText = result.content?.find((item) => item.type === 'text')?.text;
  if (firstText) {
    return JSON.parse(firstText) as T;
  }
  return {} as T;
}

function createEmbeddedMcpBridge(): HostBridge {
  let appPromise: Promise<App> | null = null;

  function getApp(): Promise<App> {
    if (!appPromise) {
      const app = new App({ name: 'Beads Visualizer', version: '0.1.0' }, {});
      app.onhostcontextchanged = (ctx) => {
        if (ctx.theme) applyDocumentTheme(ctx.theme);
        if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
      };
      appPromise = app.connect().then(() => {
        const ctx = app.getHostContext();
        if (ctx?.theme) applyDocumentTheme(ctx.theme);
        if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
        return app;
      });
    }
    return appPromise;
  }

  return {
    isEmbedded(): boolean {
      return true;
    },

    async fetchWorkspaces(): Promise<string[]> {
      const app = await getApp();
      const result = await app.callServerTool({
        name: 'beads_list_workspaces',
        arguments: {},
      });
      const data = parseToolPayload<{ workspaces?: string[] }>(result);
      return Array.isArray(data.workspaces) ? data.workspaces : [];
    },

    async fetchSnapshot(etag?: string, workspace?: string): Promise<SnapshotResponse> {
      const app = await getApp();
      const args: Record<string, unknown> = {};
      if (etag) args.etag = etag;
      if (workspace) args.workspace = workspace;
      const result = await app.callServerTool({
        name: 'beads_get_snapshot',
        arguments: args,
      });
      return parseToolPayload<SnapshotResponse>(result);
    },

    async fetchIssueComments(id: string, workspace?: string): Promise<BeadComment[]> {
      const app = await getApp();
      const args: Record<string, unknown> = { id };
      if (workspace) args.workspace = workspace;
      const result = await app.callServerTool({
        name: 'beads_get_issue_comments',
        arguments: args,
      });
      const data = parseToolPayload<{ comments?: BeadComment[] }>(result);
      return Array.isArray(data.comments) ? data.comments : [];
    },

    async quoteBead(issue: BeadIssue): Promise<string> {
      const payload = formatQuotePayload(issue);
      const app = await getApp();
      const caps = app.getHostCapabilities();
      if (caps?.updateModelContext) {
        await app.updateModelContext({
          content: [{ type: 'text', text: payload }],
        });
      }
      return payload;
    },

    async sendAgentMessage(text: string, target: 'current' | 'new' = 'current'): Promise<string> {
      const app = await getApp();
      const caps = app.getHostCapabilities();
      if (!caps?.message) {
        return 'Host surface does not support conversation messages.';
      }
      await app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text }],
        ...(target === 'new'
          ? { _meta: { 'com.google.antigravity/message': { target: 'new' } } }
          : {}),
      });
      return target === 'new'
        ? `Started new conversation with message: ${text}`
        : `Sent message to conversation: ${text}`;
    },
  };
}

/**
 * Create a standalone HTTP host bridge or embedded MCP App host bridge.
 */
export function createHostBridge(): HostBridge {
  if (isEmbeddedFrame()) {
    return createEmbeddedMcpBridge();
  }

  return {
    isEmbedded(): boolean {
      return false;
    },

    async fetchWorkspaces(): Promise<string[]> {
      const res = await fetch('/api/workspaces');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { workspaces?: string[] };
      return Array.isArray(data.workspaces) ? data.workspaces : [];
    },

    async fetchSnapshot(etag?: string, workspace?: string): Promise<SnapshotResponse> {
      const params = new URLSearchParams();
      if (etag) params.set('etag', etag);
      if (workspace) params.set('workspace', workspace);
      const query = params.toString();
      const res = await fetch(query ? `/api/snapshot?${query}` : '/api/snapshot');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return (await res.json()) as SnapshotResponse;
    },

    async fetchIssueComments(id: string, workspace?: string): Promise<BeadComment[]> {
      const params = new URLSearchParams({ id });
      if (workspace) params.set('workspace', workspace);
      const res = await fetch(`/api/issue?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { comments?: BeadComment[] };
      return Array.isArray(data.comments) ? data.comments : [];
    },

    async quoteBead(issue: BeadIssue): Promise<string> {
      const payload = formatQuotePayload(issue);
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(payload);
        } catch {
          // Ignore clipboard permission errors in headless browsers.
        }
      }
      return payload;
    },

    async sendAgentMessage(text: string, target: 'current' | 'new' = 'current'): Promise<string> {
      if (target === 'new') {
        return `Prepared new conversation message: ${text}`;
      }
      return `Prepared message for current conversation: ${text}`;
    },
  };
}
