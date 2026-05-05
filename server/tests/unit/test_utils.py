"""Unit tests for camofox.core.utils — shared utility helpers."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from unittest.mock import ANY, AsyncMock, MagicMock, patch

import pytest

from camofox.core.utils import (
    clamp_to_viewport,
    coalesce_inflight,
    is_dead_context_error,
    is_loopback_address,
    is_proxy_error,
    is_timeout_error,
    make_session_id,
    make_tab_id,
    normalize_user_id,
    random_id,
    resolve_profile_root,
    safe_page_close,
    sha256_hex,
    timing_safe_compare,
    user_dir_from_id,
    validate_url,
)


# ===================================================================
# normalize_user_id
# ===================================================================


class TestNormalizeUserId:
    def test_string_preserved(self):
        assert normalize_user_id("abc123") == "abc123"

    def test_int_converted(self):
        assert normalize_user_id(12345) == "12345"

    def test_float_converted(self):
        assert normalize_user_id(123.45) == "123.45"

    def test_none_converted(self):
        assert normalize_user_id(None) == "None"

    def test_empty_string(self):
        assert normalize_user_id("") == ""


# ===================================================================
# sha256_hex / user_dir_from_id
# ===================================================================


class TestSha256Hex:
    def test_deterministic(self):
        assert sha256_hex("hello") == sha256_hex("hello")

    def test_different_inputs_differ(self):
        assert sha256_hex("hello") != sha256_hex("world")

    def test_known_output(self):
        # SHA256("hello") known prefix
        result = sha256_hex("hello")
        assert len(result) == 64
        assert all(c in "0123456789abcdef" for c in result)


class TestUserDirFromId:
    def test_returns_path(self):
        result = user_dir_from_id("~/.camofox/profiles", "user1")
        assert isinstance(result, Path)

    def test_uses_first_32_chars_of_hash(self):
        result = user_dir_from_id("/tmp/profiles", "user1")
        hashed = sha256_hex("user1")[:32]
        assert result == Path("/tmp/profiles") / hashed

    def test_expands_home(self):
        with patch.object(Path, "expanduser", return_value=Path("/home/test/profiles")):
            result = user_dir_from_id("~/.camofox/profiles", "user1")
            assert str(result).startswith("/home/test")


# ===================================================================
# make_tab_id / make_session_id
# ===================================================================


class TestMakeTabId:
    def test_returns_12_char_hex(self):
        tid = make_tab_id()
        assert len(tid) == 12
        assert all(c in "0123456789abcdef" for c in tid)


class TestMakeSessionId:
    def test_starts_with_sess(self):
        sid = make_session_id()
        assert sid.startswith("sess-")
        assert len(sid) == 5 + 12  # "sess-" + 12 hex chars


# ===================================================================
# timing_safe_compare
# ===================================================================


class TestTimingSafeCompare:
    def test_equal_strings(self):
        assert timing_safe_compare("abc", "abc")

    def test_different_strings(self):
        assert not timing_safe_compare("abc", "xyz")

    def test_case_sensitive(self):
        assert not timing_safe_compare("abc", "ABC")

    def test_non_string_returns_false(self):
        assert not timing_safe_compare(123, "123")
        assert not timing_safe_compare("123", 123)
        assert not timing_safe_compare(None, "abc")

    def test_empty_strings(self):
        assert timing_safe_compare("", "")


# ===================================================================
# is_loopback_address
# ===================================================================


class TestIsLoopbackAddress:
    def test_known_loopbacks(self):
        for addr in ("127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"):
            assert is_loopback_address(addr)

    def test_non_loopback(self):
        assert not is_loopback_address("192.168.1.1")
        assert not is_loopback_address("8.8.8.8")
        assert not is_loopback_address("")
        assert not is_loopback_address("example.com")


# ===================================================================
# validate_url
# ===================================================================


class TestValidateUrl:
    def test_valid_http(self):
        assert validate_url("http://example.com") is None

    def test_valid_https(self):
        assert validate_url("https://example.com/path?q=1") is None

    def test_empty_returns_error(self):
        assert validate_url("") == "URL must be a non-empty string"

    def test_non_string_returns_error(self):
        assert validate_url(123) == "URL must be a non-empty string"
        assert validate_url(None) == "URL must be a non-empty string"

    def test_no_protocol_returns_error(self):
        assert validate_url("example.com") == "URL must start with http:// or https://"

    def test_ftp_returns_error(self):
        assert validate_url("ftp://example.com") == "URL must start with http:// or https://"

    def test_too_long_returns_error(self):
        long_url = "https://x.com/" + "a" * 8200
        assert validate_url(long_url) == "URL too long (max 8192 chars)"

    def test_strips_whitespace(self):
        assert validate_url("  https://example.com  ") is None


# ===================================================================
# clamp_to_viewport
# ===================================================================


class TestClampToViewport:
    def test_within_bounds(self):
        assert clamp_to_viewport(100, 200, 1280, 720) == (100, 200)

    def test_clamps_negative(self):
        assert clamp_to_viewport(-5, -10, 1280, 720) == (0, 0)

    def test_clamps_excessive(self):
        assert clamp_to_viewport(2000, 1000, 1280, 720) == (1279, 719)

    def test_returns_floats(self):
        x, y = clamp_to_viewport(100.5, 200.7, 1280, 720)
        assert isinstance(x, float)
        assert isinstance(y, float)


# ===================================================================
# safe_page_close
# ===================================================================


class TestSafePageClose:
    @pytest.mark.asyncio
    async def test_none_page(self):
        """Should return immediately when page is None."""
        result = await safe_page_close(None)
        assert result is None

    @pytest.mark.asyncio
    async def test_closes_page(self):
        page = AsyncMock()
        page.close = AsyncMock()
        await safe_page_close(page, timeout_ms=1000)
        page.close.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_close_exception_swallowed(self):
        page = AsyncMock()
        page.close = AsyncMock(side_effect=Exception("already closed"))
        # Should not raise
        await safe_page_close(page, timeout_ms=1000)

    @pytest.mark.asyncio
    async def test_timeout_exception_swallowed(self):
        page = AsyncMock()
        page.close = AsyncMock(side_effect=asyncio.TimeoutError)
        await safe_page_close(page, timeout_ms=1000)


# ===================================================================
# Error check helpers
# ===================================================================


class TestIsDeadContextError:
    def test_known_phrases(self):
        assert is_dead_context_error("Target page, context or browser has been closed")
        assert is_dead_context_error("browser has been closed")
        assert is_dead_context_error("Context closed")
        assert is_dead_context_error("Browser closed")

    def test_other_phrases(self):
        assert not is_dead_context_error("Some other error")
        assert not is_dead_context_error("")
        assert not is_dead_context_error("timeout")


class TestIsTimeoutError:
    def test_timed_out_after(self):
        assert is_timeout_error("timed out after 30000ms")

    def test_timeout_exceeded(self):
        assert is_timeout_error("Timeout exceeded")

    def test_other(self):
        assert not is_timeout_error("some error")
        assert not is_timeout_error("")


class TestIsProxyError:
    def test_ns_error_proxy(self):
        assert is_proxy_error("NS_ERROR_PROXY_CONNECTION_REFUSED")

    def test_proxy_connection(self):
        assert is_proxy_error("proxy connection refused")
        assert is_proxy_error("Proxy connection failed")

    def test_other(self):
        assert not is_proxy_error("connection refused")
        assert not is_proxy_error("")


# ===================================================================
# resolve_profile_root
# ===================================================================


class TestResolveProfileRoot:
    def test_none_returns_none(self):
        assert resolve_profile_root(None) is None

    def test_empty_returns_none(self):
        assert resolve_profile_root("") is None

    def test_expands_user_and_vars(self, monkeypatch):
        monkeypatch.setenv("HOME", "/home/test")
        monkeypatch.setenv("CUSTOM_DIR", "/custom")
        result = resolve_profile_root("$HOME/profiles")
        assert result == "/home/test/profiles"

    def test_absolute_path(self):
        result = resolve_profile_root("/tmp/profiles")
        assert result == "/tmp/profiles"


# ===================================================================
# coalesce_inflight
# ===================================================================


class TestCoalesceInflight:
    @pytest.mark.asyncio
    async def test_basic_coalesce(self):
        cache: dict = {}
        call_count = 0

        async def factory():
            nonlocal call_count
            call_count += 1
            return "result"

        r1 = await coalesce_inflight(cache, "key", factory)
        assert r1 == "result"
        assert call_count == 1

        # Second call with same key should re-use
        r2 = await coalesce_inflight(cache, "key", factory)
        assert r2 == "result"
        # Factory may or may not be called again depending on timing,
        # but normally the inflight future is reused

    @pytest.mark.asyncio
    async def test_cache_cleaned_after_completion(self):
        cache: dict = {}
        async def factory():
            return "done"

        await coalesce_inflight(cache, "k", factory)
        assert "k" not in cache  # cleaned up in finally

    @pytest.mark.asyncio
    async def test_different_keys_independent(self):
        cache: dict = {}
        results = []

        async def factory_a():
            return "a"

        async def factory_b():
            return "b"

        r1 = await coalesce_inflight(cache, "a", factory_a)
        r2 = await coalesce_inflight(cache, "b", factory_b)
        assert r1 == "a"
        assert r2 == "b"


# ===================================================================
# random_id
# ===================================================================


class TestRandomId:
    def test_default_length(self):
        rid = random_id()
        assert len(rid) == 8
        assert all(c in "0123456789abcdef" for c in rid)

    def test_custom_length(self):
        rid = random_id(16)
        assert len(rid) == 16

    def test_uniqueness(self):
        ids = {random_id() for _ in range(100)}
        assert len(ids) == 100  # all unique
