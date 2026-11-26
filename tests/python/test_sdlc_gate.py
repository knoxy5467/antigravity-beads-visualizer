"""Unit tests for tools.sdlc_gate."""

from __future__ import annotations

from pathlib import Path

from tools.sdlc_gate import (
    check_language_policy,
    check_ui_pr_evidence,
    evaluate_tdd_gate,
    run_git_commit_msg,
    validate_scry_entry_content,
)


def test_validate_scry_entry_content_accepts_valid_python_and_js_markers() -> None:
    """Verify Python (#) and JS (//) @scry.entry blocks validate cleanly."""
    py_text = (
        "# @scry.entry\n"
        "# id: tools.sample~11111111\n"
        "# kind: code\n"
        "# summary: >-\n"
        "#   Sample helper module. Also: sample\n"
        "# status: active\n"
        "# @scry.entry.end\n"
    )
    js_text = (
        "// @scry.entry\n"
        "// id: src.sample~22222222\n"
        "// kind: code\n"
        "// summary: >-\n"
        "//   Sample JS module. Also: sample\n"
        "// status: active\n"
        "// @scry.entry.end\n"
    )
    assert validate_scry_entry_content(py_text, "tools/sample.py", require_entry=True) == []
    assert validate_scry_entry_content(js_text, "src/sample.mjs", require_entry=True) == []


def test_validate_scry_entry_content_rejects_missing_or_placeholder() -> None:
    """Verify missing or placeholder @scry.entry markers fail validation."""
    missing = "def hello():\n    return 'world'\n"
    placeholder = (
        "# @scry.entry\n# id: tools.sample~TBD\n# kind: code\n# summary: Sample\n# status: active\n# @scry.entry.end\n"
    )
    assert validate_scry_entry_content(missing, "tools/a.py", require_entry=True)
    assert validate_scry_entry_content(placeholder, "tools/b.py", require_entry=True)


def test_run_git_commit_msg_enforces_single_beads_issue(tmp_path: Path) -> None:
    """Verify commit-msg requires exactly one Beads-Issue trailer."""
    msg_ok = tmp_path / "COMMIT_OK"
    msg_ok.write_text("[ASDLC:DEV] Add tree view\n\nBeads-Issue: bv-ui-tree\n", encoding="utf-8")
    assert run_git_commit_msg(msg_ok, repo_root=tmp_path)["ok"] is True

    msg_missing = tmp_path / "COMMIT_MISSING"
    msg_missing.write_text("[ASDLC:DEV] Add tree view\n", encoding="utf-8")
    assert run_git_commit_msg(msg_missing, repo_root=tmp_path)["ok"] is False

    msg_multi = tmp_path / "COMMIT_MULTI"
    msg_multi.write_text(
        "[ASDLC:DEV] Two beads\n\nBeads-Issue: bv-a-one\nBeads-Issue: bv-b-two\n",
        encoding="utf-8",
    )
    assert run_git_commit_msg(msg_multi, repo_root=tmp_path)["ok"] is False


def test_evaluate_tdd_gate_requires_tests_when_prod_changes() -> None:
    """Verify production code edits require matching test edits unless exempt."""
    res_fail = evaluate_tdd_gate(["src/core/graph.mjs"], pr_body="Beads-Issue: bv-data-bd-reader")
    assert res_fail["ok"] is False

    res_pass = evaluate_tdd_gate(
        ["src/core/graph.mjs", "tests/unit/graph.test.mjs"],
        pr_body="Beads-Issue: bv-data-bd-reader",
    )
    assert res_pass["ok"] is True

    res_docs = evaluate_tdd_gate(["docs/README.md"], pr_body="Beads-Issue: bv-docs-readme")
    assert res_docs["ok"] is True


def test_check_ui_pr_evidence_requires_media_and_pii_attestation() -> None:
    """Verify UI changes require ## UI Evidence, media link, and synthetic attestation."""
    no_ui = check_ui_pr_evidence(["tools/sdlc_gate.py"], pr_body="Beads-Issue: bv-a-b")
    assert no_ui["ok"] is True

    missing_section = check_ui_pr_evidence(["src/ui/app.js"], pr_body="Beads-Issue: bv-ui-x")
    assert missing_section["ok"] is False

    valid_body = (
        "Beads-Issue: bv-ui-x\n\n"
        "## UI Evidence\n"
        "![Synthetic UI](docs/assets/pr-preview-synthetic.png)\n"
        "- [x] Captured exclusively from the synthetic test environment (no local PII)\n"
    )
    valid_ui = check_ui_pr_evidence(["src/ui/app.js"], pr_body=valid_body)
    assert valid_ui["ok"] is True


def test_check_language_policy_blocks_non_ts_project_files(tmp_path: Path) -> None:
    """Verify check_language_policy rejects .py, .js, and .mjs under src/ and tests/unit/."""
    (tmp_path / "src").mkdir(parents=True)
    (tmp_path / "src" / "main.ts").write_text("export const x = 1;\n", encoding="utf-8")
    assert check_language_policy(tmp_path)["ok"] is True

    (tmp_path / "src" / "legacy.mjs").write_text("export const y = 2;\n", encoding="utf-8")
    res = check_language_policy(tmp_path)
    assert res["ok"] is False
    assert "src/legacy.mjs" in res["detail"]
