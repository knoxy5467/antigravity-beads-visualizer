"""Antigravity Stop hook enforcing staged cache safety and bead handoff notes."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

HOOKS_DIR = Path(__file__).resolve().parent
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

from _common import (  # noqa: E402
    REPO_ROOT,
    emit_json,
    get_git_status_porcelain,
    get_in_progress_beads,
    get_staged_files,
    is_exempt_path,
    read_hook_input,
)

FORBIDDEN_STAGED_PREFIXES = (
    ".beads/dolt/",
    ".beads/embeddeddolt/",
    ".beads/proxieddb/",
    "agent/project.db",
    "agent/drivers/@local/scry/data/",
    "agent/drivers/@local/scry/runtime/",
)


def _porcelain_path(line: str) -> str:
    """Extract target file path from a git status --porcelain line."""
    raw = line[3:].strip() if len(line) > 3 else line.strip()
    if " -> " in raw:
        raw = raw.split(" -> ", 1)[1].strip()
    return raw.strip('"')


def evaluate_stop(payload: dict[str, Any], repo_root: Path = REPO_ROOT) -> dict[str, Any]:
    """Check turn-end SDLC hygiene and force continuation once on hard violations."""
    if payload.get("terminationReason") != "NO_TOOL_CALL" or bool(payload.get("continuationActive")):
        return {"decision": "allow"}

    violations: list[str] = []
    for staged in get_staged_files(repo_root):
        if any(staged.lower().startswith(p) for p in FORBIDDEN_STAGED_PREFIXES):
            violations.append("Unstage binary Dolt or Scry cache files before stopping.")
            break

    dirty = [
        ln for ln in get_git_status_porcelain(repo_root) if not is_exempt_path(_porcelain_path(ln), repo_root=repo_root)
    ]
    if dirty:
        reachable, active, _err = get_in_progress_beads(repo_root)
        if reachable and active and all(not str(b.get("notes") or "").strip() for b in active):
            violations.append("Record six-key notes on your active bead or close it before stopping.")

    if violations:
        return {"decision": "continue", "reason": " ".join(violations)}
    return {"decision": "allow"}


def main() -> int:
    """Read Stop payload from stdin and emit decision JSON."""
    emit_json(evaluate_stop(read_hook_input(), REPO_ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
