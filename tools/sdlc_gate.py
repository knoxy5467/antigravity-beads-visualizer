# @scry.entry
# id: tools.sdlc-gate~c7a5eba9
# kind: code
# summary: >-
#   Run deterministic SDLC gates for Beads, Scry, TDD, UI PR media, and Git hooks.
#   Also: sdlc_gate, green-bar, pr-gate, formula-check, ui-evidence
# status: active
# weight: 0.8
# tags: ["topic:workflow", "workflow", "scope:tools", "tools", "beads", "gate", "tdd"]
# rationale: >-
#   Enforces strict TDD, Scry markers, single-bead PR scope, and PII-free UI evidence.
# applies: running green-bar checks, gating commits and PRs, checking formulas
# seeded_questions:
#   - "How does pr-gate enforce TDD and UI PR media evidence?"
#   - "tools.sdlc_gate green-bar pr-gate"
# @scry.entry.end
"""Run deterministic SDLC gates for Beads, Scry, TDD, UI PR media, and Git hooks."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import tomllib
from pathlib import Path
from typing import Any, cast

import yaml

from tools.pii_guard import scan_paths, scan_text

REPO_ROOT = Path(__file__).resolve().parents[1]
BEADS_TRAILER_RE = re.compile(r"Beads-Issue:\s*([A-Za-z0-9][A-Za-z0-9._-]*)")
REVIEW_BLOCKER_LINE_RE = re.compile(r"^\s*Review-Blocker:(.*)$")
BEAD_ID_VALUE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

SCRY_REQUIRED_PREFIXES = ("src/", "tools/", "docs/", "sidecars/")
SCRY_REQUIRED_SUFFIXES = frozenset({".py", ".js", ".mjs", ".ts", ".md"})
SCRY_REQUIRED_KEYS = ("id", "kind", "summary", "status")
SCRY_DB_REL_PATH = Path("agent/drivers/@local/scry/data/project.db")

SCRY_ENTRY_START_RE = re.compile(r"^\s*(?:#|//|<!--)\s*@scry\.entry\b(?!\.end)(.*)$")
SCRY_ENTRY_END_RE = re.compile(r"^\s*(?:(?:#|//)\s*)?@scry\.entry\.end(?:\s*-->)?\s*$")
SCRY_PLACEHOLDER_TOKEN_RE = re.compile(r"\b(?:TBD|TODO|PLACEHOLDER|FIXME|XXX)\b", re.IGNORECASE)
PLACEHOLDER_SCRY_RE = re.compile(
    r"@scry\.(?:entry|bind|anchor)\b[^\n]*\b(?:TBD|TODO|PLACEHOLDER|FIXME|XXX)\b",
    re.IGNORECASE,
)

FORBIDDEN_STAGED_PREFIXES = (
    ".beads/dolt/",
    ".beads/embeddeddolt/",
    ".beads/proxieddb/",
    "agent/project.db",
    "agent/drivers/@local/scry/data/",
    "agent/drivers/@local/scry/runtime/",
)
PROTECTED_BRANCHES = frozenset({"main", "master"})
PROTECTED_REMOTE_REFS = frozenset({"refs/heads/main", "refs/heads/master"})
MERGE_COMMIT_RE = re.compile(r"^(?:Merge (?:branch|remote-tracking branch|pull request)|Revert |fixup! |squash! )")

PROD_CODE_PREFIXES = ("src/", "tools/", "sidecars/")
PROD_CODE_SUFFIXES = frozenset({".py", ".js", ".mjs", ".ts", ".html", ".css"})
TS_ONLY_DIRS = ("src", "sidecars", "tests/unit", "tests/e2e")
FORBIDDEN_PROJECT_SUFFIXES = frozenset({".py", ".js", ".mjs"})
UI_PATH_PREFIXES = ("src/ui/", "sidecars/")
UI_PATH_SUFFIXES = frozenset({".html", ".css", ".jsx", ".tsx"})
UI_MEDIA_RE = re.compile(
    r"(?:!\[[^\]]*\]\([^)]+\)|https?://\S+\.(?:png|jpe?g|webp|gif|webm|mp4)|"
    r"\b\S+\.(?:png|jpe?g|webp|gif|webm|mp4)\b|actions/runs/\d+)",
    re.IGNORECASE,
)
PII_ATTESTATION_TEXT = "Captured exclusively from the synthetic test environment (no local PII)"

FORMULA_SPECS: tuple[tuple[str, Path, list[str]], ...] = (
    ("session-start", Path(".beads/formulas/session-start.formula.json"), []),
    (
        "bead-worker",
        Path(".beads/formulas/bead-worker.formula.json"),
        [
            "--var",
            "bead_id=bv-sample-task",
            "--var",
            "branch=bead/bv-sample-task",
            "--var",
            "worktree_path=../worktrees/bv-sample-task",
        ],
    ),
    ("pre-push-verify", Path(".beads/formulas/pre-push-verify.formula.json"), []),
    (
        "merge-release",
        Path(".beads/formulas/merge-release.formula.json"),
        ["--var", "integration_branch=main", "--var", "pr_number=1"],
    ),
    (
        "feature-delivery",
        Path(".beads/formulas/feature-delivery.formula.toml"),
        ["--var", "bead_id=bv-sample-task", "--var", "branch=bead/bv-sample-task", "--var", "pr_number=1"],
    ),
    (
        "code-review",
        Path(".beads/formulas/code-review.formula.json"),
        ["--var", "bead_id=bv-sample-task", "--var", "base_ref=origin/main", "--var", "head_ref=HEAD"],
    ),
)


def find_bd_executable() -> str:
    """Find the Beads CLI executable on PATH or the default Windows folder."""
    found = shutil.which("bd")
    if found:
        return found
    candidate = Path.home() / "AppData" / "Local" / "Programs" / "bd" / "bd.exe"
    if candidate.is_file():
        return str(candidate)
    raise FileNotFoundError("bd executable not found.")


def _venv_tool(repo_root: Path, name: str) -> str:
    """Resolve a Python virtual environment tool across Windows and POSIX."""
    win_cand = repo_root / ".venv" / "Scripts" / f"{name}.exe"
    if win_cand.is_file():
        return str(win_cand)
    posix_cand = repo_root / ".venv" / "bin" / name
    if posix_cand.is_file():
        return str(posix_cand)
    if name == "python":
        return sys.executable
    return shutil.which(name) or name


def _run_step(args: list[str], cwd: Path, max_lines: int | None = 20) -> tuple[bool, str]:
    """Run one subprocess step and return pass status with output tail."""
    proc = subprocess.run(args, cwd=str(cwd), capture_output=True, text=True, check=False)
    combined = f"{proc.stdout}\n{proc.stderr}".strip()
    if max_lines is None:
        return proc.returncode == 0, combined
    tail = "\n".join(combined.splitlines()[-max_lines:])
    return proc.returncode == 0, tail


def _current_branch(repo_root: Path) -> str:
    """Return current checked-out Git branch name."""
    ok, out = _run_step(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=repo_root, max_lines=None)
    return out.strip() if ok else ""


def check_not_on_main_branch(repo_root: Path = REPO_ROOT) -> dict[str, Any]:
    """Reject direct commits on main unless BV_BOOTSTRAP_MAIN=1 is set."""
    if os.environ.get("BV_BOOTSTRAP_MAIN") == "1":
        return {"name": "not_on_main", "ok": True, "detail": "bootstrap override active"}
    branch = _current_branch(repo_root)
    ok = branch not in PROTECTED_BRANCHES
    detail = branch if ok else "Do not commit directly to main. Use a bead/<id> branch."
    return {"name": "not_on_main", "ok": ok, "detail": detail}


def check_no_push_to_main(
    repo_root: Path = REPO_ROOT,
    push_refs: list[str] | None = None,
) -> dict[str, Any]:
    """Reject direct pushes to main or master unless BV_BOOTSTRAP_MAIN=1 is set."""
    if os.environ.get("BV_BOOTSTRAP_MAIN") == "1":
        return {"name": "no_push_to_main", "ok": True, "detail": "bootstrap override active"}
    blocked = "Direct push to main is blocked. Open a pull request from a bead/<id> branch."
    if push_refs:
        for line in push_refs:
            parts = line.strip().split()
            if len(parts) >= 3 and parts[2] in PROTECTED_REMOTE_REFS:
                return {"name": "no_push_to_main", "ok": False, "detail": blocked}
        return {"name": "no_push_to_main", "ok": True, "detail": "ok"}
    branch = _current_branch(repo_root)
    if branch in PROTECTED_BRANCHES:
        return {"name": "no_push_to_main", "ok": False, "detail": blocked}
    return {"name": "no_push_to_main", "ok": True, "detail": branch or "detached"}


def check_language_policy(repo_root: Path = REPO_ROOT) -> dict[str, Any]:
    """Verify project directories contain zero .py, .js, or .mjs files."""
    violations: list[str] = []
    for rel_dir in TS_ONLY_DIRS:
        base = repo_root / rel_dir
        if not base.is_dir():
            continue
        for entry in sorted(base.rglob("*")):
            if entry.is_file() and entry.suffix.lower() in FORBIDDEN_PROJECT_SUFFIXES:
                violations.append(entry.relative_to(repo_root).as_posix())
    return {
        "name": "language_policy",
        "ok": len(violations) == 0,
        "detail": "clean" if not violations else ", ".join(violations),
    }


def check_no_forbidden_tracked(repo_root: Path = REPO_ROOT) -> dict[str, Any]:
    """Verify no Dolt store or runtime SQLite database files are tracked in Git."""
    ok_ls, raw_ls = _run_step(["git", "ls-files"], cwd=repo_root, max_lines=None)
    if not ok_ls:
        return {"name": "no_forbidden_tracked", "ok": False, "detail": raw_ls}
    tracked = [line.strip().replace("\\", "/") for line in raw_ls.splitlines() if line.strip()]
    forbidden = [
        path for path in tracked if any(path.lower().startswith(prefix) for prefix in FORBIDDEN_STAGED_PREFIXES)
    ]
    return {
        "name": "no_forbidden_tracked",
        "ok": len(forbidden) == 0,
        "detail": "clean" if not forbidden else ", ".join(forbidden),
    }


def _strip_scry_prefix(line: str) -> str:
    """Strip one leading # or // comment prefix from a Scry YAML line."""
    stripped = line.lstrip()
    if stripped.startswith("//"):
        body = stripped[2:]
    elif stripped.startswith("#"):
        body = stripped[1:]
    else:
        return line
    return body[1:] if body.startswith(" ") else body


