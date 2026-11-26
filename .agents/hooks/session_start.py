"""Antigravity SessionStart hook for Beads and Scry priming."""

from __future__ import annotations

import shutil
import socket
import subprocess
import sys
from pathlib import Path

HOOKS_DIR = Path(__file__).resolve().parent
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

from _common import (  # noqa: E402
    REPO_ROOT,
    emit_json,
    get_in_progress_beads,
    get_ready_count,
    has_beads_workspace,
    read_hook_input,
    run_bd,
)


def _ensure_git_hooks_path(repo_root: Path = REPO_ROOT) -> None:
    """Set local Git core.hooksPath to .beads/hooks when present."""
    if not (repo_root / ".beads" / "hooks").is_dir():
        return
    git_exe = shutil.which("git")
    if not git_exe:
        return
    subprocess.run(
        [git_exe, "config", "core.hooksPath", ".beads/hooks"],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )


def _dolt_reachable(port: int = 3307) -> bool:
    """Return True when loopback Dolt SQL server accepts TCP connections."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.0):
            return True
    except OSError:
        return False


def build_session_message(repo_root: Path = REPO_ROOT) -> str:
    """Build compact ASD-STE100 SDLC status message for SessionStart."""
    _ensure_git_hooks_path(repo_root)
    sync_txt = "local"
    if has_beads_workspace(repo_root):
        rc, _out, _err = run_bd(["dolt", "pull"], cwd=repo_root, timeout=8)
        sync_txt = "synced" if rc == 0 else "offline-local"

    reachable, active, _err = get_in_progress_beads(repo_root)
    ready_count = get_ready_count(repo_root) if reachable else None
    active_ids = ", ".join(str(b.get("id", "?")) for b in active[:4]) or "none"
    beads_txt = (
        f"Beads: active=[{active_ids}], ready={ready_count}, sync={sync_txt}."
        if reachable
        else "Beads: Dolt unreachable (start dolt sql-server on port 3307)."
    )
    dolt_txt = f"Dolt: 127.0.0.1:3307 ({'ok' if _dolt_reachable() else 'down'})."
    scry_txt = "Scry: ready." if (repo_root / "agent" / "drivers").exists() else "Scry: run scry init."

    prime_file = repo_root / ".beads" / "PRIME.md"
    prime_txt = prime_file.read_text(encoding="utf-8").strip() if prime_file.is_file() else ""
    status = f"Status: {beads_txt} {dolt_txt} {scry_txt}"
    return f"{prime_txt}\n{status}".strip()


def main() -> int:
    """Emit SessionStart systemMessage JSON."""
    _ = read_hook_input()
    msg = build_session_message(REPO_ROOT)
    emit_json({"injectSteps": [{"systemMessage": {"systemMessage": msg}}]} if msg else {})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
