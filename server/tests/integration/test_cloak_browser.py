"""Integration test for CloakBrowser engine.

Starts a real server on port 8092 with CLOAK_BROWSER_ENABLED=1,
spins up a CloakBrowser session, creates a tab, navigates to example.com,
takes a snapshot, clicks an element, and verifies navigation.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError

import pytest

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SERVER_PORT = 8092
BASE_URL = f"http://127.0.0.1:{SERVER_PORT}"
TEST_USER = "cloak-integration-test"
SERVER_TIMEOUT = 45        # CloakBrowser binary download may happen first time
POLL_INTERVAL = 0.5

log = logging.getLogger("test_cloak_browser")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _json_req(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    """Make an HTTP JSON request via urllib. Returns (status_code, parsed_body)."""
    url = f"{BASE_URL}{path}"
    data = json.dumps(body).encode() if body else None
    req = Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urlopen(req, timeout=15) as resp:
            status = resp.status
            raw = resp.read().decode()
            return status, json.loads(raw) if raw else {}
    except HTTPError as exc:
        raw = exc.read().decode()
        try:
            return exc.code, json.loads(raw)
        except Exception:
            return exc.code, {"error": raw}
    except Exception as exc:
        raise


def _get_json(path: str) -> tuple[int, dict]:
    return _json_req("GET", path)


def _post_json(path: str, body: dict) -> tuple[int, dict]:
    return _json_req("POST", path, body)


def _wait_for_server(timeout: float = SERVER_TIMEOUT) -> bool:
    """Poll the /health endpoint until the server responds."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            status, _ = _get_json("/health")
            if status == 200:
                return True
        except Exception:
            pass
        time.sleep(POLL_INTERVAL)
    return False


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def server_process():
    """Start the camofox-browser server on port 8092 as a subprocess
    with CLOAK_BROWSER_ENABLED=1.

    Kills any leftover process on that port first.  Yields the Popen handle
    and terminates the server at teardown.
    """
    # Kill anything already on our port
    kill_cmd = f"lsof -ti tcp:{SERVER_PORT} | xargs -r kill -9 2>/dev/null || true"
    subprocess.run(kill_cmd, shell=True, timeout=5)
    time.sleep(0.5)

    server_dir = Path(__file__).resolve().parent.parent.parent  # project root
    server_script = str(server_dir / "server.py")

    env = os.environ.copy()
    env["NODE_ENV"] = "development"  # allow loopback without API key
    env["MANAGED_BROWSER_PORT"] = str(SERVER_PORT)
    env["CLOAK_BROWSER_ENABLED"] = "1"

    proc = subprocess.Popen(
        [sys.executable, server_script, "--port", str(SERVER_PORT)],
        cwd=str(server_dir),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )

    ready = _wait_for_server()
    if not ready:
        stdout, stderr = proc.communicate(timeout=5)
        proc.poll()
        raise RuntimeError(
            f"Server did not start within {SERVER_TIMEOUT}s.\n"
            f"stdout:\n{stdout.decode()}\nstderr:\n{stderr.decode()}"
        )

    yield proc

    # Teardown
    if proc.poll() is None:
        os.kill(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.kill(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestCloakBrowserIntegration:
    """End-to-end test exercising CloakBrowser full lifecycle."""

    def _start_browser(self, engine: str = "cloakbrowser"):
        status, data = _post_json(
            "/start",
            {"userId": TEST_USER, "engine": engine, "headless": True},
        )
        assert status == 200, f"/start failed: {data}"
        assert data.get("browser") == "connected", (
            f"Expected browser=connected, got: {data}"
        )
        log.info("Browser started with engine=%s: %s", engine, data)
        return data

    def _open_tab(self, url: str | None = None) -> str:
        body: dict[str, Any] = {"userId": TEST_USER, "engine": "cloakbrowser"}
        if url:
            body["url"] = url
        status, data = _post_json("/tabs", body)
        assert status == 200, f"/tabs failed: {data}"
        tab_id = data.get("tabId")
        assert tab_id is not None, f"No tabId returned: {data}"
        log.info("Tab opened: tabId=%s", tab_id)
        return tab_id

    def _navigate(self, tab_id: str, url: str):
        status, data = _post_json(
            f"/tabs/{tab_id}/navigate",
            {"userId": TEST_USER, "url": url, "engine": "cloakbrowser"},
        )
        assert status == 200, f"Navigate to {url} failed: {data}"
        assert data.get("ok") is True
        log.info("Navigated to %s", url)

    def _take_snapshot(self, tab_id: str) -> dict:
        status, data = _get_json(f"/tabs/{tab_id}/snapshot?userId={TEST_USER}")
        assert status == 200, f"Snapshot failed: {data}"
        assert "snapshot" in data, f"Snapshot missing 'snapshot' key: {data}"
        log.info(
            "Snapshot taken (truncated=%s, ref_count=%d)",
            data.get("truncated", False),
            len(data.get("refs", {})),
        )
        return data

    def _click(self, tab_id: str, ref: str):
        status, data = _post_json(
            f"/tabs/{tab_id}/click",
            {"userId": TEST_USER, "ref": ref, "engine": "cloakbrowser"},
        )
        assert status == 200, f"Click {ref} failed (status {status}): {data}"
        assert data.get("ok") is True
        log.info("Clicked %s successfully", ref)

    def _get_stats(self, tab_id: str) -> dict:
        status, data = _get_json(f"/tabs/{tab_id}/stats?engine=cloakbrowser")
        assert status == 200, f"Stats failed: {data}"
        return data

    def _stop_browser(self):
        status, data = _post_json("/stop", {"userId": TEST_USER, "engine": "cloakbrowser"})
        assert status == 200, f"/stop failed: {data}"
        assert data.get("ok") is True
        log.info("Browser stopped: %s", data)

    def _screenshot(self, tab_id: str) -> bytes:
        """Take a screenshot via the REST endpoint and return the PNG bytes."""
        status, data = _get_json(f"/tabs/{tab_id}/screenshot?userId={TEST_USER}")
        assert status == 200, f"Screenshot failed: {data}"
        screenshot_path = data.get("path")
        assert screenshot_path, f"Screenshot response missing path: {data}"
        raw = Path(screenshot_path).read_bytes()
        assert len(raw) > 500, f"Screenshot too small ({len(raw)} bytes), likely blank"
        assert raw.startswith(b"\x89PNG"), "Screenshot is not a PNG"
        log.info("Screenshot taken: %s (%d bytes)", screenshot_path, len(raw))
        return raw

    # ------------------------------------------------------------------
    # The actual test
    # ------------------------------------------------------------------

    def test_cloak_full_flow(self, server_process):
        """CloakBrowser integration test: start → open tab → navigate → snapshot → click → verify → stop."""
        assert server_process.poll() is None, "Server process died prematurely"

        # 1. Start a CloakBrowser session
        start_data = self._start_browser("cloakbrowser")
        assert "profile_dir" in start_data, f"No profile_dir: {start_data}"

        # 2. Open a new tab
        tab_id = self._open_tab()

        # 3. Navigate to example.com
        self._navigate(tab_id, "https://example.com")

        # Give the page time to fully render
        time.sleep(2)

        # 4. Take a snapshot
        snapshot1 = self._take_snapshot(tab_id)
        assert "e1" in snapshot1.get("refs", {}), (
            f"Expected ref 'e1' in snapshot refs, got: {list(snapshot1.get('refs', {}).keys())}"
        )
        refs = snapshot1["refs"]
        e1_info = refs["e1"]
        log.info("e1 ref info: %s", e1_info)
        assert "selector" in e1_info, f"e1 missing 'selector': {e1_info}"

        # Record the original URL before clicking
        pre_click_stats = self._get_stats(tab_id)
        original_url = pre_click_stats.get("url", "")
        log.info("Original URL before click: %s", original_url)
        assert "example" in original_url, (
            f"Expected to be on example.com, got: {original_url}"
        )

        # 5. Take a screenshot to visually confirm CloakBrowser rendered the page
        screenshot_bytes = self._screenshot(tab_id)
        # Save it for potential inspection
        screenshot_path = f"/tmp/cloak-test-{tab_id}.png"
        with open(screenshot_path, "wb") as f:
            f.write(screenshot_bytes)
        log.info("Screenshot saved to %s", screenshot_path)

        # 6. Click e1 (the "More information..." link on example.com)
        self._click(tab_id, "e1")

        # 7. Wait for navigation triggered by the click
        max_wait = 8
        new_url = None
        for i in range(max_wait):
            time.sleep(1)
            stats = self._get_stats(tab_id)
            current_url = stats.get("url", "")
            log.info("URL %ds after click: %s", i + 1, current_url)
            if current_url and current_url != original_url:
                new_url = current_url
                break

        assert new_url is not None, (
            f"URL did not change after clicking 'e1'. "
            f"Stayed at: {original_url}."
        )
        log.info("Navigation confirmed: %s → %s", original_url, new_url)

        # 8. Take another snapshot on the new page
        snapshot2 = self._take_snapshot(tab_id)
        assert "snapshot" in snapshot2
        snapshot_url = snapshot2.get("url", "")
        log.info("Second snapshot URL: %s", snapshot_url)

        # 9. Stop the browser (clean teardown)
        self._stop_browser()

        log.info("CloakBrowser integration test passed successfully!")
