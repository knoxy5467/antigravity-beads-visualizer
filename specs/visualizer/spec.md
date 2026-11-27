<!-- @scry.entry
id: specs.visualizer-spec~946a730a
kind: spec
summary: >-
  Living Specification for the read-only Beads Visualizer data contracts, 4 UI views, and host bridges.
  Also: spec, living-spec, mcp-app, standalone, epic-tree, dag, board, gates, inspector
status: active
weight: 1.0
tags: ["topic:spec", "spec", "scope:specs", "specs", "beads", "visualizer"]
rationale: >-
  Defines acceptance scenarios, TypeScript interfaces, and read-only contracts before MVP coding.
applies: implementing data adapters, building UI views, packaging MCP App plugin
seeded_questions:
  - "What are the four UI tabs and acceptance criteria for the Beads Visualizer?"
  - "specs/visualizer/spec.md"
@scry.entry.end -->

# Beads Visualizer Living Specification

## 1. Read-Only View Boundary and Opt-In Sidecar Automation

The Beads Visualizer UI and standalone HTTP server must run strictly read-only against `.beads/` databases.
No UI render path or read-only snapshot route can mutate, create, claim, or close Beads issues directly.
User-triggered gate decisions and agent actions route through Antigravity chat (`sendMessage` or `updateModelContext`) or through app-only MCP controls (`visibility: ["app"]`) backed by the `beads-gatekeeper` sidecar.
The `beads-gatekeeper` sidecar can start Dolt, run `bd gate` maintenance, and dispatch hybrid agents only for explicit opt-in workspaces configured by the user (see ADR-0002).

## 2. Data Contracts (TypeScript)

- `BeadDependency`: `issue_id`, `depends_on_id`, `type`, `created_at`, `created_by`.
- `BeadIssue`: `id`, `title`, `issue_type`, `status`, `priority`, `assignee`, `description`, `acceptance_criteria`, `design`, `notes`, `dependencies`, `comments`, `blocked_by`.
- `BeadBlockedEntry`: `id`, `title`, `status`, `priority`, `issue_type`, `blocked_by_count`, `blocked_by`.
- `BeadStatsSummary`: `total_issues`, `open_issues`, `in_progress_issues`, `blocked_issues`, `closed_issues`, `ready_issues`.
- `BeadSnapshot`: `testEnv`, `workspace`, `issues`, `blocked`, `stats`, `etag`.
- Live mode runs `bd list --all --include-gates --limit 0 --json`, `bd blocked --json`, `bd stats --json`, and `bd comments <id> --json`.
- Synthetic test mode (`BEADS_FIXTURE_PATH`) reads a static JSON fixture with zero `bd` calls and zero local PII.

## 3. UI Views and Acceptance Scenarios

### Scenario A: Nested Epic Tree
Given a snapshot with nested `parent-child` epics and tasks.
When the Epic Tree tab renders.
Then each node shows its depth badge, priority, status, completion bar, and toggle.

### Scenario B: Dependency DAG
Given issues with `blocks`, `parent-child`, `discovered-from`, and `relates-to` edges.
When the user opens the Dependency DAG tab.
Then the SVG graph shows directed edges, filter controls, zoom controls, and neighbor highlights.

### Scenario C: Workflow Board
Given open, in-progress, blocked, and closed issues.
When the user opens the Workflow Board tab.
Then cards appear in `Ready`, `In Progress`, `Blocked`, and `Closed` lanes with grouping controls.

### Scenario D: Gates, Approvals, and Issue Inspector
Given a selected issue or gate.
When the user clicks a node or gate card.
Then the Issue Inspector shows six-key notes, acceptance criteria, dependencies, comments, Quote Pill, and Message triggers.

## 4. MCP App Entrypoints and Hidden Data Tools

- Resource: `ui://beads-visualizer/app.html` (`text/html;profile=mcp-app`).
- Model-visible entrypoint tool: `beads_open_visualizer` with `aux_pane` and `global` entrypoints (`title: "Beads Visualizer"`).
- App-only read tools (`visibility: ["app"]`): `beads_get_snapshot`, `beads_get_issue_comments`, `beads_list_workspaces`.
- App-only sidecar control tools (`visibility: ["app"]`): `beads_gate_monitor_status`, `beads_resolve_gate`, `beads_spawn_agent`.

## 5. Sidecar Gatekeeper, Dolt Supervisor, and Hybrid Agent Contracts

### Data Contracts (TypeScript)

```ts
export interface OptInWorkspaceConfig {
  workspacePath: string;
  autoStartDolt: boolean;
  autoCheckGates: boolean;
  pollIntervalMs: number;
  maxConcurrentWorkers: number;
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
}

export interface ManagedAgentRecord {
  id: string;
  runtime: 'desktop' | 'agy';
  beadId: string;
  workspacePath: string;
  status: 'running' | 'idle' | 'stalled' | 'quota_exhausted' | 'failed' | 'stopped';
  pid?: number;
  conversationId?: string;
}
```

### Scenario E: Dolt Supervisor and Port Conflict Guard
Given an opt-in workspace with `dolt_mode: "server"` and `dolt_server_port: 3307`.
When port `3307` is free and `autoStartDolt` is `true`.
Then the sidecar starts `dolt sql-server` for that workspace and reports `status: "running"`.
When another repository already owns port `3307`.
Then the sidecar leaves the foreign process untouched and reports `status: "port_conflict"`.
When `autoStartDolt` is `false` or the workspace is not in the opt-in list.
Then the sidecar does not start a Dolt process for that repository.

### Scenario F: Deterministic Gate Evaluation and Unblocked Handoff
Given an opt-in workspace with a healthy database and open gates.
When the sidecar runs `bd gate discover --json`, `bd gate check --escalate --json`, and `bd mol ready --gated --json`.
Then the sidecar records resolved and escalated gates in `${PLUGIN_DATA}` and notifies registered waiter conversations.

### Scenario G: Hybrid Agent Dispatch and Stall Detection
Given a ready Bead or escalated gate and an operator dispatch request.
When active workers are below `maxConcurrentWorkers` and the sidecar starts a Desktop conversation (`ConversationService`) or a headless `agy` worker.
Then code tracks `runState`, `transcript.jsonl`, and process exit status and surfaces `stalled` or `quota_exhausted` states in the UI without extra LLM polling turns.
When active workers equal `maxConcurrentWorkers`.
Then the sidecar queues or rejects the dispatch until an active worker finishes.
