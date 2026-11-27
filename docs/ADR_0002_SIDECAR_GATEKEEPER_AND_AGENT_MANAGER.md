<!-- @scry.entry
id: docs.adr-0002-sidecar-gatekeeper~7253b157
kind: design
summary: >-
  Architecture Decision Record for the TypeScript Sidecar Gatekeeper, Dolt Supervisor, and Hybrid Agent Manager.
  Also: adr-0002, sidecar, dolt-supervisor, gatekeeper, hybrid-agents, agy, sidecar_sdk
status: active
weight: 0.95
tags: ["topic:architecture", "architecture", "scope:docs", "docs", "adr", "sidecar", "beads", "dolt"]
rationale: >-
  Moves deterministic Dolt supervision, Beads gate monitoring, and agent lifecycle management from recurring LLM turns into TypeScript code.
applies: building the beads-gatekeeper sidecar, supervising Dolt servers, dispatching hybrid workers
seeded_questions:
  - "How does the sidecar supervise Dolt, monitor Beads gates, and dispatch hybrid agents?"
  - "docs/ADR_0002_SIDECAR_GATEKEEPER_AND_AGENT_MANAGER.md"
@scry.entry.end -->

# ADR-0002: TypeScript Sidecar Gatekeeper, Dolt Supervisor, and Hybrid Agent Manager

## 1. Context

The `beads-visualizer` plugin currently ships an MCP App server (`beads-visualizer_beads`) and a standalone HTTP server.
Users want deterministic work to move from recurring LLM loops into TypeScript code:
1. Start and supervise the Beads Dolt SQL server for opt-in repositories.
2. Monitor and maintain Beads gates (`gh:run`, `gh:pr`, `timer`, `bead`) in code.
3. Start, monitor, and route Antigravity agents only when code edits, review, or failure triage need LLM judgment.

Direct inspection of `sidecar_sdk`, `ConversationService`, `agentapi`, and `agy` CLI shows that an Antigravity sidecar receives host credentials automatically.
Those environment variables are `ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`, and `ANTIGRAVITY_AGENTAPI_EXE`.
An MCP stdio server does not have a documented contract for those host credentials.

## 2. Decision

### 2.1 Dual-Surface Plugin Architecture
Keep both surfaces inside `~/.gemini/config/plugins/beads-visualizer/`:
1. **MCP App (`bin/beads-visualizer-mcp.mjs`):** Serves `ui://beads-visualizer/app.html` (`aux_pane` and `global`), keeps `beads_open_visualizer` as the only model tool, and hides UI controls with `visibility: ["app"]`.
2. **TypeScript Sidecar Daemon (`sidecars/beads-gatekeeper/`):** Runs continuously with `"command": "node"` and `"restart_policy": "always"` to supervise Dolt, check Beads gates, and manage agents.

The MCP App iframe enforces `default-src 'none'`.
The UI calls `app.callServerTool()` on the MCP server.
The MCP server reads or updates `${PLUGIN_DATA}` state files or a local authenticated loopback endpoint owned by the sidecar.

### 2.2 Explicit Opt-In Workspace Registry and Dolt Supervisor
The sidecar reads an explicit opt-in workspace list from `${PLUGIN_DATA}/config.json`.
It never starts Dolt automatically for unapproved directories.
For each enabled workspace, the Dolt Supervisor does these steps:
1. Read `.beads/metadata.json` (`dolt_mode`, `dolt_server_port`, `dolt_database`).
2. Probe `127.0.0.1:<port>` over TCP.
3. Check port ownership before startup so the sidecar never kills another repository's Dolt process on a port conflict.
4. Start `dolt sql-server` with `--config <workspace>/.beads/dolt-server-config.yaml` when the port is free, and apply exponential backoff after a crash.

### 2.3 Deterministic Beads Gatekeeper Loop
When an opt-in workspace has a healthy database, the sidecar runs deterministic `bd` commands without LLM tokens:
1. `bd gate discover --json` links open `gh:run` gates to matching GitHub Actions runs.
2. `bd gate check --escalate --json` closes satisfied gates and escalates failed or canceled gates.
3. `bd mol ready --gated --json` detects newly unblocked workflow steps after a gate closes.
4. `bd reclaim --json` reverts stale-lease `in_progress` beads back to `ready`.
5. Waiter routing sends gate resolutions or escalations to the registered `conversationId` waiter.

### 2.4 Hybrid Agent Manager
The sidecar manages two complementary worker runtimes:
1. **Desktop Conversations (`sidecar_sdk` and `ConversationService`):** Starts visible interactive conversations (`CreateConversation` or `startConversation`) and sends follow-up prompts (`sendMessage`).
2. **Headless Cancellable Workers (`agy` CLI and `agy acp`):** Spawns `agy -p --input-format stream-json --output-format stream-json` with `--agent`, `--model`, `--mode`, and `--json-schema`. Node holds the OS PID for hard timeouts, concurrency limits, and process cancellation.
3. **Zero-LLM Health Monitor:** Polls `ConversationService/GetConversation` (`runState`) and tails `transcript.jsonl` to detect idle turn completion, `ERROR_MESSAGE`, `429` quota exhaustion, and stalls.

### 2.5 Security and Permissions
- Keep `agent_permissions` in `sidecar.json` scoped to explicit `workspace_uris` and exact `access_grants` prefixes (zero wildcards such as `command(*)` or `mcp(*)`).
- Keep the MCP App view layer read-only by default.
- The sidecar must have explicit opt-in workspace configuration before it runs Dolt or gate mutations.

## 3. Open Prototype Verification Items
Before enabling the sidecar globally, the implementation sub-epics will verify three host behaviors on a small prototype:
1. Auto-start behavior for a sidecar inside `~/.gemini/config/plugins/beads-visualizer/sidecars/` versus the Automations dashboard toggle.
2. Credential injection (`ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`, `ANTIGRAVITY_AGENTAPI_EXE`) when `has_web_ui` is `false`.
3. Permission inheritance on `ConversationService/CreateConversation` versus `agentapi new-conversation`.
