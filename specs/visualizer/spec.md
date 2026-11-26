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

## 1. Read-Only Invariant

The Beads Visualizer must run strictly read-only against `.beads/` databases.
No server route or MCP tool can mutate, create, claim, or close Beads issues directly.
User-triggered gate decisions and agent actions route through Antigravity chat (`sendMessage` or `updateModelContext`).

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
- Model-visible entrypoint tool: `open_beads_visualizer` with `aux_pane` and `global` entrypoints (`title: "Beads Visualizer"`).
- App-only tools (`visibility: ["app"]`): `beads_snapshot`, `beads_issue_detail`, `beads_list_workspaces`.
