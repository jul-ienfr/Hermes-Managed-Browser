"""Subprocess smoke test for managed memory record/replay/checkpoint.

This starts the real FastAPI server plus a tiny local HTML server, then exercises
/cli/memory/record, /cli/memory/replay?execute=true, and /cli/checkpoint through
HTTP.  The browser layer is stubbed inside the server process so the test covers
server wiring and persistence without depending on a real Camoufox binary.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import textwrap
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from camofox.core.utils import user_dir_from_id

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SERVER_PORT = 19491
PAGE_PORT = 19492
BASE_URL = f"http://127.0.0.1:{SERVER_PORT}"
PAGE_URL = f"http://127.0.0.1:{PAGE_PORT}/index.html"


def _json_req(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = Request(f"{BASE_URL}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urlopen(req, timeout=20) as resp:
            raw = resp.read().decode()
            return resp.status, json.loads(raw) if raw else {}
    except HTTPError as exc:
        raw = exc.read().decode()
        try:
            return exc.code, json.loads(raw) if raw else {}
        except Exception:
            return exc.code, {"error": raw}


def _wait_for_health(timeout: float = 20) -> None:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            status, _body = _json_req("GET", "/health")
            if status == 200:
                return
        except Exception as exc:  # pragma: no cover - diagnostic only
            last_error = exc
        time.sleep(0.25)
    raise RuntimeError(f"server did not become ready on {BASE_URL}: {last_error}")


def _terminate(proc: subprocess.Popen[str]) -> tuple[str, str]:
    if proc.poll() is None:
        os.kill(proc.pid, signal.SIGTERM)
        try:
            return proc.communicate(timeout=8)
        except subprocess.TimeoutExpired:
            os.kill(proc.pid, signal.SIGKILL)
            return proc.communicate(timeout=5)
    return proc.communicate(timeout=1)


@pytest.fixture()
def local_page_server(tmp_path: Path):
    webroot = tmp_path / "web"
    webroot.mkdir()
    (webroot / "index.html").write_text(
        """
        <!doctype html>
        <html><head><title>Managed replay smoke</title></head>
        <body>
          <input id="q" />
          <button id="go" onclick="document.body.dataset.clicked='1'; document.title='done:' + document.querySelector('#q').value">Go</button>
        </body></html>
        """,
        encoding="utf-8",
    )
    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(PAGE_PORT), "--bind", "127.0.0.1"],
        cwd=str(webroot),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                with urlopen(PAGE_URL, timeout=2) as resp:
                    if resp.status == 200:
                        break
            except Exception:
                time.sleep(0.2)
        else:
            raise RuntimeError("local page server did not start")
        yield
    finally:
        _terminate(proc)


@pytest.fixture()
def managed_server(tmp_path: Path):
    stub = tmp_path / "sitecustomize.py"
    stub.write_text(
        textwrap.dedent(
            """
            import sys
            import types

            from camofox.core.session import TabState

            class FakeKeyboard:
                async def press(self, key):
                    return None
                async def type(self, text, **kwargs):
                    return None

            class FakeMouse:
                async def move(self, *args, **kwargs):
                    return None
                async def down(self, *args, **kwargs):
                    return None
                async def up(self, *args, **kwargs):
                    return None

            class FakeLocator:
                def __init__(self, page, selector):
                    self.page = page
                    self.selector = selector
                async def count(self):
                    return 1
                async def focus(self, **kwargs):
                    return None
                async def evaluate(self, expression):
                    return None
                async def click(self, **kwargs):
                    self.page.clicked = True
                    if self.selector == '#go':
                        self.page.title = 'done:' + self.page.value
                async def bounding_box(self, **kwargs):
                    return {'x': 1, 'y': 1, 'width': 10, 'height': 10}

            class FakePage:
                def __init__(self):
                    self.url = 'about:blank'
                    self.title = ''
                    self.value = ''
                    self.clicked = False
                    self.keyboard = FakeKeyboard()
                    self.mouse = FakeMouse()
                def locator(self, selector):
                    return FakeLocator(self, selector)
                async def goto(self, url, **kwargs):
                    self.url = url
                async def evaluate(self, expression):
                    return {'value': self.value, 'clicked': '1' if self.clicked else '', 'title': self.title}
                async def close(self):
                    return None
                def on(self, *args, **kwargs):
                    return None

            class FakeContext:
                def __init__(self):
                    self.pages = []
                async def new_page(self):
                    page = FakePage()
                    self.pages.append(page)
                    return page
                async def storage_state(self):
                    return {'cookies': [], 'origins': []}
                async def close(self):
                    return None
                async def add_init_script(self, script):
                    return None
                def on(self, *args, **kwargs):
                    return None

            class FakeBrowser:
                async def new_context(self, **kwargs):
                    return FakeContext()

            async def fake_ensure_browser(*args, **kwargs):
                return {'browser': FakeBrowser(), 'persona': {}, 'display': None, 'launch_proxy': None}

            async def fake_human_type(page, selector, text, **kwargs):
                if selector == '#q':
                    page.value = text
                return {'ok': True, 'chars': len(text)}

            async def fake_human_click(page, selector, **kwargs):
                if selector == '#go':
                    page.clicked = True
                    page.title = 'done:' + page.value
                return {'ok': True}

            async def fake_build_snapshot(page):
                return 'input Search button Go', {
                    '@q': {'selector': '#q', 'role': 'textbox', 'name': 'Search', 'attributes': {'id': 'q'}},
                    '@go': {'selector': '#go', 'role': 'button', 'name': 'Go', 'text': 'Go', 'attributes': {'id': 'go'}},
                }

            import camofox.core.browser as browser_mod
            import camofox.core.session as session_mod
            import camofox.domain.actions as actions_mod
            import camofox.domain.replay as replay_mod

            browser_mod.ensure_browser = fake_ensure_browser
            session_mod.ensure_browser = fake_ensure_browser
            actions_mod.human_type = fake_human_type
            actions_mod.human_click = fake_human_click
            replay_mod.human_type = fake_human_type
            replay_mod.human_click = fake_human_click
            replay_mod.build_snapshot = fake_build_snapshot
            """
        ),
        encoding="utf-8",
    )

    env = os.environ.copy()
    env["NODE_ENV"] = "development"
    env["PYTHONPATH"] = f"{tmp_path}:{PROJECT_ROOT}:{env.get('PYTHONPATH', '')}"
    env["PYTHONUNBUFFERED"] = "1"
    env["CAMOFOX_PROFILE_DIR"] = str(tmp_path / "profiles")
    env["MANAGED_BROWSER_DEFAULT_ENGINE"] = "camoufox-python"
    proc = subprocess.Popen(
        [sys.executable, "server.py", "--host", "127.0.0.1", "--port", str(SERVER_PORT), "--log-level", "warning"],
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        _wait_for_health()
        yield tmp_path / "profiles"
    finally:
        stdout, stderr = _terminate(proc)
        if proc.returncode not in (0, -signal.SIGTERM):
            raise RuntimeError(f"managed server failed: stdout={stdout}\nstderr={stderr}")


def test_managed_record_replay_execute_and_checkpoint(managed_server: Path, local_page_server) -> None:
    flow = [
        {"action": "navigate", "url": PAGE_URL},
        {"action": "snapshot"},
        {"action": "type", "ref": "@q", "text": "{{query}}"},
        {"action": "click", "ref": "@go", "target_summary": {"role": "button", "name": "Go", "attributes": {"id": "go"}}},
        {"action": "evaluate", "expression": "() => ({value: document.querySelector('#q').value, clicked: document.body.dataset.clicked || '', title: document.title})"},
    ]

    status, record = _json_req(
        "POST",
        "/managed/cli/memory/record",
        {"profile": "smoke-profile", "flow_id": "local-smoke", "flow": flow, "metadata": {"purpose": "smoke"}},
    )
    assert status == 200, record
    assert record["flowId"] == "local-smoke"

    status, replay = _json_req(
        "POST",
        "/managed/cli/memory/replay",
        {"profile": "smoke-profile", "flow_id": "local-smoke", "execute": True, "timeout_ms": 5000, "params": {"query": "hello"}},
    )
    assert status == 200, replay
    assert replay["executed"] is True
    assert replay["stepCount"] == len(flow)
    assert replay["results"][-1]["result"] == {"value": "hello", "clicked": "1", "title": "done:hello"}

    status, checkpoint = _json_req("POST", "/managed/cli/checkpoint", {"profile": "smoke-profile"})
    assert status == 200, checkpoint
    assert checkpoint["checkpointed"] is True
    profile_dir = user_dir_from_id(str(managed_server), "smoke-profile")
    assert (profile_dir / "storage-state.json").is_file()
    assert (profile_dir / "managed-memory" / "local-smoke.json").is_file()


def test_managed_memory_list_and_inspect_export_http(managed_server: Path) -> None:
    auto_flow = [
        {"action": "navigate", "url": "https://example.com"},
        {"action": "type", "ref": "@api", "api_key": "step-secret-key", "target_summary": {"role": "textbox", "name": "API key"}},
        {"action": "click", "ref": "@go", "target_summary": {"role": "button", "name": "Go", "cookie": "step-cookie-secret"}},
    ]

    status, unsafe_record = _json_req(
        "POST",
        "/managed/cli/memory/record",
        {"profile": "export-profile", "flow_id": "../escape", "flow": auto_flow},
    )
    assert status == 400
    assert "flow_id" in json.dumps(unsafe_record)

    status, record = _json_req(
        "POST",
        "/managed/cli/memory/record",
        {
            "profile": "export-profile",
            "flow_id": "browser-actions",
            "flow": auto_flow,
            "metadata": {"source": "auto-record", "token": "must-not-leak"},
        },
    )
    assert status == 200, record

    status, listed = _json_req("POST", "/managed/cli/memory/list", {"profile": "export-profile"})
    assert status == 200, listed
    assert listed["ok"] is True
    assert listed["count"] == 1
    assert listed["flows"][0]["flow_id"] == "browser-actions"
    assert "flow" not in listed["flows"][0]
    assert listed["flows"][0]["metadata"]["token"] == "[REDACTED]"
    assert "must-not-leak" not in json.dumps(listed)

    status, empty_listed = _json_req("POST", "/managed/cli/memory/list", {"profile": "empty-export-profile"})
    assert status == 200, empty_listed
    assert empty_listed["ok"] is True
    assert empty_listed["count"] == 0
    assert empty_listed["flows"] == []

    status, empty_legacy_listed = _json_req("POST", "/flow/list", {"profile": "empty-export-profile", "site": "example"})
    assert status == 200, empty_legacy_listed
    assert empty_legacy_listed["success"] is True
    assert empty_legacy_listed["result"]["count"] == 0
    assert empty_legacy_listed["result"]["flows"] == []

    status, listed_with_flow = _json_req(
        "POST",
        "/managed/cli/memory/list",
        {"profile": "export-profile", "include_flow": True},
    )
    assert status == 200, listed_with_flow
    assert [step["action"] for step in listed_with_flow["flows"][0]["flow"]] == ["navigate", "type", "click"]
    assert listed_with_flow["flows"][0]["flow"][1]["api_key"] == "[REDACTED]"
    assert listed_with_flow["flows"][0]["flow"][2]["target_summary"]["cookie"] == "[REDACTED]"
    assert listed_with_flow["flows"][0]["metadata"]["token"] == "[REDACTED]"
    assert "must-not-leak" not in json.dumps(listed_with_flow)
    assert "step-secret-key" not in json.dumps(listed_with_flow)
    assert "step-cookie-secret" not in json.dumps(listed_with_flow)

    status, inspected = _json_req("POST", "/managed/cli/memory/inspect", {"profile": "export-profile"})
    assert status == 200, inspected
    assert inspected["flowId"] == "browser-actions"
    assert inspected["step_count"] == 3
    assert inspected["flow"][1]["api_key"] == "[REDACTED]"
    assert inspected["flow"][2]["target_summary"]["cookie"] == "[REDACTED]"
    assert inspected["metadata"]["token"] == "[REDACTED]"
    inspected_json = json.dumps(inspected)
    assert "must-not-leak" not in inspected_json
    assert "step-secret-key" not in inspected_json
    assert "step-cookie-secret" not in inspected_json

    status, exported = _json_req("POST", "/managed/cli/memory/export", {"profile": "export-profile"})
    assert status == 200, exported
    assert exported == inspected

    profile_dir = user_dir_from_id(str(managed_server), "export-profile")
    flow_file = profile_dir / "managed-memory" / "browser-actions.json"
    index_file = profile_dir / "managed-memory" / "managed-memory-index.json"
    assert flow_file.is_file()
    assert index_file.is_file()
    persisted_flow_json = flow_file.read_text(encoding="utf-8")
    persisted_index_json = index_file.read_text(encoding="utf-8")
    assert "step-secret-key" not in persisted_flow_json
    assert "step-cookie-secret" not in persisted_flow_json
    assert "must-not-leak" not in persisted_flow_json
    assert "must-not-leak" not in persisted_index_json
    persisted_flow = json.loads(persisted_flow_json)
    persisted_index = json.loads(persisted_index_json)
    assert persisted_flow["flow"][1]["api_key"] == "[REDACTED]"
    assert persisted_flow["flow"][2]["target_summary"]["cookie"] == "[REDACTED]"
    assert persisted_flow["metadata"]["token"] == "[REDACTED]"
    assert persisted_index["flows"]["browser-actions"]["metadata"]["token"] == "[REDACTED]"

    status, missing_export = _json_req("POST", "/managed/cli/memory/export", {"profile": "empty-export-profile"})
    assert status == 404
    assert "browser-actions" in json.dumps(missing_export)

    status, unsafe_export = _json_req("POST", "/managed/cli/memory/export", {"profile": "export-profile", "flow_id": "../escape"})
    assert status == 400
    assert "flow_id" in json.dumps(unsafe_export)

    status, replay_default = _json_req("POST", "/managed/cli/memory/replay", {"profile": "export-profile"})
    assert status == 200, replay_default
    assert replay_default["flowId"] == "browser-actions"
    assert replay_default["executed"] is False
    assert [step["action"] for step in replay_default["flow"]] == ["navigate", "type", "click"]
    assert "step-secret-key" not in json.dumps(replay_default)
    assert "step-cookie-secret" not in json.dumps(replay_default)

    status, unsafe_legacy_run = _json_req(
        "POST",
        "/flow/run",
        {"profile": "export-profile", "site": "example", "flow": "../escape", "execute": False},
    )
    assert status == 400
    assert "flow_id" in json.dumps(unsafe_legacy_run)

    status, legacy_run_default = _json_req("POST", "/flow/run", {"profile": "export-profile", "site": "example", "execute": False})
    assert status == 200, legacy_run_default
    assert legacy_run_default["success"] is True
    assert legacy_run_default["result"]["flowId"] == "browser-actions"
    assert legacy_run_default["result"]["executed"] is False
    assert [step["action"] for step in legacy_run_default["result"]["steps"]] == ["navigate", "type", "click"]
    assert "step-secret-key" not in json.dumps(legacy_run_default)
    assert "step-cookie-secret" not in json.dumps(legacy_run_default)

    status, missing_replay_default = _json_req("POST", "/managed/cli/memory/replay", {"profile": "empty-export-profile"})
    assert status == 404
    assert "browser-actions" in json.dumps(missing_replay_default)

    status, missing_legacy_inspect = _json_req("POST", "/flow/inspect", {"profile": "export-profile", "site": "example", "flow": "missing"})
    assert status == 404
    assert "missing" in json.dumps(missing_legacy_inspect)

    status, unsafe_legacy_inspect = _json_req(
        "POST",
        "/flow/inspect",
        {"profile": "export-profile", "site": "example", "flow": "../escape"},
    )
    assert status == 400
    assert "flow_id" in json.dumps(unsafe_legacy_inspect)

    status, missing_legacy_default = _json_req("POST", "/flow/run", {"profile": "empty-export-profile", "site": "example", "execute": False})
    assert status == 404
    assert "browser-actions" in json.dumps(missing_legacy_default)
