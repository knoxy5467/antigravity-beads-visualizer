// @scry.entry
// id: sidecars.gatekeeper-types~0c45aed4
// kind: code
// summary: >-
//   Define TypeScript contracts for opt-in workspaces, Dolt health, gate monitoring, and managed agents.
//   Also: sidecar, types, dolt-supervisor, gatekeeper, agent-manager, typescript
// status: active
// weight: 0.9
// tags: ["topic:sidecar", "sidecar", "scope:sidecars", "sidecars", "types", "beads"]
// rationale: >-
//   Aligns sidecar modules, MCP control tools, and UI views around one strict TypeScript schema.
// applies: configuring opt-in workspaces, reading sidecar state, dispatching hybrid agents
// seeded_questions:
//   - "What TypeScript interfaces define the Beads Gatekeeper sidecar state and commands?"
//   - "sidecars/beads-gatekeeper/types.ts SidecarStateSnapshot"
// @scry.entry.end

export interface OptInWorkspaceConfig {
  workspacePath: string;
  autoStartDolt: boolean;
  autoCheckGates: boolean;
  pollIntervalMs: number;
  maxConcurrentWorkers: number;
}

export interface SidecarConfig {
  workspaces: OptInWorkspaceConfig[];
}

export interface DoltMetadata {
  doltMode: 'server' | 'embedded';
  doltServerPort: number;
  doltDatabase: string;
}

export interface DoltHealthState {
  workspacePath: string;
  port: number;
  database: string;
  status: 'running' | 'stopped' | 'port_conflict' | 'error';
  pid?: number;
  lastError?: string;
}

export interface GateMonitorState {
  workspacePath: string;
  lastRunAt: string;
  discoveredCount: number;
  resolvedGates: string[];
  escalatedGates: string[];
  readyMolecules: string[];
  lastError?: string;
}

export type ManagedAgentRuntime = 'desktop' | 'agy';

export type ManagedAgentStatus =
  | 'running'
  | 'idle'
  | 'stalled'
  | 'quota_exhausted'
  | 'failed'
  | 'stopped';

export interface ManagedAgentRecord {
  id: string;
  runtime: ManagedAgentRuntime;
  beadId: string;
  workspacePath: string;
  status: ManagedAgentStatus;
  pid?: number;
  conversationId?: string;
  startedAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface SidecarStateSnapshot {
  updatedAt: string;
  daemonPid?: number;
  doltStates: DoltHealthState[];
  gateStates: GateMonitorState[];
  agents: ManagedAgentRecord[];
}

export type SidecarCommand =
  | {
      type: 'resolve_gate';
      workspacePath: string;
      gateId: string;
      reason: string;
      requestedAt: string;
    }
  | {
      type: 'spawn_agent';
      workspacePath: string;
      beadId: string;
      runtime: ManagedAgentRuntime;
      prompt: string;
      requestedAt: string;
    };