def validate_scry_entry_content(
    content: str,
    rel_path: str,
    require_entry: bool = True,
) -> list[str]:
    """Validate @scry.entry YAML headers and unminted tokens in one file."""
    failures: list[str] = []
    if PLACEHOLDER_SCRY_RE.search(content):
        failures.append(f"unminted @scry marker in {rel_path}")

    lines = content.splitlines()
    blocks: list[tuple[bool, list[str]]] = []
    idx = 0
    while idx < len(lines):
        match = SCRY_ENTRY_START_RE.match(lines[idx])
        if not match:
            idx += 1
            continue
        trailing = match.group(1).strip()
        is_comment = lines[idx].lstrip().startswith(("#", "//"))
        end_idx = idx + 1
        while end_idx < len(lines) and not SCRY_ENTRY_END_RE.match(lines[end_idx]):
            end_idx += 1
        if end_idx >= len(lines):
            failures.append(f"unclosed @scry.entry block in {rel_path}")
            break
        if trailing:
            failures.append(f"malformed @scry.entry header line in {rel_path}")
        blocks.append((is_comment, lines[idx + 1 : end_idx]))
        idx = end_idx + 1

    if not blocks:
        if require_entry and not failures:
            failures.append(f"missing @scry.entry in {rel_path}")
        return failures

    for is_comment, inner_lines in blocks:
        if is_comment and any(line.strip() and not line.lstrip().startswith(("#", "//")) for line in inner_lines):
            failures.append(f"uncommented line inside @scry.entry block in {rel_path}")
            continue
        yaml_lines = [_strip_scry_prefix(line) for line in inner_lines] if is_comment else inner_lines
        yaml_text = "\n".join(yaml_lines)
        if SCRY_PLACEHOLDER_TOKEN_RE.search(yaml_text):
            failures.append(f"unminted token in @scry.entry in {rel_path}")
        try:
            parsed: Any = yaml.safe_load(yaml_text)
        except yaml.YAMLError as exc:
            failures.append(f"malformed @scry.entry YAML in {rel_path}: {exc}")
            continue
        if not isinstance(parsed, dict):
            failures.append(f"malformed @scry.entry YAML mapping in {rel_path}")
            continue
        mapping = cast(dict[str, Any], parsed)
        missing = [
            key
            for key in SCRY_REQUIRED_KEYS
            if not isinstance(mapping.get(key), str) or not str(mapping.get(key)).strip()
        ]
        if missing:
            failures.append(f"missing @scry.entry keys ({', '.join(missing)}) in {rel_path}")

    return failures


