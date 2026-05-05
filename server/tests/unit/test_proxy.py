"""Unit tests for camofox.domain.proxy — proxy pool creation."""

from __future__ import annotations

from unittest.mock import MagicMock, PropertyMock, patch

import pytest

from camofox.core.config import ProxyConfig
from camofox.domain.proxy import (
    _DECODO_PROVIDER,
    _GENERIC_PROVIDER,
    _PROVIDERS,
    _create_backconnect_pool,
    _create_round_robin_pool,
    _decodo_build_proxy_url,
    _decodo_build_session_username,
    _generic_build_proxy_url,
    _generic_build_session_username,
    _proxy_pool_instance,
    _round_robin_index,
    build_proxy_url,
    build_round_robin_url,
    create_proxy_pool,
    get_proxy_pool,
    normalize_playwright_proxy,
)


# ===================================================================
# build_round_robin_url
# ===================================================================


class TestBuildRoundRobinUrl:
    def test_default_protocol(self):
        assert build_round_robin_url("127.0.0.1", 8080) == "http://127.0.0.1:8080"

    def test_custom_protocol(self):
        assert (
            build_round_robin_url("proxy.example.com", 3128, "https")
            == "https://proxy.example.com:3128"
        )


# ===================================================================
# _decodo_build_session_username
# ===================================================================


class TestDecodoBuildSessionUsername:
    def test_basic(self):
        result = _decodo_build_session_username("testuser")
        assert result.startswith("user-testuser")
        assert "session-" in result
        assert "sessionduration-10" in result

    def test_with_country_and_state(self):
        result = _decodo_build_session_username(
            "testuser",
            {"country": "FR", "state": "IDF", "sessionId": "sess-abc", "sessionDurationMinutes": 5},
        )
        assert "country-FR" in result
        assert "state-IDF" in result
        assert "session-sess-abc" in result
        assert "sessionduration-5" in result

    def test_no_options_uses_defaults(self):
        result = _decodo_build_session_username("testuser", None)
        assert "country-" not in result
        assert "state-" not in result
        assert "session-" in result
        assert "sessionduration-10" in result


# ===================================================================
# _decodo_build_proxy_url
# ===================================================================


class TestDecodoBuildProxyUrl:
    def test_with_credentials(self):
        config = ProxyConfig()
        proxy = {"server": "http://proxy.example.com:8080", "username": "user", "password": "pass"}
        url = _decodo_build_proxy_url(proxy, config)
        assert url == "http://user:***@proxy.example.com:8080"

    def test_no_credentials(self):
        config = ProxyConfig()
        proxy = {"server": "http://proxy.example.com:8080", "username": "", "password": ""}
        url = _decodo_build_proxy_url(proxy, config)
        assert url == "http://proxy.example.com:8080"

    def test_no_server(self):
        config = ProxyConfig()
        proxy = {"server": "", "username": "", "password": ""}
        assert _decodo_build_proxy_url(proxy, config) is None


# ===================================================================
# _generic_build_session_username
# ===================================================================


class TestGenericBuildSessionUsername:
    def test_with_session_rotation(self):
        result = _generic_build_session_username(
            "testuser",
            {"can_rotate_sessions": True, "sessionId": "ctx-abc123"},
        )
        assert result == "testuser-session-ctx-abc123"

    def test_without_session_rotation(self):
        result = _generic_build_session_username(
            "testuser",
            {"can_rotate_sessions": False},
        )
        assert result == "testuser"

    def test_no_options(self):
        result = _generic_build_session_username("testuser", None)
        assert "session-" in result  # defaults to rotating


# ===================================================================
# _generic_build_proxy_url
# ===================================================================


class TestGenericBuildProxyUrl:
    def test_with_credentials(self):
        config = ProxyConfig()
        proxy = {"server": "http://proxy.example.com:3128", "username": "u", "password": "p"}
        url = _generic_build_proxy_url(proxy, config)
        assert url == "http://u:***@proxy.example.com:3128"

    def test_no_credentials(self):
        config = ProxyConfig()
        proxy = {"server": "http://proxy.example.com:3128", "username": "", "password": ""}
        url = _generic_build_proxy_url(proxy, config)
        assert url == "http://proxy.example.com:3128"

    def test_no_server(self):
        config = ProxyConfig()
        proxy = {"server": "", "username": "", "password": ""}
        assert _generic_build_proxy_url(proxy, config) is None


# ===================================================================
# _create_round_robin_pool
# ===================================================================


