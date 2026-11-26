# @scry.entry
# id: tools.pii-guard~c5459854
# kind: code
# summary: >-
#   Scan fixtures, docs, PR text, and Playwright artifacts for local PII leaks.
#   Also: pii_guard, synthetic-env, privacy-gate, local-path-check
# status: active
# weight: 0.8
# tags: ["topic:security", "security", "scope:tools", "tools", "pii", "playwright"]
# rationale: >-
#   Prevents local user paths, emails, and private workspace names from leaking into PRs.
# applies: scanning test fixtures, checking PR descriptions, validating UI media artifacts
# seeded_questions:
#   - "How do we verify that screenshots and fixtures contain no local PII?"
#   - "tools.pii_guard scan"
# @scry.entry.end
"""Scan fixtures, docs, PR text, and Playwright outputs for local PII leaks."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

SAFE_EMAIL_DOMAINS = frozenset({"example.com", "example.org", "example.test", "synthetic.local"})
SAFE_USERS = frozenset({"runner", "synthetic", "ci-bot", "testuser"})
TEXT_EXTENSIONS = frozenset({".json", ".md", ".txt", ".html", ".css", ".js", ".mjs", ".ts", ".yml", ".yaml", ".xml"})

WIN_USER_RE = re.compile(r"[A-Za-z]:\\Users\\([^\\/\s\"']+)", re.IGNORECASE)
UNIX_USER_RE = re.compile(r"(?<![A-Za-z0-9])/(?:Users|home)/([^/\s\"']+)")
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")


def _local_sensitive_tokens() -> list[str]:
    """Return non-trivial local username tokens from the current environment."""
    tokens: list[str] = []
    raw_user = os.environ.get("USERNAME") or os.environ.get("USER") or ""
    cleaned = raw_user.strip()
    if len(cleaned) >= 4 and cleaned.lower() not in SAFE_USERS and cleaned.lower() != "user":
        tokens.append(cleaned)
    return tokens


def scan_text(text: str, source_name: str = "<stdin>") -> list[dict[str, Any]]:
    """Scan a text string and return a list of PII leak findings."""
    findings: list[dict[str, Any]] = []
    local_tokens = _local_sensitive_tokens()

    for line_no, line in enumerate(text.splitlines(), start=1):
        for match in WIN_USER_RE.finditer(line):
            findings.append(
                {
                    "source": source_name,
                    "line": line_no,
                    "kind": "windows_home_path",
                    "detail": match.group(0),
                }
            )
        for match in UNIX_USER_RE.finditer(line):
            user_seg = match.group(1).lower()
            if user_seg not in SAFE_USERS:
                findings.append(
                    {
                        "source": source_name,
                        "line": line_no,
                        "kind": "unix_home_path",
                        "detail": match.group(0),
                    }
                )
        for match in EMAIL_RE.finditer(line):
            domain = match.group(1).lower()
            if domain not in SAFE_EMAIL_DOMAINS:
                findings.append(
                    {
                        "source": source_name,
                        "line": line_no,
                        "kind": "non_synthetic_email",
                        "detail": match.group(0),
                    }
                )
        for token in local_tokens:
            if re.search(rf"\b{re.escape(token)}\b", line, re.IGNORECASE):
                findings.append(
                    {
                        "source": source_name,
                        "line": line_no,
                        "kind": "local_username_token",
                        "detail": token,
                    }
                )

    return findings


def scan_paths(paths: list[Path]) -> tuple[bool, list[dict[str, Any]]]:
    """Scan files or directories recursively for PII findings."""
    all_findings: list[dict[str, Any]] = []
    for raw_path in paths:
        if raw_path.is_dir():
            for child in sorted(raw_path.rglob("*")):
                if child.is_file() and child.suffix.lower() in TEXT_EXTENSIONS:
                    text = child.read_text(encoding="utf-8", errors="replace")
                    all_findings.extend(scan_text(text, source_name=child.as_posix()))
        elif raw_path.is_file() and raw_path.suffix.lower() in TEXT_EXTENSIONS:
            text = raw_path.read_text(encoding="utf-8", errors="replace")
            all_findings.extend(scan_text(text, source_name=raw_path.as_posix()))
    return len(all_findings) == 0, all_findings


def main(argv: list[str] | None = None) -> int:
    """Run PII guard scan on provided paths or PR body text."""
    parser = argparse.ArgumentParser(description="Scan files and PR bodies for local PII leaks.")
    parser.add_argument("paths", nargs="*", type=Path, help="Files or folders to scan.")
    parser.add_argument("--pr-body", default="", help="Optional pull request body text.")
    args = parser.parse_args(argv)

    ok, findings = scan_paths(args.paths)
    if args.pr_body:
        pr_findings = scan_text(args.pr_body, source_name="PR_BODY")
        findings.extend(pr_findings)
        ok = ok and len(pr_findings) == 0

    sys.stdout.write(json.dumps({"ok": ok, "findings": findings}, indent=2) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
