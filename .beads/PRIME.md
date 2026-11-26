# Antigravity Beads Visualizer SDLC Rules

1. Query Scry (`scry_sql`, `scry_grep`) first. Store lessons in `@scry.entry` markers, not `bd remember`.
2. Claim an `in_progress` bead (`bd update <id> --claim`) before you edit files.
3. Follow strict TDD: write failing tests before production code.
4. Write all project code and project tests in strict TypeScript (`.ts`). Python is for hooks only.
5. Add minted `@scry.entry` markers to new `src/`, `tools/`, `docs/`, and `sidecars/` files.
6. Never push directly to `main`. Use one `Beads-Issue: <id>` per commit and per pull request.
7. Attach synthetic test-environment screenshots or videos to UI pull requests and verify zero local PII.
