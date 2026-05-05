"""Unit tests for camofox.domain.snapshot — no browser needed."""

from __future__ import annotations

from typing import Any

import pytest

from camofox.domain.snapshot import (
    ACTIONABLE_ROLES,
    INTERACTIVE_ROLES,
    MAX_SNAPSHOT_CHARS,
    SNAPSHOT_TAIL_CHARS,
    _compact_object,
    _is_interactive_role,
    _normalize_tag_name,
    _safe_attributes,
    _safe_text,
    _should_skip_name,
    compact_snapshot,
    filter_snapshot_dialog_artifacts,
    safe_node_metadata,
    window_snapshot,
)


# ===================================================================
# _normalize_tag_name
# ===================================================================


class TestNormalizeTagName:
    def test_lowercases(self):
        assert _normalize_tag_name("DIV") == "div"

    def test_strips_whitespace(self):
        assert _normalize_tag_name("  BUTTON  ") == "button"

    def test_extracts_first_tag(self):
        assert _normalize_tag_name("span.bold") == "span"

    def test_returns_empty_for_garbage(self):
        assert _normalize_tag_name("") == ""
        assert _normalize_tag_name(None) == ""
        assert _normalize_tag_name("123abc") == ""


# ===================================================================
# _safe_text
# ===================================================================


class TestSafeText:
    def test_normalizes_whitespace(self):
        assert _safe_text("hello   world") == "hello world"

    def test_lowercases(self):
        assert _safe_text("Hello World") == "hello world"

    def test_preserves_case(self):
        assert _safe_text("Hello World", preserve_case=True) == "Hello World"

    def test_redacts_sensitive(self):
        assert _safe_text("my password is secret") == ""
        assert _safe_text("API_KEY=12345") == ""

    def test_truncates(self):
        long = "x" * 300
        result = _safe_text(long)
        assert len(result) == 160

    def test_empty(self):
        assert _safe_text("") == ""
        assert _safe_text(None) == ""


# ===================================================================
# _safe_attributes
# ===================================================================


class TestSafeAttributes:
    def test_keeps_safe_attrs(self):
        attrs = {"id": "main", "class": "container", "href": "https://x.com"}
        result = _safe_attributes(attrs)
        assert result["id"] == "main"
        assert result["class"] == "container"
        assert result["href"] == "https://x.com"

    def test_skips_unknown_attrs(self):
        attrs = {"style": "display:none", "onclick": "evil()"}
        result = _safe_attributes(attrs)
        assert "style" not in result
        assert "onclick" not in result

    def test_redacts_sensitive(self):
        attrs = {"id": "login", "placeholder": "enter password"}
        result = _safe_attributes(attrs)
        assert "placeholder" not in result

    def test_skips_none_values(self):
        attrs = {"id": None, "class": "foo"}
        result = _safe_attributes(attrs)
        assert "id" not in result

    def test_empty(self):
        assert _safe_attributes({}) == {}
        assert _safe_attributes(None) == {}


# ===================================================================
# _compact_object
# ===================================================================


class TestCompactObject:
    def test_removes_none(self):
        assert _compact_object({"a": 1, "b": None}) == {"a": 1}

    def test_removes_empty_list(self):
        assert _compact_object({"a": [], "b": [1]}) == {"b": [1]}

    def test_removes_empty_dict(self):
        assert _compact_object({"a": {}, "b": {"c": 1}}) == {"b": {"c": 1}}

    def test_removes_empty_string(self):
        assert _compact_object({"a": "", "b": "x"}) == {"b": "x"}

    def test_keeps_falsy_non_empty(self):
        assert _compact_object({"a": 0, "b": False}) == {"a": 0, "b": False}


# ===================================================================
# _is_interactive_role / _should_skip_name
# ===================================================================


class TestInteractiveRole:
    def test_known_interactive(self):
        for role in ("button", "link", "textbox", "checkbox"):
            assert _is_interactive_role(role)
        assert _is_interactive_role("BUTTON")
        assert _is_interactive_role("Link")

    def test_non_interactive(self):
        assert not _is_interactive_role("heading")
        assert not _is_interactive_role("div")
        assert not _is_interactive_role("paragraph")


class TestShouldSkipName:
    def test_date_patterns(self):
        assert _should_skip_name("date of birth")
        assert _should_skip_name("calendar picker")
        assert _should_skip_name("DatePicker")

    def test_clean_names(self):
        assert not _should_skip_name("submit")
        assert not _should_skip_name("search")
        assert not _should_skip_name("")


# ===================================================================
# window_snapshot
# ===================================================================


