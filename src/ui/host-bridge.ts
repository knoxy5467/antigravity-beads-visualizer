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

/**
 * Create a standalone HTTP host bridge backed by the local server API.
 */
export function createHostBridge(): HostBridge {
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
