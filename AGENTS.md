# Agent and Contributor SDLC Guide

This guide defines the mandatory Beads, Scry, strict TDD, and UI PR evidence workflow for this repository.

## 1. Tool Responsibilities and Persistence

- **Beads (`bd`):** Tracks meta-epics, sub-epics, tasks, gates, claims, and six-key notes on `refs/dolt/data` at `origin`.
- **Scry (`scry`):** Stores code-attached architecture context, invariants, and lessons with `@scry.entry` markers in tracked files.
- **Dolt Server:** Uses pinned `dolt` on port `3307` (`dolt_mode: "server"`, `dolt_database: "bv"`).

Hard invariants:
- Never commit `.beads/dolt/`, `.beads/embeddeddolt/`, `agent/project.db`, or `agent/drivers/@local/scry/data/`.
- Never run `bd edit`. Always pass `--yes` to `bd doctor --fix` or `bd doctor --clean`.
- Never push directly to `main`. Every change enters `main` through a pull request with one `Beads-Issue: <id>`.
- Follow strict TDD: write failing tests before production code.
- Include synthetic test-environment screenshots or videos in `## UI Evidence` on every UI pull request.
- Verify zero local PII with `python -m tools.pii_guard` before every commit and pull request.

## 2. Hooks and Formulas

Antigravity loads [.agents/hooks.json](.agents/hooks.json) automatically (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`).
Git runs `.beads/hooks/` (`pre-commit`, `commit-msg`, `pre-push`) through `python -m tools.sdlc_gate`.
See [docs/PERSISTENCE_AND_SDLC_LESSONS.md](docs/PERSISTENCE_AND_SDLC_LESSONS.md) for full details.
