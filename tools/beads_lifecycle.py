# @scry.entry
# id: tools.beads-lifecycle~6c80f2ad
# kind: code
# summary: >-
#   Mint descriptive Beads IDs and extract CI or PR review blockers.
#   Also: beads_lifecycle, slug-id, extract-ci-failure, extract-review-changes
# status: active
# weight: 0.7
# tags: ["topic:workflow", "workflow", "scope:tools", "tools", "beads"]
# rationale: >-
#   Keeps Beads task IDs readable and automates blocker creation from CI and PR reviews.
# applies: minting bead IDs, extracting CI failures, extracting PR review blockers
# seeded_questions:
#   - "How do we mint a descriptive bv-<domain>-<slug> Beads ID?"
#   - "tools.beads_lifecycle slug-id"
# @scry.entry.end
"""Mint descriptive Beads IDs and extract CI or PR review blockers."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

SLUG_ID_RE = re.compile(r"^bv-[a-z0-9]+(?:-[a-z0-9]+)+$")
TOKEN_RE = re.compile(r"[a-z0-9]+")
MAX_ID_LEN = 48


def find_bd_executable() -> str:
    """Find the Beads CLI executable on PATH or the default Windows folder."""
    found = shutil.which("bd")
    if found:
        return found
    candidate = Path.home() / "AppData" / "Local" / "Programs" / "bd" / "bd.exe"
    if candidate.is_file():
        return str(candidate)
    raise FileNotFoundError("bd executable not found.")


def is_valid_slug_id(bead_id: str) -> bool:
    """Return True when bead_id matches bv-<domain>-<slug> rules."""
    cleaned = bead_id.strip()
    if not cleaned or len(cleaned) > MAX_ID_LEN:
        return False
    return bool(SLUG_ID_RE.fullmatch(cleaned))


def mint_slug_id(domain: str, title: str) -> str:
    """Build a deterministic bv-<domain>-<slug> ID from domain and title."""
    domain_tokens = TOKEN_RE.findall(domain.lower())
    domain_part = "-".join(domain_tokens) if domain_tokens else "core"
    title_tokens = TOKEN_RE.findall(title.lower())
    if not title_tokens:
        title_tokens = ["task"]

    prefix = f"bv-{domain_part}-"
    budget = MAX_ID_LEN - len(prefix)
    if budget < 3:
        prefix = "bv-core-"
        budget = MAX_ID_LEN - len(prefix)

    parts: list[str] = []
    used = 0
    for token in title_tokens:
        extra = len(token) + (1 if parts else 0)
        if used + extra > budget:
            break
        parts.append(token)
        used += extra
    if not parts:
        parts.append(title_tokens[0][:budget])
    return f"{prefix}{'-'.join(parts)}"


def _create_blocker_bead(title: str, description: str, target_bead: str) -> dict[str, str]:
    """Create a P1 blocker bug linked to target_bead in Beads."""
    bd_exe = find_bd_executable()
    blocker_id = mint_slug_id("gate", title)
    proc = subprocess.run(
        [
            bd_exe,
            "create",
            title,
            "--id",
            blocker_id,
            "-t",
            "bug",
            "-p",
            "1",
            "--deps",
            f"blocks:{target_bead}",
            "--description",
            description,
            "--json",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return {
        "ok": "true" if proc.returncode == 0 else "false",
        "blocker_id": blocker_id,
        "detail": (proc.stdout or proc.stderr).strip(),
    }


def main(argv: list[str] | None = None) -> int:
    """Run CLI subcommands for tools.beads_lifecycle."""
    parser = argparse.ArgumentParser(description="Manage Beads IDs and gate blockers.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_slug = sub.add_parser("slug-id", help="Mint or validate a bv-<domain>-<slug> ID.")
    p_slug.add_argument("--domain", default="core", help="Short domain segment.")
    p_slug.add_argument("--title", default="", help="Human title for slug generation.")
    p_slug.add_argument("--check", default="", help="Validate an existing ID.")

    p_ci = sub.add_parser("extract-ci-failure", help="File a CI failure blocker bead.")
    p_ci.add_argument("--run-id", required=True, help="GitHub Actions run ID.")
    p_ci.add_argument("--target-bead", required=True, help="Blocked Bead ID.")

    p_rev = sub.add_parser("extract-review-changes", help="File a PR review blocker bead.")
    p_rev.add_argument("--pr", required=True, help="GitHub pull request number.")
    p_rev.add_argument("--target-bead", required=True, help="Blocked Bead ID.")

    args = parser.parse_args(argv)
    if args.command == "slug-id":
        if args.check:
            ok = is_valid_slug_id(args.check)
            sys.stdout.write(json.dumps({"ok": ok, "id": args.check}) + "\n")
            return 0 if ok else 1
        minted = mint_slug_id(args.domain, args.title or "task")
        sys.stdout.write(json.dumps({"ok": True, "id": minted}) + "\n")
        return 0

    if args.command == "extract-ci-failure":
        res = _create_blocker_bead(
            f"CI failure on run {args.run_id}",
            f"GitHub Actions run {args.run_id} failed for {args.target_bead}.",
            args.target_bead,
        )
        sys.stdout.write(json.dumps(res) + "\n")
        return 0 if res["ok"] == "true" else 1

    if args.command == "extract-review-changes":
        res = _create_blocker_bead(
            f"Review changes on PR {args.pr}",
            f"Pull request {args.pr} requested changes on {args.target_bead}.",
            args.target_bead,
        )
        sys.stdout.write(json.dumps(res) + "\n")
        return 0 if res["ok"] == "true" else 1

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