def validate_scry_paths(
    repo_root: Path,
    changed_paths: list[str],
    added_paths: set[str] | None = None,
) -> list[str]:
    """Validate @scry.entry headers on changed or added source and doc files."""
    added_set = added_paths or set()
    ordered = list(dict.fromkeys([*sorted(added_set), *changed_paths]))
    failures: list[str] = []
    for raw_path in ordered:
        rel_path = raw_path.strip().replace("\\", "/")
        if not rel_path or not rel_path.startswith(SCRY_REQUIRED_PREFIXES):
            continue
        target = repo_root / rel_path
        if target.name == "__init__.py" or target.suffix.lower() not in SCRY_REQUIRED_SUFFIXES:
            continue
        if not target.is_file():
            continue
        content = target.read_text(encoding="utf-8")
        failures.extend(validate_scry_entry_content(content, rel_path, require_entry=rel_path in added_set))
    return failures


def check_scry_db_hygiene(repo_root: Path = REPO_ROOT) -> dict[str, Any]:
    """Check local Scry SQLite health and warnings read-only."""
    db_path = repo_root / SCRY_DB_REL_PATH
    if not db_path.is_file():
        return {"name": "scry_hygiene", "ok": True, "detail": "skipped (project.db absent)"}
    try:
        uri = f"{db_path.resolve().as_uri()}?mode=ro"
        with contextlib.closing(sqlite3.connect(uri, uri=True)) as conn:
            quick_rows = conn.execute("PRAGMA quick_check").fetchall()
            if [str(r[0]) for r in quick_rows if r] != ["ok"]:
                return {"name": "scry_hygiene", "ok": False, "detail": "PRAGMA quick_check failed"}
            has_table = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scry__warning'"
            ).fetchone()
            if has_table is None:
                return {"name": "scry_hygiene", "ok": False, "detail": "Missing scry__warning table"}
            rows = conn.execute("SELECT kind, file_path, message FROM scry__warning ORDER BY id").fetchall()
    except (sqlite3.Error, OSError) as exc:
        return {"name": "scry_hygiene", "ok": False, "detail": f"Scry SQLite error: {exc}"}

    errors: list[str] = []
    info_count = 0
    for raw_kind, raw_path, raw_msg in rows:
        kind = str(raw_kind or "").strip()
        if kind == "misplaced_doc":
            info_count += 1
            continue
        errors.append(f"{kind} ({raw_path}): {raw_msg}")
    if errors:
        return {"name": "scry_hygiene", "ok": False, "detail": " | ".join(errors[:10])}
    return {"name": "scry_hygiene", "ok": True, "detail": f"ok (misplaced_doc_info={info_count})"}


