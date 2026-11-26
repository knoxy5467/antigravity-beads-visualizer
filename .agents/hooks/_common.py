"""Shared helpers for Antigravity SDLC hooks."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]

EXEMPT_PREFIXES = (
    ".gemini/",
    "brain/",
    "artifacts/",
    ".beads/",
    "agent/drivers/",
    ".pytest_cache/",
    ".ruff_cache/",
    ".venv/",
    "venv/",
    "node_modules/",
    "test-results/",
    "playwright-report/",
)


def read_hook_input() -> dict[str, Any]:
    """Read JSON hook payload from stdin safely."""
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return {}
        raw = sys.stdin.read()
    except OSError:
        return {}
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def emit_json(payload: dict[str, Any]) -> None:
    """Write compact JSON hook output to stdout."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def find_bd_executable() -> str | None:
    """Locate the Beads CLI executable on PATH or the default Windows folder."""
    found = shutil.which("bd")
    if found:
        return found
    cand = Path.home() / "AppData" / "Local" / "Programs" / "bd" / "bd.exe"
    return str(cand) if cand.is_file() else None


def find_scry_executable() -> str | None:
    """Locate the Scry CLI executable on PATH."""
    return shutil.which("scry")


def run_bd(args: list[str], cwd: Path = REPO_ROOT, timeout: int = 8) -> tuple[int, str, str]:
    """Run one Beads CLI command and return exit code, stdout, and stderr."""
    bd_exe = find_bd_executable()
    if not bd_exe:
        return 127, "", "bd executable not found"
    try:
        proc = subprocess.run(
            [bd_exe, *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, "", str(exc)
    return proc.returncode, proc.stdout, proc.stderr


def _parse_issues(raw: str) -> list[dict[str, Any]]:
    """Parse JSON list or object output from bd CLI."""
    if not raw.strip():
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if isinstance(parsed, list):
        return [i for i in parsed if isinstance(i, dict)]
    if isinstance(parsed, dict) and isinstance(parsed.get("issues"), list):
        return [i for i in parsed["issues"] if isinstance(i, dict)]
    if isinstance(parsed, dict):
        return [parsed]
    return []


def get_in_progress_beads(cwd: Path = REPO_ROOT) -> tuple[bool, list[dict[str, Any]], str]:
    """Return reachability, active in-progress beads, and error text."""
    code, stdout, stderr = run_bd(["list", "--status", "in_progress", "--json"], cwd=cwd)
    if code != 0:
        return False, [], f"{stdout}\n{stderr}".strip()
    return True, _parse_issues(stdout), ""


def get_ready_count(cwd: Path = REPO_ROOT) -> int | None:
    """Return count of unblocked ready beads, or None if unreachable."""
    code, stdout, _err = run_bd(["ready", "--json"], cwd=cwd)
    return len(_parse_issues(stdout)) if code == 0 else None


def has_beads_workspace(cwd: Path = REPO_ROOT) -> bool:
    """Return True when cwd contains .beads or a linked Git worktree."""
    return (cwd / ".beads").exists() or (cwd / ".git").is_file()


def extract_target_path(tool_args: dict[str, Any]) -> str:
    """Extract target file path from tool call arguments."""
    for key in ("Path", "TargetFile", "path", "file_path"):
        val = tool_args.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def extract_written_content(tool_args: dict[str, Any]) -> str:
    """Extract written or replacement content from tool call arguments."""
    for key in ("Content", "CodeContent", "Replacement", "ReplacementContent"):
        val = tool_args.get(key)
        if isinstance(val, str) and val:
            return val
    return ""


def relative_repo_posix(target_path: str, repo_root: Path = REPO_ROOT) -> str | None:
    """Return forward-slash path relative to repo_root, or None if outside."""
    if not target_path:
        return None
    root_norm = Path(os.path.normcase(str(repo_root.resolve())))
    raw = Path(target_path)
    resolved = raw.resolve() if raw.is_absolute() else (repo_root / raw).resolve()
    target_norm = Path(os.path.normcase(str(resolved)))
    try:
        rel = target_norm.relative_to(root_norm)
    except ValueError:
        return None
    return rel.as_posix()


def is_exempt_path(target_path: str, repo_root: Path = REPO_ROOT) -> bool:
    """Return True when target_path is outside repo_root or matches exempt prefixes."""
    rel = relative_repo_posix(target_path, repo_root=repo_root)
    if rel is None:
        return True
    lowered = rel.lower()
    return any(lowered.startswith(prefix) for prefix in EXEMPT_PREFIXES)


def get_git_status_porcelain(cwd: Path = REPO_ROOT) -> list[str]:
    """Return porcelain lines from git status."""
    try:
        proc = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [ln for ln in proc.stdout.splitlines() if ln.strip()] if proc.returncode == 0 else []


def get_staged_files(cwd: Path = REPO_ROOT) -> list[str]:
    """Return staged file paths from git diff --cached --name-only."""
    try:
        proc = subprocess.run(
            ["git", "diff", "--cached", "--name-only"],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if proc.returncode != 0:
        return []
    return [ln.strip().replace("\\", "/") for ln in proc.stdout.splitlines() if ln.strip()]
