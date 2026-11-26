---
name: beads-visualizer-sdlc
description: Run the repository Beads, Scry, strict TDD, and Playwright UI PR evidence lifecycle.
---

# Beads Visualizer SDLC Workflow

Follow this workflow for all changes in the Antigravity Beads Visualizer repository.

## 1. Persistence Rules

- **Beads (`bd`):** Store tasks, meta-epics, sub-epics, gates, and notes in Dolt on `refs/dolt/data`. Never commit `.beads/dolt/`.
- **Scry (`scry`):** Store architecture context and lessons with `@scry.entry` markers in tracked files. Never commit `agent/drivers/@local/scry/data/`.

## 2. Strict TDD and Review Rules

1. Claim one active Bead with `bd update <id> --claim --json`.
2. Create branch `bead/<id>` from `main`.
3. Write failing tests first (`tests/python/`, `tests/unit/`, or `tests/e2e/`). Confirm they fail.
4. Implement minimal code to pass. Add minted `@scry.entry` markers on new `src/`, `tools/`, `docs/`, and `sidecars/` files.
5. Run `python -m tools.sdlc_gate green-bar` and `npm run test:e2e`.
6. Run `python -m tools.pii_guard tests/ test-results/ docs/` to confirm zero local PII leaks.
7. Run code review before opening a pull request.
8. Include `Beads-Issue: <id>` in every commit and pull request.
9. If UI files changed, add `## UI Evidence` with synthetic test-environment screenshots or videos.
10. Close code Beads only after the pull request merges into `main`, then run `bd dolt push`.