def _parse_formula_document(formula_path: Path) -> Any:
    """Parse one .json or .toml formula file."""
    raw = formula_path.read_text(encoding="utf-8")
    if formula_path.suffix.lower() == ".toml":
        return tomllib.loads(raw)
    if formula_path.suffix.lower() == ".json":
        return json.loads(raw)
    raise ValueError(f"Unsupported formula extension: {formula_path.suffix}")


def validate_formula_files(repo_root: Path = REPO_ROOT) -> list[dict[str, Any]]:
    """Validate workflow formula JSON and TOML files."""
    checks: list[dict[str, Any]] = []
    for name, rel_path, _vars in FORMULA_SPECS:
        path = repo_root / rel_path
        if not path.is_file():
            checks.append({"name": f"formula:{name}", "ok": False, "detail": f"Missing {rel_path}"})
            continue
        try:
            data = _parse_formula_document(path)
        except (OSError, ValueError, json.JSONDecodeError, tomllib.TOMLDecodeError) as exc:
            checks.append({"name": f"formula:{name}", "ok": False, "detail": str(exc)})
            continue
        if not isinstance(data, dict) or data.get("formula") != name or not data.get("steps"):
            checks.append({"name": f"formula:{name}", "ok": False, "detail": "Invalid formula body"})
            continue
        checks.append({"name": f"formula:{name}", "ok": True, "detail": "ok"})
    return checks


def run_formula_check(repo_root: Path = REPO_ROOT, require_bd: bool = False) -> dict[str, Any]:
    """Validate formulas and run bd cook --dry-run when bd exists."""
    checks = validate_formula_files(repo_root=repo_root)
    try:
        bd_exe = find_bd_executable()
    except FileNotFoundError:
        checks.append(
            {
                "name": "formula:bd-cli",
                "ok": not require_bd,
                "detail": "bd not found" if require_bd else "bd absent; schema ok",
            }
        )
        return {"ok": all(bool(c["ok"]) for c in checks), "checks": checks}

    if all(bool(c["ok"]) for c in checks):
        cooked: list[dict[str, Any]] = []
        for name, rel_path, extra_vars in FORMULA_SPECS:
            ok, detail = _run_step(
                [bd_exe, "cook", rel_path.as_posix(), "--dry-run", *extra_vars],
                cwd=repo_root,
            )
            cooked.append({"name": f"formula:{name}", "ok": ok, "detail": "ok" if ok else detail})
        checks = cooked
    return {"ok": all(bool(c["ok"]) for c in checks), "checks": checks}


def evaluate_tdd_gate(changed_paths: list[str], pr_body: str = "") -> dict[str, Any]:
    """Verify production code edits include test file edits unless tdd-exempt."""
    if "tdd-exempt:" in pr_body.lower():
        return {"name": "tdd_gate", "ok": True, "detail": "explicitly exempt"}
    prod_changed = [
        p for p in changed_paths if p.startswith(PROD_CODE_PREFIXES) and Path(p).suffix.lower() in PROD_CODE_SUFFIXES
    ]
    if not prod_changed:
        return {"name": "tdd_gate", "ok": True, "detail": "no production code changed"}
    test_changed = [p for p in changed_paths if p.startswith("tests/")]
    if not test_changed:
        return {
            "name": "tdd_gate",
            "ok": False,
            "detail": f"Production code changed without tests: {', '.join(prod_changed[:5])}",
        }
    return {"name": "tdd_gate", "ok": True, "detail": f"{len(test_changed)} test files updated"}


