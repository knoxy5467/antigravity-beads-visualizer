<!-- @scry.entry
id: docs.a2a-approval-protocol~aa1a2452
kind: design
summary: >-
  Agent-to-agent approval verdict schema, blocker wiring, and UI gate messaging protocol.
  Also: a2a, agent-to-agent, approval, verdict, gate, quote-pill, sendMessage
status: active
weight: 0.9
tags: ["topic:workflow", "workflow", "scope:docs", "docs", "gates", "approvals"]
rationale: >-
  Standardizes how reviewer agents, worker agents, and UI gate controls coordinate approvals without race defects.
applies: designing gate views, sending UI gate messages, wiring review blockers
seeded_questions:
  - "How do agent-to-agent approvals and UI gate triggers work?"
  - "docs/A2A_APPROVAL_PROTOCOL.md"
@scry.entry.end -->

# Agent-to-Agent Approval Protocol

## 1. Reviewer Verdict Schema

Every read-only `code-reviewer` or design-critic subagent returns a structured JSON verdict:
- `verdict`: `"PASS"` or `"FAIL"`.
- `findings`: list of `{ severity: "blocking" | "major", file, line, snippet, failure_mode }`.
- Zero `blocking` or `major` findings must remain before opening or merging a pull request.

## 2. Blocker Wiring and Gate Resolution

- On `"FAIL"`, the coordinator files a `P0` or `P1` blocker bead with `bd dep add <target-bead> <blocker-bead> --type blocks`.
- On `"PASS"`, the coordinator records six-key notes on the active bead and advances the pull request gate.

## 3. UI-to-Agent Bridges

The Visualizer UI supports three read-only bridge actions through `src/ui/host-bridge.ts`:
1. **Quote Pill (`updateModelContext`):** Attaches `[Bead <id>] (<priority> | <status>) <title>` plus selected notes or comments to the user prompt.
2. **Send Gate Message (`sendMessage`):** Posts an explicit approval or blocker-triage instruction into the active conversation.
3. **Spawn Agent Conversation (`sendMessage` with `target: "new"`):** Launches a new background agent conversation in the current project scoped to the selected Bead or gate.
