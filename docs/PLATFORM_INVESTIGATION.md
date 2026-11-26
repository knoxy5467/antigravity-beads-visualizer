<!-- @scry.entry
id: docs.platform-investigation~fb2f562a
kind: research
summary: >-
  Investigation of Antigravity sidecar limits, MCP App bridges, standalone mode, Beads schemas, and UI testing.
  Also: sidecar, mcp-app, standalone, beads-schemas, playwright, ui-architecture
status: active
weight: 0.9
tags: ["topic:architecture", "architecture", "scope:docs", "docs", "sidecar", "mcp-app", "beads"]
rationale: >-
  Records verified platform boundaries before building the full visualizer UI and Antigravity plugin bundle.
applies: designing plugin host bridges, building standalone mode, planning UI components
seeded_questions:
  - "What are the limits of an Antigravity sidecar compared with an MCP App?"
  - "How does standalone mode isolate synthetic Playwright tests from local Dolt data?"
@scry.entry.end -->

# Platform Investigation: Sidecar Limits, Standalone Mode, Beads Features, and UI Architecture

This document records verified findings for the Antigravity Beads Visualizer.

## 1. Antigravity Sidecar Limits vs MCP App Bridges

I inspected the built-in Swarm plugin (`swarm/sidecars/swarm_board/`), the `plugin` skill, and the `mcp-app-development` skill.

### Sidecar UI (`sidecar_sdk`)

- **Surface:** A sidecar opens only in the conversation side pane (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`).
- **Host UI APIs:** The browser page can call `window.sidecar.ui.toggleAuxPane` to open a workspace file and `window.sidecar.ui.toggleConversation` to jump to another conversation.
- **Limits:** A sidecar cannot attach quote pills to the user prompt, cannot send messages to an agent, and cannot expose tools to the agent.
- **Assets:** A sidecar serves multi-file static assets from a local Node.js HTTP server (`SidecarApp`).

### MCP App Plugin (`ui://` Resource)

- **Surfaces:** An MCP App opens in the side pane (`aux_pane`), in the left sidebar (`global`), and inline in chat.
- **Model Context Overhead:** Data tools with `visibility: ["app"]` stay hidden from the model and add zero tokens to the context window.
- **Interactive Bridges:**
  - `app.updateModelContext()` attaches a selected epic, task, or comment as a quote pill on the user prompt.
  - `app.sendMessage()` sends a gate action or prompt to the active conversation, or starts a background conversation with `target: "new"`.
  - `com.google.antigravity/toggle-aux-pane` opens a linked spec or design file in its own side pane tab.
- **Packaging Constraint:** The UI must build into a single HTML file under 10 MiB.

## 2. Standalone Mode and Dolt Connectivity

- **Server (`src/standalone/server.mjs`):** Serves static UI files and `/api/snapshot` over `127.0.0.1`.
- **Synthetic Test Mode:** When `BEADS_FIXTURE_PATH` is set, the server reads a synthetic JSON fixture without calling `bd` or touching local Dolt data.
- **Live Mode:** When `BEADS_FIXTURE_PATH` is unset, the server runs read-only `bd list --json` against the workspace `.beads/` database (Dolt server mode on port `3307` or embedded Dolt).

## 3. Beads v1.3.4 Feature Map

- **Hierarchy:** Meta-epics, sub-epics, and tasks link through `parent-child` dependencies.
- **Graph Edges:** `blocks`, `parent-child`, `discovered-from`, and `relates-to` appear in `dependencies`.
- **Gates and Notes:** Gate issues (`issue_type: "gate"`), six-key `notes`, `acceptance`, `design`, and `comments` support rich read-only inspection.
- **Workflows:** Formulas under `.beads/formulas/` coordinate `session-start`, `bead-worker`, `code-review`, `feature-delivery`, `pre-push-verify`, and `merge-release`.

## 4. UI Authoring and Maintenance Strategy

- **Safe DOM:** Render all text with `textContent` and `document.createElement` to block HTML injection.
- **Modular Core:** Keep pure tree, depth, completion, and quote logic in `src/core/graph.mjs` for fast Node unit testing.
- **Visual Verification:** Run Playwright against `BEADS_TEST_ENV=synthetic` to capture PII-free screenshots and `.webm` videos, then scan artifacts with `tools/pii_guard.py`.
