"""Unit tests for tools.pii_guard."""

from __future__ import annotations

from pathlib import Path

from tools.pii_guard import scan_paths, scan_text


def test_scan_text_allows_synthetic_test_data() -> None:
    """Verify clean synthetic test data produces zero PII findings."""
    sample = (
        "Workspace: /synthetic/workspace/beads-demo\n"
        "Author: agent-alpha@synthetic.local\n"
        "Spec: docs/specs/sample-view.md\n"
    )
    findings = scan_text(sample, source_name="tests/fixtures/synthetic-beads.json")
    assert findings == []


def test_scan_text_detects_local_user_paths_and_emails() -> None:
    """Verify local home paths and non-synthetic emails are flagged."""
    win_leak = "Path: C:" + "\\Users\\alice\\Documents\\secret.txt"
    mac_leak = "Path: /Users/alice/workspace/notes.md"
    linux_leak = "Path: /home/alice/.ssh/id_rsa"
    email_leak = "Contact: alice.smith@company.com"

    assert len(scan_text(win_leak, "a.txt")) == 1
    assert len(scan_text(mac_leak, "b.txt")) == 1
    assert len(scan_text(linux_leak, "c.txt")) == 1
    assert len(scan_text(email_leak, "d.txt")) == 1


def test_scan_paths_scans_directory_and_reports_findings(tmp_path: Path) -> None:
    """Verify scan_paths inspects files recursively and flags leaks."""
    clean_file = tmp_path / "clean.json"
    clean_file.write_text('{"assignee": "agent-alpha"}', encoding="utf-8")
    dirty_file = tmp_path / "leak.txt"
    dirty_file.write_text("C:" + "\\Users\\realperson\\file.txt", encoding="utf-8")

    ok, findings = scan_paths([clean_file, dirty_file])
    assert ok is False
    assert len(findings) == 1
    assert "leak.txt" in findings[0]["source"]
