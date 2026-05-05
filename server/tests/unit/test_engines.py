"""Unit tests for camofox.core.engines — multi-engine dispatch helpers."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from camofox.core.engines import (
    CAMOUFOX_PYTHON,
    CLOAKBROWSER,
    CAMOFOX_NODE,
    SUPPORTED_ENGINES,
    normalize_engine,
    make_browser_key,
)


# ===================================================================
# normalize_engine
# ===================================================================


class TestNormalizeEngine:
    """normalize_engine() resolves aliases and rejects unknowns."""

    def test_camoufox_python_default(self):
        """No arg or empty string returns camoufox-python."""
        assert normalize_engine(None) == CAMOUFOX_PYTHON
        assert normalize_engine("") == CAMOUFOX_PYTHON

    def test_camoufox_aliases(self):
        """All camoufox aliases resolve to CAMOUFOX_PYTHON."""
        for alias in ("camoufox", "camoufox-146", "camoufox-python", "camoufox_python"):
            assert normalize_engine(alias) == CAMOUFOX_PYTHON, f"alias={alias!r}"

    def test_cloakbrowser_aliases(self):
        """All cloakbrowser aliases resolve to CLOAKBROWSER."""
        for alias in ("cloak", "cloakbrowser", "cloak-browser", "cloak_browser"):
            assert normalize_engine(alias) == CLOAKBROWSER, f"alias={alias!r}"

    def test_camofox_node_aliases(self):
        """All camofox-node aliases resolve to CAMOFOX_NODE."""
        for alias in ("camofox", "camofox-node", "camofox_node", "node"):
            assert normalize_engine(alias) == CAMOFOX_NODE, f"alias={alias!r}"

    def test_case_insensitive(self):
        """Should handle mixed case."""
        assert normalize_engine("CloakBrowser") == CLOAKBROWSER
        assert normalize_engine("CamouFox") == CAMOUFOX_PYTHON
        assert normalize_engine("CAMOFOX") == CAMOFOX_NODE

    def test_strips_whitespace(self):
        """Should strip leading/trailing spaces."""
        assert normalize_engine("  cloakbrowser  ") == CLOAKBROWSER

    def test_custom_default(self):
        """Custom default is respected when value is None."""
        assert normalize_engine(None, default="cloakbrowser") == CLOAKBROWSER
        assert normalize_engine(None, default=CAMOFOX_NODE) == CAMOFOX_NODE

    def test_unknown_engine_raises(self):
        """Unknown engine value should raise ValueError with supported list."""
        with pytest.raises(ValueError, match="Unsupported browser engine"):
            normalize_engine("safari")
        with pytest.raises(ValueError, match="camoufox-python"):
            normalize_engine("internet-explorer")

    def test_all_supported_engines_in_message(self):
        """Error message should list all supported engines."""
        try:
            normalize_engine("nonexistent")
        except ValueError as e:
            msg = str(e)
            for eng in SUPPORTED_ENGINES:
                assert eng in msg, f"{eng} missing from error message"


# ===================================================================
# make_browser_key
# ===================================================================


class TestMakeBrowserKey:
    def test_format_is_engine_userid(self):
        """Key format: 'engine:userId'."""
        key = make_browser_key(CAMOUFOX_PYTHON, "test-user")
        assert key == "camoufox-python:test-user"

    def test_resolves_aliases(self):
        """Aliases are normalized before building the key."""
        key = make_browser_key("cloak", "alice")
        assert key == "cloakbrowser:alice"

    def test_normalizes_user_id(self):
        """UserId is normalized (e.g. special chars stripped/handled)."""
        key = make_browser_key(CAMOUFOX_PYTHON, "Test@User!")
        assert key == "camoufox-python:Test@User!"

    def test_different_engines_same_user(self):
        """Same user with different engines should produce different keys."""
        k1 = make_browser_key(CAMOUFOX_PYTHON, "user1")
        k2 = make_browser_key(CLOAKBROWSER, "user1")
        assert k1 != k2
        assert k1 == "camoufox-python:user1"
        assert k2 == "cloakbrowser:user1"


# ===================================================================
# SUPPORTED_ENGINES
# ===================================================================


class TestSupportedEngines:
    def test_exactly_three_engines(self):
        """Should have exactly 3 supported engines."""
        assert SUPPORTED_ENGINES == {CAMOUFOX_PYTHON, CLOAKBROWSER, CAMOFOX_NODE}

    def test_local_engines_subset(self):
        """LOCAL_ENGINES should be a subset of SUPPORTED_ENGINES."""
        from camofox.core.engines import LOCAL_ENGINES
        assert LOCAL_ENGINES.issubset(SUPPORTED_ENGINES)


# ===================================================================
# BrowserLaunchResult
# ===================================================================


class TestBrowserLaunchResult:
    def test_defaults(self):
        """BrowserLaunchResult should have useful defaults."""
        from camofox.core.engines import BrowserLaunchResult

        result = BrowserLaunchResult(browser=MagicMock(), engine=CAMOUFOX_PYTHON)
        assert result.engine == CAMOUFOX_PYTHON
        assert result.profile_dir is None
        assert result.launch_proxy is None
        assert result.display is None
        assert result.persona is None
        assert result.executable_path is None
        assert result.camoufox is None
        assert result.playwright is None

    def test_all_fields(self):
        """All fields should be settable."""
        from camofox.core.engines import BrowserLaunchResult

        mock_browser = MagicMock()
        result = BrowserLaunchResult(
            browser=mock_browser,
            engine=CLOAKBROWSER,
            profile_dir="/tmp/profiles/cloak",
            launch_proxy={"server": "http://proxy:8080"},
            display=":99",
            persona={"userId": "test"},
            executable_path="/usr/bin/cloakbrowser",
        )
        assert result.browser is mock_browser
        assert result.engine == CLOAKBROWSER
        assert result.profile_dir == "/tmp/profiles/cloak"


# ===================================================================
# _launch_cloak_browser (mocked — cloakbrowser module patched at source)
# ===================================================================


class TestLaunchCloakBrowser:
    """Verify _launch_cloak_browser calls cloakbrowser.launch_async correctly."""

    @pytest.mark.asyncio
    async def test_disabled_engine_raises(self):
        """When cloakbrowser_enabled=False, should raise RuntimeError."""
        from camofox.core.browser import _launch_cloak_browser

        with patch("camofox.core.browser.config") as mock_config:
            mock_config.cloakbrowser_enabled = False
            with pytest.raises(
                RuntimeError, match="CloakBrowser engine is disabled"
            ):
                await _launch_cloak_browser(proxy=None, display=None)

    @pytest.mark.asyncio
    async def test_basic_launch_args(self):
        """Should pass headless=True and humanize=True by default."""
        from camofox.core.browser import _launch_cloak_browser

        with (
            patch("camofox.core.browser.config") as mock_config,
            patch("cloakbrowser.launch_async", new_callable=AsyncMock) as mock_launch,
            patch("cloakbrowser.ensure_binary") as mock_ensure,
        ):
            mock_config.cloakbrowser_enabled = True
            mock_config.cloakbrowser_executable_path = ""
            mock_ensure.return_value = "/fake/bin/chrome"
            mock_launch.return_value = MagicMock()

            result = await _launch_cloak_browser(proxy=None, display=None)

            mock_ensure.assert_called_once()
            mock_launch.assert_called_once()
            kwargs = mock_launch.call_args[1]
            assert kwargs["headless"] is True
            assert kwargs["humanize"] is True
            assert kwargs["proxy"] is None

    @pytest.mark.asyncio
    async def test_display_maps_to_headless_false_when_reachable(self):
        """When display is set and reachable, headless should be False."""
        from camofox.core.browser import _launch_cloak_browser

        with (
            patch("camofox.core.browser.config") as mock_config,
            patch("cloakbrowser.launch_async", new_callable=AsyncMock) as mock_launch,
            patch("cloakbrowser.ensure_binary"),
            patch("subprocess.run") as mock_run,
        ):
            mock_config.cloakbrowser_enabled = True
            mock_run.return_value.returncode = 0
            mock_launch.return_value = MagicMock()

            await _launch_cloak_browser(proxy=None, display=":99")

            kwargs = mock_launch.call_args[1]
            assert kwargs["headless"] is False

    @pytest.mark.asyncio
    async def test_display_maps_to_headless_true_when_unreachable(self):
        """When display is set but unreachable, fall back to headless."""
        from camofox.core.browser import _launch_cloak_browser

        with (
            patch("camofox.core.browser.config") as mock_config,
            patch("cloakbrowser.launch_async", new_callable=AsyncMock) as mock_launch,
            patch("cloakbrowser.ensure_binary"),
            patch("subprocess.run") as mock_run,
        ):
            mock_config.cloakbrowser_enabled = True
            mock_run.return_value.returncode = 1
            mock_launch.return_value = MagicMock()

            await _launch_cloak_browser(proxy=None, display=":99")

            kwargs = mock_launch.call_args[1]
            assert kwargs["headless"] is True

    @pytest.mark.asyncio
    async def test_proxy_dict_with_auth(self):
        """Proxy dict with username/password mapped correctly."""
        from camofox.core.browser import _launch_cloak_browser

        with (
            patch("camofox.core.browser.config") as mock_config,
            patch("cloakbrowser.launch_async", new_callable=AsyncMock) as mock_launch,
            patch("cloakbrowser.ensure_binary"),
        ):
            mock_config.cloakbrowser_enabled = True
            mock_launch.return_value = MagicMock()

            proxy_input = {
                "host": "1.2.3.4",
                "port": 3128,
                "username": "user",
                "password": "pass",
            }
            await _launch_cloak_browser(proxy=proxy_input, display=None)

            kwargs = mock_launch.call_args[1]
            assert kwargs["proxy"] == {
                "server": "1.2.3.4:3128",
                "username": "user",
                "password": "pass",
            }

    @pytest.mark.asyncio
    async def test_proxy_without_auth(self):
        """Proxy without credentials should be passed as server string."""
        from camofox.core.browser import _launch_cloak_browser

        with (
            patch("camofox.core.browser.config") as mock_config,
            patch("cloakbrowser.launch_async", new_callable=AsyncMock) as mock_launch,
            patch("cloakbrowser.ensure_binary"),
        ):
            mock_config.cloakbrowser_enabled = True
            mock_launch.return_value = MagicMock()

            proxy_input = {"host": "1.2.3.4", "port": 3128}
            await _launch_cloak_browser(proxy=proxy_input, display=None)

            kwargs = mock_launch.call_args[1]
            assert kwargs["proxy"] == "1.2.3.4:3128"

    @pytest.mark.asyncio
    async def test_timezone_and_locale_from_env(self):
        """CAMOFOX_TIMEZONE and CAMOFOX_LOCALE should be passed through."""
        from camofox.core.browser import _launch_cloak_browser

        with (
            patch("camofox.core.browser.config") as mock_config,
            patch("cloakbrowser.launch_async", new_callable=AsyncMock) as mock_launch,
            patch("cloakbrowser.ensure_binary"),
            patch.dict("os.environ", {"CAMOFOX_TIMEZONE": "Europe/Paris", "CAMOFOX_LOCALE": "fr-FR"}),
        ):
            mock_config.cloakbrowser_enabled = True
            mock_launch.return_value = MagicMock()

            await _launch_cloak_browser(proxy=None, display=None)

            kwargs = mock_launch.call_args[1]
            assert kwargs["timezone"] == "Europe/Paris"
            assert kwargs["locale"] == "fr-FR"