def check_ui_pr_evidence(changed_paths: list[str], pr_body: str = "") -> dict[str, Any]:
    """Require synthetic UI media evidence and PII attestation when UI files change."""
    ui_changed = [
        p for p in changed_paths if p.startswith(UI_PATH_PREFIXES) or Path(p).suffix.lower() in UI_PATH_SUFFIXES
    ]
    if not ui_changed:
        return {"name": "ui_pr_evidence", "ok": True, "detail": "no UI files changed"}
    if "## UI Evidence" not in pr_body:
        return {
            "name": "ui_pr_evidence",
            "ok": False,
            "detail": "UI files changed. Add a '## UI Evidence' section to the PR body.",
        }
    if not UI_MEDIA_RE.search(pr_body):
        return {
            "name": "ui_pr_evidence",
            "ok": False,
            "detail": "UI files changed. Link a screenshot or video in '## UI Evidence'.",
        }
    if PII_ATTESTATION_TEXT not in pr_body:
        return {
            "name": "ui_pr_evidence",
            "ok": False,
            "detail": f"Include the attestation: '{PII_ATTESTATION_TEXT}'.",
        }
    return {"name": "ui_pr_evidence", "ok": True, "detail": f"verified ({len(ui_changed)} UI files)"}


def check_single_bead_scope(
    repo_root: Path = REPO_ROOT,
    base_ref: str = "origin/main",
    head_ref: str = "HEAD",
    pr_body: str = "",
) -> dict[str, Any]:
    """Verify commits ahead of base_ref and PR body cite at most one Beads-Issue ID."""
    pr_ids = BEADS_TRAILER_RE.findall(pr_body)
    ok_log, log_out = _run_step(
        ["git", "log", "--no-merges", "--format=%H%x1f%B%x1e", f"{base_ref}..{head_ref}"],
        cwd=repo_root,
        max_lines=None,
    )
    if not ok_log:
        return {"name": "single_bead_scope", "ok": False, "detail": log_out}
    found: set[str] = set(pr_ids)
    commits = 0
    for rec in log_out.split("\x1e"):
        stripped = rec.strip()
        if not stripped or "\x1f" not in stripped:
            continue
        commits += 1
        _sha, body = stripped.split("\x1f", 1)
        found.update(BEADS_TRAILER_RE.findall(body))
    if len(found) > 1:
        return {
            "name": "single_bead_scope",
            "ok": False,
            "detail": f"Multiple Beads-Issue IDs (max 1): {', '.join(sorted(found))}",
        }
    if commits > 0 and len(found) == 0:
        return {
            "name": "single_bead_scope",
            "ok": False,
            "detail": f"Missing Beads-Issue trailer ahead of {base_ref}",
        }
    return {
        "name": "single_bead_scope",
        "ok": True,
        "detail": sorted(found)[0] if found else "no commits in range",
    }


def run_git_commit_msg(msg_file: Path, repo_root: Path = REPO_ROOT) -> dict[str, Any]:
    """Verify commit message trailers for non-merge commits."""
    raw = msg_file.read_text(encoding="utf-8")
    cleaned = "\n".join(line for line in raw.splitlines() if not line.lstrip().startswith("#")).strip()
    is_merge = bool(MERGE_COMMIT_RE.match(cleaned)) or (repo_root / ".git" / "MERGE_HEAD").is_file()
    if is_merge:
        return {"ok": True, "checks": [{"name": "beads_trailer", "ok": True, "detail": "merge"}]}
    unique_ids = sorted(set(BEADS_TRAILER_RE.findall(cleaned)))
    has_single = len(unique_ids) == 1
    invalid_blockers: list[str] = []
    for line in cleaned.splitlines():
        match = REVIEW_BLOCKER_LINE_RE.match(line)
        if match:
            val = match.group(1).strip()
            if not val or ".." in val or not BEAD_ID_VALUE_RE.match(val):
                invalid_blockers.append(line.strip())
    return {
        "ok": has_single and not invalid_blockers,
        "checks": [
            {
                "name": "beads_trailer",
                "ok": has_single,
                "detail": "ok" if has_single else "Require exactly one Beads-Issue: <id> trailer.",
            },
            {
                "name": "review_blocker",
                "ok": not invalid_blockers,
                "detail": "ok" if not invalid_blockers else ", ".join(invalid_blockers),
            },
        ],
    }


