"""Unit tests for tools.beads_lifecycle."""

from __future__ import annotations

from tools.beads_lifecycle import is_valid_slug_id, mint_slug_id


def test_mint_slug_id_produces_valid_bv_prefix() -> None:
    """Verify minted IDs use bv-<domain>-<slug> format within 48 chars."""
    bead_id = mint_slug_id("ui", "Build Nested Epic Tree & Inspector!")
    assert bead_id.startswith("bv-ui-")
    assert len(bead_id) <= 48
    assert is_valid_slug_id(bead_id) is True


def test_is_valid_slug_id_rejects_invalid_ids() -> None:
    """Verify invalid prefixes, uppercase, and short IDs fail validation."""
    assert is_valid_slug_id("bv-ui-epic-tree") is True
    assert is_valid_slug_id("other-ui-epic-tree") is False
    assert is_valid_slug_id("bv-onlytwo") is False
    assert is_valid_slug_id("bv-UI-upper") is False
    assert is_valid_slug_id("bv-a-" + ("x" * 50)) is False