class TestWindowSnapshot:
    def test_empty(self):
        result = window_snapshot("")
        assert result["text"] == ""
        assert not result["truncated"]

    def test_small_fits(self):
        text = "hello\nworld"
        result = window_snapshot(text)
        assert result["text"] == text
        assert not result["truncated"]

    def test_truncated(self, monkeypatch):
        monkeypatch.setattr("camofox.domain.snapshot.MAX_SNAPSHOT_CHARS", 50)
        monkeypatch.setattr("camofox.domain.snapshot.SNAPSHOT_TAIL_CHARS", 10)
        text = "a" * 30 + "\n" + "b" * 30 + "\n" + "c" * 30
        result = window_snapshot(text)
        assert result["truncated"]
        assert result["has_more"]
        assert result["next_offset"] is not None

    def test_offset_zero_by_default(self):
        text = "line1\nline2\nline3"
        result = window_snapshot(text)
        assert result["offset"] == 0


# ===================================================================
# compact_snapshot
# ===================================================================


class TestCompactSnapshot:
    def test_empty(self):
        assert compact_snapshot("") == ""

    def test_keeps_actionable_roles(self, sample_yaml: str):
        compact = compact_snapshot(sample_yaml)
        # Should keep heading, link, button lines
        assert "#3|h1|heading|hello" in compact
        assert "#6|a|link|click me" in compact
        # Should NOT keep the generic body/div lines
        assert "#1|body|body|" not in compact

    def test_keeps_ref_lines(self):
        yaml = "#1|div|div|stuff\n#2|a|link|go|||e1\n#3|p|p|text"
        compact = compact_snapshot(yaml)
        assert "#2|a|link|go|||e1" in compact
        assert "#1|div|div|stuff" not in compact


# ===================================================================
# filter_snapshot_dialog_artifacts
# ===================================================================


class TestFilterDialogArtifacts:
    def test_no_cookie_keywords_returns_unchanged(self):
        yaml = "#1|div|div|hello world"
        assert filter_snapshot_dialog_artifacts(yaml) == yaml

    def test_removes_dialog_block_on_cookie(self):
        yaml = (
            "#1|div|dialog|cookie banner|\n"
            "  #2|button|button|accept\n"
            "#3|div|main|content"
        )
        filtered = filter_snapshot_dialog_artifacts(yaml)
        assert "#1|div|dialog|cookie banner" not in filtered
        assert "#3|div|main|content" in filtered

    def test_keeps_accepted_dialog(self):
        yaml = (
            "#1|div|dialog|se connecter|\n"
            "  #2|button|button|login"
        )
        filtered = filter_snapshot_dialog_artifacts(
            yaml, accepted_dialog_names=["Se connecter"]
        )
        assert "#1|div|dialog|se connecter" in filtered

    def test_custom_keywords(self):
        yaml = "#1|div|dialog|my banner|\n#2|p|p|text"
        filtered = filter_snapshot_dialog_artifacts(
            yaml, cookie_banner_keywords=["my banner"]
        )
        assert "#1|div|dialog|my banner" not in filtered


# ===================================================================
# safe_node_metadata
# ===================================================================


class TestSafeNodeMetadata:
    def test_extracts_known_fields(self):
        node = {
            "role": "button",
            "name": "Submit",
            "tag": "button",
            "value": "",
        }
        meta = safe_node_metadata(node)
        assert meta["role"] == "button"
        assert meta["name"] == "Submit"
        assert meta["tag"] == "button"

    def test_empty_for_hidden(self):
        node = {"tag": "input", "type": "hidden"}
        assert safe_node_metadata(node) == {}

    def test_empty_for_none(self):
        assert safe_node_metadata({}) == {}
        assert safe_node_metadata(None) == {}


# ===================================================================
# Constants sanity
# ===================================================================


class TestConstants:
    def test_interactive_is_subset_of_actionable(self):
        for role in INTERACTIVE_ROLES:
            assert role in ACTIONABLE_ROLES, (
                f"{role} in INTERACTIVE_ROLES but not in ACTIONABLE_ROLES"
            )

    def test_max_chars_sane(self):
        assert 10000 <= MAX_SNAPSHOT_CHARS <= 200000
        assert SNAPSHOT_TAIL_CHARS < MAX_SNAPSHOT_CHARS


# ===================================================================
# Fixtures
# ===================================================================


@pytest.fixture
def sample_yaml() -> str:
    return (
        "#1|body|body|hello world|\n"
        "  #2|div|div|section|\n"
        "    #3|h1|heading|hello|\n"
        "    #4|p|paragraph|some text|\n"
        "    #5|div|div|wrapper|\n"
        "      #6|a|link|click me|||e1\n"
        "      #7|button|button|submit|||e2"
    )