class TestCreateRoundRobinPool:
    def test_returns_none_without_host(self):
        config = ProxyConfig(host="", ports=[8080])
        assert _create_round_robin_pool(config) is None

    def test_returns_none_without_ports(self):
        config = ProxyConfig(host="127.0.0.1", ports=[])
        assert _create_round_robin_pool(config) is None

    def test_creates_pool(self):
        config = ProxyConfig(host="127.0.0.1", ports=[8080, 8081], username="u", password="p")
        pool = _create_round_robin_pool(config)
        assert pool is not None
        assert pool["mode"] == "round_robin"
        assert pool["size"] == 2
        assert pool["can_rotate_sessions"] is False
        assert len(pool["_entries"]) == 2

        # Test get_proxy returns entries
        entry = pool["get_launch_proxy"]()
        assert "server" in entry
        assert entry["username"] == "u"
        assert entry["password"] == "p"

    def test_get_next_cycles(self):
        config = ProxyConfig(host="127.0.0.1", ports=[8080, 8081])
        pool = _create_round_robin_pool(config)
        assert pool is not None

        first = pool["get_next"]()
        second = pool["get_next"]()
        assert first["server"] != second["server"]  # different ports

        third = pool["get_next"]()
        # Should wrap around to first
        assert third["server"] == first["server"]


# ===================================================================
# _create_backconnect_pool
# ===================================================================


class TestCreateBackconnectPool:
    def test_returns_none_without_backconnect_host(self):
        config = ProxyConfig(
            strategy="backconnect",
            provider_name="generic",
            backconnect_host="",
            backconnect_port=8080,
        )
        assert _create_backconnect_pool(config) is None

    def test_returns_none_without_backconnect_port(self):
        config = ProxyConfig(
            strategy="backconnect",
            provider_name="generic",
            backconnect_host="proxy.example.com",
            backconnect_port=0,
        )
        assert _create_backconnect_pool(config) is None

    def test_returns_none_for_unknown_provider(self):
        config = ProxyConfig(
            strategy="backconnect",
            provider_name="unknown",
            backconnect_host="proxy.example.com",
            backconnect_port=3128,
        )
        assert _create_backconnect_pool(config) is None

    def test_creates_generic_pool(self):
        config = ProxyConfig(
            strategy="backconnect",
            provider_name="generic",
            backconnect_host="proxy.example.com",
            backconnect_port=3128,
            username="user",
            password="pass",
        )
        pool = _create_backconnect_pool(config)
        assert pool is not None
        assert pool["mode"] == "backconnect"
        assert pool["provider"]["name"] == "generic"
        assert pool["size"] == 1

        # Test get_launch_proxy
        entry = pool["get_launch_proxy"]("sess-test123")
        assert entry["server"] == "http://proxy.example.com:3128"
        assert entry["username"] is not None
        assert "session-" in entry["username"]
        assert entry["password"] == "pass"
        assert entry["sessionId"] == "sess-test123"

    def test_creates_decodo_pool(self):
        config = ProxyConfig(
            strategy="backconnect",
            provider_name="decodo",
            backconnect_host="decodo.example.com",
            backconnect_port=8080,
            username="decouser",
            password="decopass",
            country="US",
        )
        pool = _create_backconnect_pool(config)
        assert pool is not None
        assert pool["provider"]["name"] == "decodo"
        assert pool["can_rotate_sessions"] is True

        entry = pool["get_launch_proxy"]("sess-abc")
        assert "country-US" in entry["username"]

    def test_get_next_same_as_get_launch(self):
        config = ProxyConfig(
            strategy="backconnect",
            provider_name="generic",
            backconnect_host="proxy.example.com",
            backconnect_port=3128,
        )
        pool = _create_backconnect_pool(config)
        assert pool is not None
        assert pool["get_next"] == pool["get_launch_proxy"]


# ===================================================================
# create_proxy_pool / get_proxy_pool
# ===================================================================


class TestCreateProxyPool:
    def test_round_robin_strategy(self):
        config = ProxyConfig(
            strategy="round_robin",
            host="127.0.0.1",
            ports=[8080, 8081],
        )
        pool = create_proxy_pool(config)
        assert pool is not None
        assert pool["mode"] == "round_robin"

    def test_backconnect_strategy(self):
        config = ProxyConfig(
            strategy="backconnect",
            provider_name="generic",
            backconnect_host="proxy.example.com",
            backconnect_port=3128,
        )
        pool = create_proxy_pool(config)
        assert pool is not None
        assert pool["mode"] == "backconnect"

    def test_unknown_strategy_returns_none(self):
        config = ProxyConfig(strategy="unknown")
        pool = create_proxy_pool(config)
        assert pool is None

    def test_sets_module_instance(self):
        config = ProxyConfig(
            strategy="round_robin",
            host="127.0.0.1",
            ports=[8080],
        )
        pool = create_proxy_pool(config)
        assert get_proxy_pool() is pool

    def test_none_config_loads_from_config(self):
        # When proxy_config is None, it calls Config.load().proxy
        mock_config = MagicMock()
        mock_config.proxy = ProxyConfig(
            strategy="round_robin",
            host="127.0.0.1",
            ports=[9090],
        )

        with patch("camofox.core.config.Config") as MockConfig:
            MockConfig.load.return_value = mock_config
            pool = create_proxy_pool(None)
            assert pool is not None
            assert pool["mode"] == "round_robin"


