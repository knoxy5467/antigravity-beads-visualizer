# Contributing Guide

Follow [START_HERE.md](START_HERE.md) to set up `.venv`, `node_modules`, Beads (`bd`), and Scry (`scry`).

## Pull Request Checklist

1. Claim one Bead (`bd update <id> --claim --json`) and work on branch `bead/<id>`.
2. Write failing Python hook tests (`tests/python/`), TypeScript unit tests (`tests/unit/`), or Playwright tests (`tests/e2e/`) first.
3. Keep all project source code and project tests in strict TypeScript (`.ts`). Python is allowed only for hooks.
4. Add minted `@scry.entry` markers (`scry_mint`) to new files under `src/`, `tools/`, `docs/`, or `sidecars/`.
5. Run `npm run typecheck`, `python -m tools.sdlc_gate green-bar`, and `npm run test:e2e`.
5. Run `python -m tools.pii_guard tests/ docs/ test-results/` and confirm `"ok": true`.
6. Complete `code-reviewer` audit and resolve all blocking or major findings.
7. Open one pull request per Bead with `Beads-Issue: <id>` and `## UI Evidence` for UI changes.
8. Close the Bead only after the pull request merges into `main`, then run `bd dolt push`.
