<!-- @scry.entry
id: docs.persistence-sdlc-lessons~999f5e6e
kind: lesson
summary: >-
  Clean persistence, hook, TDD, and PII-free UI evidence lessons applied from Verse.
  Also: persistence, beads, dolt, scry, hooks, tdd, playwright, pii_guard
status: active
weight: 0.9
tags: ["topic:architecture", "architecture", "scope:docs", "docs", "beads", "scry", "sdlc"]
rationale: >-
  Captures verified persistence and SDLC invariants so agents do not repeat Dolt, Scry, or PII mistakes.
applies: configuring beads, configuring scry, writing hooks, reviewing UI pull requests
seeded_questions:
  - "How should Beads and Scry state be persisted in Git and Dolt?"
  - "How do we prevent local PII leaks in Playwright PR screenshots?"
@scry.entry.end -->

# Persistence and SDLC Lessons

This document records the verified persistence and SDLC rules learned from the `verse` repository.

## 1. Beads Persistence (`bd` and Dolt)

- Store Beads issues, meta-epics, sub-epics, gates, and dependencies on Git ref `refs/dolt/data` via `bd dolt push` and `bd dolt pull`.
- Pin the `bd` version in `.beads/version.txt` and configure Dolt server mode on port `3307` in `.beads/config.yaml` and `.beads/metadata.json`.
- Never commit `.beads/dolt/`, `.beads/embeddeddolt/`, `.beads/proxieddb/`, or `.beads/dolt-server.*` to Git `main`.
- Never run `bd init` on an existing clone. Use `bd dolt pull` after cloning.

## 2. Scry Persistence (`scry`)

- Track only `agent/drivers/@local/scry/.gitignore` in Git. Keep `data/project.db` and `runtime/` untracked and ephemeral.
- Persist durable knowledge inside `@scry.entry` markers in tracked `src/`, `tools/`, `docs/`, and `sidecars/` files.
- Always mint IDs with `scry_mint` before authoring a marker.
- On Windows, set `PYTHONUTF8=1` when running `scry init` or `scry surface` to prevent `UnicodeEncodeError`.

## 3. Antigravity Hooks and Git Hooks

- Use `.agents/hooks.json` for `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop` enforcement.
- Use `.beads/hooks/` (`pre-commit`, `commit-msg`, `pre-push`) via `git config core.hooksPath .beads/hooks` to block direct `main` commits, enforce `Beads-Issue: <id>`, and validate `@scry.entry` markers.

## 4. Strict TDD and PII-Free UI Media Evidence

- Write failing tests before production code. CI `pr-gate` rejects production edits without test changes.
- Run Playwright exclusively against synthetic fixtures (`BEADS_TEST_ENV=synthetic` and `BEADS_FIXTURE_PATH=tests/fixtures/synthetic-beads.json`).
- Scan fixtures, docs, PR text, and test outputs with `python -m tools.pii_guard` so local home paths, emails, and user tokens never enter pull requests.