def run_git_pre_commit(repo_root: Path = REPO_ROOT) -> dict[str, Any]:
    """Run fast staged checks for the Git pre-commit hook."""
    checks: list[dict[str, Any]] = [
        check_not_on_main_branch(repo_root=repo_root),
        check_no_forbidden_tracked(repo_root=repo_root),
        check_language_policy(repo_root=repo_root),
        check_scry_db_hygiene(repo_root=repo_root),
    ]
    ok_st, st_raw = _run_step(["git", "diff", "--cached", "--name-only"], cwd=repo_root, max_lines=None)
    staged = [line.strip().replace("\\", "/") for line in st_raw.splitlines() if line.strip()]
    forbidden = [p for p in staged if any(p.lower().startswith(pref) for pref in FORBIDDEN_STAGED_PREFIXES)]
    checks.append(
        {
            "name": "no_forbidden_staged",
            "ok": ok_st and not forbidden,
            "detail": "clean" if not forbidden else ", ".join(forbidden),
        }
    )

    ok_add, add_raw = _run_step(
        ["git", "diff", "--cached", "--diff-filter=A", "--name-only"], cwd=repo_root, max_lines=None
    )
    added = {line.strip().replace("\\", "/") for line in add_raw.splitlines() if line.strip()}
    scry_failures = validate_scry_paths(repo_root, staged, added_paths=added) if ok_st and ok_add else []
    checks.append(
        {
            "name": "scry_markers",
            "ok": ok_st and ok_add and not scry_failures,
            "detail": "ok" if not scry_failures else ", ".join(scry_failures),
        }
    )

    py_staged = [p for p in staged if p.endswith(".py") and (repo_root / p).is_file()]
    if py_staged:
        ruff_exe = _venv_tool(repo_root, "ruff")
        ok_ruff, ruff_out = _run_step([ruff_exe, "check", *py_staged], cwd=repo_root)
        checks.append({"name": "ruff", "ok": ok_ruff, "detail": "passed" if ok_ruff else ruff_out})
    return {"ok": all(bool(c["ok"]) for c in checks), "checks": checks}


def run_git_pre_push(
    repo_root: Path = REPO_ROOT,
    push_refs: list[str] | None = None,
) -> dict[str, Any]:
    """Run thorough checks for the Git pre-push hook."""
    py_exe = _venv_tool(repo_root, "python")
    checks: list[dict[str, Any]] = [
        check_no_push_to_main(repo_root=repo_root, push_refs=push_refs),
        check_no_forbidden_tracked(repo_root=repo_root),
        check_scry_db_hygiene(repo_root=repo_root),
    ]
    ok_ref, _ = _run_step(["git", "rev-parse", "--verify", "origin/main"], cwd=repo_root)
    if ok_ref:
        ok_merge, merge_out = _run_step(["git", "merge-tree", "--write-tree", "HEAD", "origin/main"], cwd=repo_root)
        checks.append(
            {
                "name": "merge_clean_with_main",
                "ok": ok_merge,
                "detail": "clean" if ok_merge else merge_out,
            }
        )
        checks.append(check_single_bead_scope(repo_root=repo_root))
    ok_py, py_out = _run_step([py_exe, "-m", "pytest", "tests/python/"], cwd=repo_root)
    checks.append({"name": "pytest", "ok": ok_py, "detail": "passed" if ok_py else py_out})
    if (repo_root / "tsconfig.json").is_file():
        npm_exe = shutil.which("npm") or "npm"
        ok_tc, tc_out = _run_step([npm_exe, "run", "typecheck"], cwd=repo_root)
        checks.append({"name": "typecheck", "ok": ok_tc, "detail": "passed" if ok_tc else tc_out})
    return {"ok": all(bool(c["ok"]) for c in checks), "checks": checks}


