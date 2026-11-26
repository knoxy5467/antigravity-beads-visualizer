"""Antigravity PreToolUse hook enforcing Beads tracking, Scry markers, and TDD."""

from __future__ import annotations

import re
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
    extract_written_content,
    get_in_progress_beads,
    is_exempt_path,
    read_hook_input,
    relative_repo_posix,
)

FILE_MUTATION_TOOLS = frozenset(
    {"write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content"}
)
NEW_FILE_TOOLS = frozenset({"write_file", "write_to_file"})
SCRY_REQUIRED_PREFIXES = ("src/", "tools/", "docs/", "sidecars/")
SCRY_REQUIRED_SUFFIXES = frozenset({".py", ".js", ".mjs", ".ts", ".md"})

BD_EDIT_RE = re.compile(r"\bbd(?:\.exe)?\s+edit\b", re.IGNORECASE)
BD_DOCTOR_RE = re.compile(r"\bbd(?:\.exe)?\s+doctor\b", re.IGNORECASE)
GIT_COMMIT_RE = re.compile(r"\bgit(?:\.exe)?\s+commit\b", re.IGNORECASE)
BEADS_TRAILER_RE = re.compile(r"Beads-Issue:\s*[A-Za-z0-9][A-Za-z0-9._-]*")
PLACEHOLDER_SCRY_RE = re.compile(
    r"@scry\.(?:entry|bind|anchor)\b[^\n]*\b(?:TBD|TODO|PLACEHOLDER|FIXME|XXX)\b",
    re.IGNORECASE,
)


def _allow() -> dict[str, Any]:
    return {"decision": "allow"}


def _deny(reason: str) -> dict[str, Any]:
    return {"decision": "deny", "reason": reason}


def _evaluate_command(command_line: str) -> dict[str, Any]:
    """Validate shell commands against Beads SDLC rules."""
    if BD_EDIT_RE.search(command_line):
        return _deny("Do not run bd edit because it hangs agents. Use bd update flags.")
    if BD_DOCTOR_RE.search(command_line):
        if ("--fix" in command_line or "--clean" in command_line) and "--yes" not in command_line:
            return _deny("Pass --yes when you run bd doctor --fix or bd doctor --clean.")
    if (
        GIT_COMMIT_RE.search(command_line)
        and "--no-edit" not in command_line
        and not BEADS_TRAILER_RE.search(command_line)
    ):
        return _deny("Include Beads-Issue: <id> in every git commit message.")
    return _allow()


def _needs_scry_entry(tool_name: str, tool_args: dict[str, Any], rel_path: str, repo_root: Path) -> bool:
    """Return True when creating a new file under src/, tools/, docs/, or sidecars/."""
    if tool_name not in NEW_FILE_TOOLS or bool(tool_args.get("Append")):
        return False
    if not rel_path.startswith(SCRY_REQUIRED_PREFIXES):
        return False
    target = repo_root / rel_path
    if target.exists() or target.name == "__init__.py":
        return False
    return target.suffix.lower() in SCRY_REQUIRED_SUFFIXES


def evaluate_pre_tool(payload: dict[str, Any], repo_root: Path = REPO_ROOT) -> dict[str, Any]:
    """Evaluate a PreToolUse payload and return allow or deny."""
    tool_call = payload.get("toolCall")
    if not isinstance(tool_call, dict):
        return _allow()
    tool_name = str(tool_call.get("name", ""))
    tool_args = tool_call.get("args")
    if not isinstance(tool_args, dict):
        tool_args = {}

    if tool_name == "run_command":
        return _evaluate_command(str(tool_args.get("CommandLine", "")))
    if tool_name not in FILE_MUTATION_TOOLS:
        return _allow()

    target_path = extract_target_path(tool_args)
    if not target_path or is_exempt_path(target_path, repo_root=repo_root):
        return _allow()

    content = extract_written_content(tool_args)
    if content and PLACEHOLDER_SCRY_RE.search(content):
        return _deny("Replace placeholder Scry IDs with a real ID from scry_mint.")

    rel_path = relative_repo_posix(target_path, repo_root=repo_root)
    if rel_path and _needs_scry_entry(tool_name, tool_args, rel_path, repo_root):
        if "@scry.entry" not in content:
            return _deny("Add a minted @scry.entry marker to new files under src/, tools/, docs/, or sidecars/.")

    reachable, active, _err = get_in_progress_beads(repo_root)
    if not reachable:
        return _deny("Start the Dolt server on port 3307 and claim a bead before editing files.")
    if not active:
        return _deny("Claim an in_progress bead with bd update <id> --claim before editing files.")
    return _allow()


def main() -> int:
    """Read PreToolUse payload from stdin and emit decision JSON."""
    emit_json(evaluate_pre_tool(read_hook_input(), REPO_ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
