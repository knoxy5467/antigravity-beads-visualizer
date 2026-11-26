"""Antigravity PostToolUse hook for Scry SQLite cache refresh."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Any

HOOKS_DIR = Path(__file__).resolve().parent
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

from _common import (  # noqa: E402
    REPO_ROOT,
    emit_json,
    extract_target_path,
    find_scry_executable,
    is_exempt_path,
    read_hook_input,
    relative_repo_posix,
)

FILE_MUTATION_TOOLS = frozenset(
    {"write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content"}
)
INDEXED_SUFFIXES = frozenset({".py", ".js", ".mjs", ".ts", ".md"})


def handle_post_tool(payload: dict[str, Any], repo_root: Path = REPO_ROOT) -> dict[str, Any]:
    """Refresh the Scry SQLite index after indexed source or doc edits."""
    tool_call = payload.get("toolCall")
    if not isinstance(tool_call, dict):
        return {}
    if str(tool_call.get("name", "")) not in FILE_MUTATION_TOOLS:
        return {}
    tool_args = tool_call.get("args")
    if not isinstance(tool_args, dict):
        return {}
    target_path = extract_target_path(tool_args)
    if not target_path or is_exempt_path(target_path, repo_root=repo_root):
        return {}
    rel_path = relative_repo_posix(target_path, repo_root=repo_root)
    if not rel_path or Path(rel_path).suffix.lower() not in INDEXED_SUFFIXES:
        return {}
    if not (repo_root / "agent" / "drivers").exists():
        return {}
    scry_exe = find_scry_executable()
    if not scry_exe:
        return {}

    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        subprocess.run(
            [scry_exe, "surface"],
            cwd=str(repo_root),
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {}
    return {}


def main() -> int:
    """Read PostToolUse payload and emit an empty JSON object."""
    emit_json(handle_post_tool(read_hook_input(), REPO_ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