def run_pr_gate(
    repo_root: Path = REPO_ROOT,
    base_ref: str = "origin/main",
    head_ref: str = "HEAD",
    pr_body: str = "",
    verify_beads_exist: bool = False,
    require_bd: bool = False,
) -> dict[str, Any]:
    """Run CI pull request gate for Beads, Scry, TDD, UI evidence, and PII."""
    checks: list[dict[str, Any]] = [
        check_no_forbidden_tracked(repo_root=repo_root),
        check_language_policy(repo_root=repo_root),
        check_scry_db_hygiene(repo_root=repo_root),
    ]
    scope = check_single_bead_scope(repo_root, base_ref, head_ref, pr_body)
    checks.append(scope)

    if verify_beads_exist and scope.get("ok") and scope.get("detail") != "no commits in range":
        bead_id = str(scope["detail"])
        bd_exe = find_bd_executable()
        ok_bd, bd_out = _run_step([bd_exe, "show", bead_id, "--json"], cwd=repo_root)
        checks.append(
            {
                "name": "bead_exists",
                "ok": ok_bd,
                "detail": bead_id if ok_bd else bd_out,
            }
        )

    ok_diff, diff_out = _run_step(
        ["git", "diff", "--name-only", f"{base_ref}...{head_ref}"], cwd=repo_root, max_lines=None
    )
    changed = [line.strip().replace("\\", "/") for line in diff_out.splitlines() if line.strip()]
    ok_add, add_out = _run_step(
        ["git", "diff", "--diff-filter=A", "--name-only", f"{base_ref}...{head_ref}"],
        cwd=repo_root,
        max_lines=None,
    )
    added = {line.strip().replace("\\", "/") for line in add_out.splitlines() if line.strip()}

    scry_failures = validate_scry_paths(repo_root, changed, added_paths=added) if ok_diff and ok_add else []
    checks.append(
        {
            "name": "scry_markers",
            "ok": ok_diff and ok_add and not scry_failures,
            "detail": "ok" if not scry_failures else ", ".join(scry_failures),
        }
    )
    checks.append(evaluate_tdd_gate(changed, pr_body))
    checks.append(check_ui_pr_evidence(changed, pr_body))

    pii_paths = [repo_root / p for p in changed if (repo_root / p).is_file()]
    ok_pii, pii_findings = scan_paths(pii_paths)
    pr_pii = scan_text(pr_body, "PR_BODY") if pr_body else []
    all_pii = pii_findings + pr_pii
    checks.append(
        {
            "name": "pii_guard",
            "ok": ok_pii and not pr_pii,
            "detail": "clean" if not all_pii else json.dumps(all_pii[:5]),
        }
    )
    formula_res = run_formula_check(repo_root=repo_root, require_bd=require_bd)
    checks.append(
        {
            "name": "formulas",
            "ok": bool(formula_res["ok"]),
            "detail": "ok" if formula_res["ok"] else json.dumps(formula_res["checks"]),
        }
    )
    return {"ok": all(bool(c["ok"]) for c in checks), "checks": checks}


def run_green_bar(repo_root: Path = REPO_ROOT, skip_bd: bool = False) -> dict[str, Any]:
    """Run all local green-bar verification checks."""
    py_exe = _venv_tool(repo_root, "python")
    ruff_exe = _venv_tool(repo_root, "ruff")
    checks: list[dict[str, Any]] = [
        check_no_forbidden_tracked(repo_root),
        check_language_policy(repo_root),
        check_scry_db_hygiene(repo_root),
    ]
    ok_ruff, ruff_out = _run_step([ruff_exe, "check", "tools/", "tests/python/", ".agents/hooks/"], cwd=repo_root)
    checks.append({"name": "ruff", "ok": ok_ruff, "detail": "passed" if ok_ruff else ruff_out})

    ok_py, py_out = _run_step([py_exe, "-m", "pytest", "tests/python/"], cwd=repo_root)
    checks.append({"name": "pytest", "ok": ok_py, "detail": "passed" if ok_py else py_out})

    if (repo_root / "tsconfig.json").is_file():
        npm_exe = shutil.which("npm") or "npm"
        ok_tc, tc_out = _run_step([npm_exe, "run", "typecheck"], cwd=repo_root)
        checks.append({"name": "typecheck", "ok": ok_tc, "detail": "passed" if ok_tc else tc_out})

    if (repo_root / "package.json").is_file():
        npm_exe = shutil.which("npm") or "npm"
        ok_unit, unit_out = _run_step([npm_exe, "run", "test:unit"], cwd=repo_root)
        checks.append({"name": "npm_unit", "ok": ok_unit, "detail": "passed" if ok_unit else unit_out})

    if not skip_bd:
        bd_exe = find_bd_executable()
        ok_bd, bd_out = _run_step([bd_exe, "doctor", "--check=validate", "--json"], cwd=repo_root, max_lines=None)
        overall = False
        if ok_bd and bd_out:
            try:
                overall = json.loads(bd_out).get("overall_ok") is True
            except json.JSONDecodeError:
                overall = False
        checks.append({"name": "bd_validate", "ok": ok_bd and overall, "detail": "ok" if overall else bd_out})

    formula_res = run_formula_check(repo_root=repo_root, require_bd=not skip_bd)
    checks.append(
        {
            "name": "formulas",
            "ok": bool(formula_res["ok"]),
            "detail": "ok" if formula_res["ok"] else json.dumps(formula_res["checks"]),
        }
    )
    return {"ok": all(bool(c["ok"]) for c in checks), "checks": checks}


