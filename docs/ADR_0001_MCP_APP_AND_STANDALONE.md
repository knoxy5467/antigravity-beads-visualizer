<!-- @scry.entry
id: docs.adr-0001-mcp-app-standalone~7f94e7ad
kind: design
summary: >-
  Architecture Decision Record selecting MCP App plugin with shared TypeScript UI and standalone server.
  Also: adr, mcp-app, sidecar, standalone, esbuild, single-file
status: active
weight: 0.9
tags: ["topic:architecture", "architecture", "scope:docs", "docs", "adr", "mcp-app"]
rationale: >-
  Records why MCP App plus standalone TypeScript server beats a pure sidecar for quote pills and gates.
applies: packaging Antigravity plugin, designing host bridge, building standalone mode
seeded_questions:
  - "Why did we choose MCP App over a sidecar for the Beads Visualizer?"
  - "ADR-0001 MCP App vs Sidecar"
@scry.entry.end -->

# ADR-0001: MCP App Plugin with Shared TypeScript UI and Standalone Server

## Context

The built-in Swarm plugin uses a Node.js `sidecar_sdk` server (`aux_pane` only).
Sidecar UIs cannot attach prompt quote pills (`updateModelContext`) or send messages to conversations (`sendMessage`).

## Decision

1. Package the plugin as an **MCP App** (`ui://beads-visualizer/app.html`) with `aux_pane` and `global` entrypoints.
2. Mark read-only data tools (`beads_snapshot`, `beads_issue_detail`, `beads_list_workspaces`) with `visibility: ["app"]`.
3. Share one strict TypeScript UI codebase (`src/core/`, `src/ui/`) between the MCP App bundle and `src/standalone/server.ts`.

## Consequences

- Users can quote any epic, task, gate, or comment as a chat context pill and trigger agent messages.
- All UI features remain 100% testable in headless Chromium with `playwright.config.ts` without restarting Antigravity.
- **Update (ADR-0002):** `beads-visualizer` retains the MCP App for UI rendering and quote pills, and pairs it with a TypeScript Sidecar daemon (`sidecars/beads-gatekeeper/`) for Dolt supervision, gate maintenance, and hybrid agent dispatch.
