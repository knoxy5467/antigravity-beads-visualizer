"""Unit tests for Antigravity SDLC hooks in .agents/hooks/."""

from __future__ import annotations

import sys
from pathlib import Path

HOOKS_DIR = Path(__file__).resolve().parents[2] / ".agents" / "hooks"
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

from pre_tool_gate import evaluate_pre_tool  # noqa: E402
from stop_gate import evaluate_stop  # noqa: E402


def test_pre_tool_gate_blocks_bd_edit_and_untagged_commits(tmp_path: Path) -> None:
    """Verify PreToolUse blocks bd edit, unsafe bd doctor, and untagged git commit."""
    res_edit = evaluate_pre_tool(
        {"toolCall": {"name": "run_command", "args": {"CommandLine": "bd edit bv-1"}}},
        repo_root=tmp_path,
    )
    assert res_edit["decision"] == "deny"

    res_doc = evaluate_pre_tool(
        {"toolCall": {"name": "run_command", "args": {"CommandLine": "bd doctor --fix"}}},
        repo_root=tmp_path,
    )
    assert res_doc["decision"] == "deny"

    res_commit = evaluate_pre_tool(
        {"toolCall": {"name": "run_command", "args": {"CommandLine": 'git commit -m "wip"'}}},
        repo_root=tmp_path,
    )
    assert res_commit["decision"] == "deny"


def test_pre_tool_gate_blocks_new_src_file_without_scry_entry(tmp_path: Path) -> None:
    """Verify new files under src/, tools/, or docs/ require @scry.entry."""
    (tmp_path / "src").mkdir()
    target = tmp_path / "src" / "new_mod.ts"
    res = evaluate_pre_tool(
        {
            "toolCall": {
                "name": "write_file",
                "args": {"Path": str(target), "Content": "export const f = (): number => 1;\n"},
            }
        },
        repo_root=tmp_path,
    )
    assert res["decision"] == "deny"
    assert "scry.entry" in res["reason"]


def test_stop_gate_allows_when_continuation_active(tmp_path: Path) -> None:
    """Verify Stop hook does not loop when continuationActive is true."""
    res = evaluate_stop(
        {"terminationReason": "NO_TOOL_CALL", "continuationActive": True},
        repo_root=tmp_path,
    )
    assert res["decision"] == "allow"


def test_pre_tool_gate_enforces_typescript_for_project_dirs(tmp_path: Path) -> None:
    """Verify project directories reject .py, .js, and .mjs files."""
    (tmp_path / "src").mkdir()
    for bad_name in ("app.py", "app.js", "app.mjs"):
        target = tmp_path / "src" / bad_name
        res = evaluate_pre_tool(
            {
                "toolCall": {
                    "name": "write_file",
                    "args": {"Path": str(target), "Content": "// @scry.entry\n// @scry.entry.end\n"},
                }
            },
            repo_root=tmp_path,
        )
        assert res["decision"] == "deny"
        assert "TypeScript" in res["reason"]


def test_get_in_progress_beads_uses_fresh_cache(tmp_path: Path) -> None:
    """Verify get_in_progress_beads reads active beads from fresh cache."""
    import json
    import time

    from _common import get_in_progress_beads

    beads_dir = tmp_path / ".beads"
    beads_dir.mkdir()
    cache_file = beads_dir / ".hook_active_cache.json"
    cache_file.write_text(
        json.dumps({"ts": time.time(), "active": [{"id": "bv-cached-1"}]}),
        encoding="utf-8",
    )
    ok, active, err = get_in_progress_beads(tmp_path)
    assert ok is True
    assert err == ""
    assert active[0]["id"] == "bv-cached-1"