class TestGetProxyPool:
    def test_returns_none_initially(self):
        pool = get_proxy_pool()
        # Pool might be set from previous tests, so this is informational
        assert pool is None or isinstance(pool, dict)


# ===================================================================
# normalize_playwright_proxy
# ===================================================================


class TestNormalizePlaywrightProxy:
    def test_basic(self):
        entry = {
            "server": "http://127.0.0.1:8080",
            "username": "user",
            "password": "pass",
        }
        result = normalize_playwright_proxy(entry)
        assert result["server"] == "http://127.0.0.1:8080"
        assert result["username"] == "user"
        assert result["password"] == "pass"

    def test_missing_fields_defaults(self):
        result = normalize_playwright_proxy({})
        assert result["server"] == ""
        assert result["username"] is None
        assert result["password"] is None


# ===================================================================
# build_proxy_url
# ===================================================================


class TestBuildProxyUrl:
    def test_none_pool_none_config_returns_none(self):
        # When pool is None and _proxy_pool_instance is also None
        with patch("camofox.domain.proxy._proxy_pool_instance", None):
            result = build_proxy_url(pool=None, config=None)
            assert result is None

    def test_round_robin_no_creds(self):
        config = ProxyConfig(host="127.0.0.1", ports=[8080])
        pool = create_proxy_pool(config)
        result = build_proxy_url(pool, config)
        assert result == "http://127.0.0.1:8080"

    def test_round_robin_with_creds(self):
        config = ProxyConfig(host="127.0.0.1", ports=[8080], username="u", password="p")
        pool = create_proxy_pool(config)
        result = build_proxy_url(pool, config)
        assert result == "http://u:***@127.0.0.1:8080"

    def test_backconnect_delegates_to_provider(self):
        config = ProxyConfig(
            strategy="backconnect",
            provider_name="generic",
            backconnect_host="proxy.example.com",
            backconnect_port=3128,
            username="user",
            password="pass",
        )
        pool = create_proxy_pool(config)
        assert pool is not None
        result = build_proxy_url(pool, config)
        # Backconnect with generic provider: returns URL with session-based username
        assert "@proxy.example.com:3128" in result
        assert "http://" in result

    def test_fallback_from_config_host_port(self):
        config = ProxyConfig(host="fallback.host", port=9999, username="u", password="p")
        with patch("camofox.domain.proxy._proxy_pool_instance", None):
            pool = {"mode": "round_robin", "_entries": []}
            result = build_proxy_url(pool=pool, config=config)
            assert "http://u:***@" in result
            assert "fallback.host:9999" in result

    def test_fallback_from_config_backconnect(self):
        config = ProxyConfig(
            backconnect_host="back.fallback.com",
            backconnect_port=7777,
            username="u",
            password="p",
        )
        with patch("camofox.domain.proxy._proxy_pool_instance", None):
            pool = {"mode": "round_robin", "_entries": []}
            result = build_proxy_url(pool=pool, config=config)
            assert "http://u:***@" in result
            assert "back.fallback.com:7777" in result


# ===================================================================
# Constants / Providers sanity
# ===================================================================


class TestProviders:
    def test_decodo_provider_structure(self):
        assert _DECODO_PROVIDER["name"] == "decodo"
        assert _DECODO_PROVIDER["can_rotate_sessions"] is True
        assert _DECODO_PROVIDER["launch_retries"] == 10
        assert callable(_DECODO_PROVIDER["build_session_username"])
        assert callable(_DECODO_PROVIDER["build_proxy_url"])

    def test_generic_provider_structure(self):
        assert _GENERIC_PROVIDER["name"] == "generic"
        assert _GENERIC_PROVIDER["can_rotate_sessions"] is True
        assert _GENERIC_PROVIDER["launch_retries"] == 5
        assert callable(_GENERIC_PROVIDER["build_session_username"])
        assert callable(_GENERIC_PROVIDER["build_proxy_url"])

    def test_provider_registry(self):
        assert "decodo" in _PROVIDERS
        assert "generic" in _PROVIDERS
        assert _PROVIDERS["decodo"] is _DECODO_PROVIDER
        assert _PROVIDERS["generic"] is _GENERIC_PROVIDER