def check_pr_ready(pr_number: str, repo_root: Path = REPO_ROOT, wait_seconds: int = 0) -> dict[str, Any]:
    """Poll gh pr view until a pull request is non-draft, conflict-free, and green."""
    pr_str = str(pr_number).strip().lstrip("#")
    start = time.monotonic()
    while True:
        ok_gh, raw = _run_step(
            ["gh", "pr", "view", pr_str, "--json", "state,isDraft,mergeable,statusCheckRollup"],
            cwd=repo_root,
            max_lines=None,
        )
        if not ok_gh:
            return {"ok": False, "pr_number": pr_str, "detail": raw}
        data = json.loads(raw)
        items = data.get("statusCheckRollup") or []
        failing = [
            str(i.get("name") or i.get("context"))
            for i in items
            if str(i.get("conclusion") or "").upper() in {"FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"}
        ]
        pending = [
            str(i.get("name") or i.get("context")) for i in items if str(i.get("status") or "").upper() != "COMPLETED"
        ]
        if (
            data.get("state") == "OPEN"
            and not data.get("isDraft")
            and data.get("mergeable") == "MERGEABLE"
            and not failing
            and items
            and not pending
        ):
            return {"ok": True, "pr_number": pr_str, "state": data.get("state")}
        if failing or wait_seconds <= 0 or (time.monotonic() - start) >= wait_seconds:
            return {
                "ok": False,
                "pr_number": pr_str,
                "failing": failing,
                "pending": pending,
                "mergeable": data.get("mergeable"),
            }
        time.sleep(10)


def main(argv: list[str] | None = None) -> int:
    """Run CLI subcommands for tools.sdlc_gate."""
    parser = argparse.ArgumentParser(description="Run SDLC verification gates.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_gb = sub.add_parser("green-bar")
    p_gb.add_argument("--skip-bd-validate", action="store_true")

    p_fc = sub.add_parser("formula-check")
    p_fc.add_argument("--require-bd", action="store_true")

    p_pr = sub.add_parser("pr-gate")
    p_pr.add_argument("--base-ref", default="origin/main")
    p_pr.add_argument("--head-ref", default="HEAD")
    p_pr.add_argument("--pr-body", default=None)
    p_pr.add_argument("--verify-beads-exist", action="store_true")
    p_pr.add_argument("--require-bd", action="store_true")

    p_gpc = sub.add_parser("git-pre-commit")
    p_gpc.add_argument("--repo-root", type=Path, default=REPO_ROOT)

    p_gcm = sub.add_parser("git-commit-msg")
    p_gcm.add_argument("msg_file", type=Path)
    p_gcm.add_argument("--repo-root", type=Path, default=REPO_ROOT)

    p_gpp = sub.add_parser("git-pre-push")
    p_gpp.add_argument("--repo-root", type=Path, default=REPO_ROOT)
    p_gpp.add_argument("--read-stdin", action="store_true")

    p_ready = sub.add_parser("pr-ready")
    p_ready.add_argument("pr_number")
    p_ready.add_argument("--wait", action="store_true")

    sub.add_parser("no-forbidden-tracked")
    p_scry = sub.add_parser("scry-hygiene")
    p_scry.add_argument("--repo-root", type=Path, default=REPO_ROOT)

    args = parser.parse_args(argv)
    if args.command == "green-bar":
        res = run_green_bar(skip_bd=args.skip_bd_validate)
    elif args.command == "formula-check":
        res = run_formula_check(require_bd=args.require_bd)
    elif args.command == "pr-gate":
        body = args.pr_body if args.pr_body is not None else os.environ.get("PR_BODY", "")
        res = run_pr_gate(REPO_ROOT, args.base_ref, args.head_ref, body, args.verify_beads_exist, args.require_bd)
    elif args.command == "git-pre-commit":
        res = run_git_pre_commit(args.repo_root.resolve())
    elif args.command == "git-commit-msg":
        res = run_git_commit_msg(args.msg_file, args.repo_root.resolve())
    elif args.command == "git-pre-push":
        refs = sys.stdin.read().splitlines() if args.read_stdin else None
        res = run_git_pre_push(args.repo_root.resolve(), push_refs=refs)
    elif args.command == "pr-ready":
        res = check_pr_ready(args.pr_number, wait_seconds=300 if args.wait else 0)
    elif args.command == "no-forbidden-tracked":
        chk = check_no_forbidden_tracked()
        res = {"ok": bool(chk["ok"]), "checks": [chk]}
    elif args.command == "scry-hygiene":
        chk = check_scry_db_hygiene(args.repo_root.resolve())
        res = {"ok": bool(chk["ok"]), "checks": [chk]}
    else:
        raise ValueError(f"Unsupported command: {args.command}")

    sys.stdout.write(json.dumps(res, indent=2) + "\n")
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
