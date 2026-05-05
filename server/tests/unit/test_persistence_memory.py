from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from camofox.core.app import create_app
from camofox.core.config import Config, config as global_config
from camofox.core.engines import make_browser_key
from camofox.core.session import SessionState, TabState, close_session, sessions
from camofox.core import browser as browser_module
from camofox.core import session as session_module
from camofox.domain.memory_store import list_flows, load_flow, record_flow
from camofox.api import tabs as tabs_module
from camofox.domain.profile import get_user_persistence_paths, persist_storage_state
from camofox.domain.replay import ReplayError, replay_flow_steps
from camofox.domain import replay as replay_module


class FakeBrowser:
    def __init__(self):
        self.context_options = None

    async def new_context(self, **kwargs):
        self.context_options = kwargs
        return FakeContext()

class FakeKeyboard:
    def __init__(self, page):
        self.page = page
        self.pressed = []
        self.typed = []

    async def press(self, key):
        self.pressed.append(key)

    async def type(self, text, **_kwargs):
        self.typed.append(text)


class FakeLocator:
    def __init__(self, page, selector):
        self.page = page
        self.selector = selector

    async def count(self):
        return self.page.selector_counts.get(self.selector, 0)

    async def focus(self, **_kwargs):
        self.page.focused.append(self.selector)

    async def evaluate(self, _expression):
        self.page.focused.append(self.selector)

    async def click(self, **_kwargs):
        self.page.clicked.append(self.selector)

    async def set_input_files(self, paths, **kwargs):
        self.page.uploaded_files.append({"selector": self.selector, "paths": paths, "kwargs": kwargs})

    async def bounding_box(self, **_kwargs):
        if self.page.selector_counts.get(self.selector, 0) > 0:
            return {"x": 1, "y": 1, "width": 10, "height": 10}
        return None


class FakePage:
    def __init__(self):
        self.url = "about:blank"
        self.snapshot_yaml = None
        self.snapshot_refs = None
        self.goto_calls = []
        self.selector_counts = {}
        self.clicked = []
        self.typed = []
        self.focused = []
        self.uploaded_files = []
        self.keyboard = FakeKeyboard(self)
        self.mouse = SimpleNamespace(
            move=lambda *_args, **_kwargs: None,
            down=lambda *_args, **_kwargs: None,
            up=lambda *_args, **_kwargs: None,
        )
        self.closed = False
        self.reload_calls = []
        self.back_calls = []
        self.forward_calls = []

    async def goto(self, url, **kwargs):
        self.url = url
        self.goto_calls.append({"url": url, **kwargs})
        return None

    async def reload(self, **kwargs):
        self.reload_calls.append(kwargs)
        return None

    async def go_back(self, **kwargs):
        self.url = "https://example.com/back"
        self.back_calls.append(kwargs)
        return None

    async def go_forward(self, **kwargs):
        self.url = "https://example.com/forward"
        self.forward_calls.append(kwargs)
        return None

    def locator(self, selector):
        return FakeLocator(self, selector)

    async def click(self, selector, **_kwargs):
        self.clicked.append(selector)

    async def fill(self, selector, text, **_kwargs):
        self.typed.append((selector, text))

    async def type(self, selector, text, **_kwargs):
        self.typed.append((selector, text))

    async def evaluate(self, expression):
        expression_str = str(expression)
        if "document.body" in expression_str or "TreeWalker" in expression_str or "querySelectorAll" in expression_str:
            if self.snapshot_refs is not None:
                return self.snapshot_refs
            return []
        return {"expression": expression}

    async def close(self):
        self.closed = True

    async def query_selector(self, selector):
        if self.selector_counts.get(selector, 0) > 0:
            return object()
        return None

    async def mouse_wheel(self, delta_x, delta_y):
        self.scrolled = getattr(self, "scrolled", [])
        self.scrolled.append((delta_x, delta_y))

    def on(self, _event, _handler):
        return None


class FakeContext:

    def __init__(self, state=None):
        self._state = state or {"cookies": [], "origins": []}
        self.closed = False
        self.pages = []

    async def storage_state(self):
        return self._state

    async def close(self):
        self.closed = True

    async def add_init_script(self, _script):
        return None

    async def new_page(self):
        page = FakePage()
        self.pages.append(page)
        return page

    def on(self, _event, _handler):
        return None


@pytest.fixture(autouse=True)
def clear_sessions():
    sessions.clear()
    yield
    sessions.clear()


@pytest.mark.asyncio
async def test_close_session_persists_storage_state(tmp_path, monkeypatch):
    monkeypatch.setattr(global_config, "profile_dir", str(tmp_path))
    context = FakeContext({"cookies": [{"name": "sid", "value": "abc", "domain": "example.com", "path": "/"}], "origins": []})
    session = SessionState(context=context, engine="camoufox-python", profile_dir=str(tmp_path))
    sessions[make_browser_key("camoufox-python", "julien")] = session

    await close_session("julien", session, reason="test")

    path = get_user_persistence_paths(str(tmp_path), "julien")["storage_state"]
    assert path.is_file()
    assert '"sid"' in path.read_text()


@pytest.mark.asyncio
async def test_create_session_loads_persisted_storage_state(tmp_path, monkeypatch):
    monkeypatch.setattr(global_config, "profile_dir", str(tmp_path))
    context = FakeContext({"cookies": [{"name": "sid", "value": "abc", "domain": "example.com", "path": "/"}], "origins": []})
    await persist_storage_state(str(tmp_path), "julien", context)

    fake_browser = FakeBrowser()

    async def fake_ensure_browser(*_args, **_kwargs):
        return {"browser": fake_browser, "persona": {}, "display": None, "launch_proxy": None}

    monkeypatch.setattr(browser_module, "ensure_browser", fake_ensure_browser)

    session = await session_module._create_session("julien", profile_dir=str(tmp_path), engine="camoufox-python")

    assert session.profile_dir == str(tmp_path)
    assert fake_browser.context_options["storage_state"] == str(
        get_user_persistence_paths(str(tmp_path), "julien")["storage_state"]
    )


def test_record_flow_persists_and_redacts_sensitive_values(tmp_path):
    result = record_flow(
        "profile-a",
        [{"action": "type", "params": {"password": "secret", "text": "visible"}}],
        flow_id="login",
        profile_dir=str(tmp_path),
    )

    loaded = load_flow("profile-a", "login", profile_dir=str(tmp_path))
    assert result["flow_id"] == "login"
    assert loaded is not None
    assert loaded["flow"][0]["params"]["password"] == "[REDACTED]"
    assert loaded["flow"][0]["params"]["text"] == "visible"


def test_memory_store_rejects_unsafe_flow_ids(tmp_path):
    for unsafe in ("../escape", "nested/path", "", ".hidden", "bad flow", "x" * 129):
        with pytest.raises(ValueError, match="flow_id"):
            record_flow("profile-a", [{"action": "navigate"}], flow_id=unsafe, profile_dir=str(tmp_path))
        with pytest.raises(ValueError, match="flow_id"):
            load_flow("profile-a", unsafe, profile_dir=str(tmp_path))

    record_flow("profile-a", [{"action": "navigate"}], flow_id="safe.flow_id-1", profile_dir=str(tmp_path))
    assert load_flow("profile-a", "safe.flow_id-1", profile_dir=str(tmp_path)) is not None
    listed = list_flows("profile-a", profile_dir=str(tmp_path))
    assert [flow["flow_id"] for flow in listed] == ["safe.flow_id-1"]
    assert not (tmp_path / "escape.json").exists()


def test_managed_memory_rejects_unsafe_flow_id_endpoint(tmp_path, monkeypatch):
    monkeypatch.setattr(global_config, "profile_dir", str(tmp_path))
    app = create_app(Config(profile_dir=str(tmp_path)))
    client = TestClient(app, client=("127.0.0.1", 50000))

    record = client.post(
        "/managed/cli/memory/record",
        json={"profile": "profile-a", "flow_id": "../escape", "flow": [{"action": "navigate"}]},
    )
    assert record.status_code == 400
    assert "flow_id" in str(record.json())

    inspect = client.post("/managed/cli/memory/inspect", json={"profile": "profile-a", "flow_id": "../escape"})
    assert inspect.status_code == 400
    assert "flow_id" in str(inspect.json())

    replay = client.post("/managed/cli/memory/replay", json={"profile": "profile-a", "flow_id": "../escape"})
    assert replay.status_code == 400
    assert "flow_id" in str(replay.json())

    assert not (tmp_path / "escape.json").exists()


def test_managed_memory_record_and_replay_endpoint(tmp_path, monkeypatch):
    monkeypatch.setattr(global_config, "profile_dir", str(tmp_path))
    app = create_app(Config(profile_dir=str(tmp_path)))
    client = TestClient(app, client=("127.0.0.1", 50000))

    record = client.post(
        "/managed/cli/memory/record",
        json={
            "profile": "profile-a",
            "flow_id": "login",
            "flow": [{"action": "navigate", "url": "https://example.com"}],
            "metadata": {"token": "must-not-leak"},
        },
    )
    assert record.status_code == 200
    assert record.json()["flowId"] == "login"

    replay = client.post(
        "/managed/cli/memory/replay",
        json={"profile": "profile-a", "flow_id": "login"},
    )
    assert replay.status_code == 200
    body = replay.json()
    assert body["executed"] is False
    assert body["flow"][0]["action"] == "navigate"
    assert body["metadata"]["token"] == "[REDACTED]"


def test_managed_memory_list_and_inspect_auto_record_flow(tmp_path, monkeypatch):
    monkeypatch.setattr(global_config, "profile_dir", str(tmp_path))
    app = create_app(Config(profile_dir=str(tmp_path)))
    client = TestClient(app, client=("127.0.0.1", 50000))
    record_flow(
        "profile-a",
        [
            {"action": "navigate", "url": "https://example.com"},
            {"action": "click", "ref": "@login", "target_summary": {"name": "Login"}},
        ],
        flow_id=tabs_module.AUTO_HISTORY_FLOW_ID,
        metadata={"source": "auto-record", "token": "must-not-leak"},
        profile_dir=str(tmp_path),
    )

    listed = client.post("/managed/cli/memory/list", json={"profile": "profile-a"})
    assert listed.status_code == 200
    listed_body = listed.json()
    assert listed_body["ok"] is True
    assert listed_body["count"] == 1
    assert listed_body["flows"][0]["flow_id"] == tabs_module.AUTO_HISTORY_FLOW_ID
    assert "flow" not in listed_body["flows"][0]
    assert listed_body["flows"][0]["metadata"]["token"] == "[REDACTED]"

    listed_with_flow = client.post("/managed/cli/memory/list", json={"profile": "profile-a", "include_flow": True})
    assert listed_with_flow.status_code == 200
    assert listed_with_flow.json()["flows"][0]["flow"][1]["action"] == "click"

    inspected = client.post("/managed/cli/memory/inspect", json={"profile": "profile-a"})
    assert inspected.status_code == 200
    inspected_body = inspected.json()
    assert inspected_body["flowId"] == tabs_module.AUTO_HISTORY_FLOW_ID
    assert inspected_body["step_count"] == 2
    assert [step["action"] for step in inspected_body["flow"]] == ["navigate", "click"]
    assert inspected_body["metadata"]["token"] == "[REDACTED]"
    assert "must-not-leak" not in str(inspected_body)

    exported = client.post("/managed/cli/memory/export", json={"profile": "profile-a"})
    assert exported.status_code == 200
    assert exported.json() == inspected_body

    replay_default = client.post("/managed/cli/memory/replay", json={"profile": "profile-a"})
    assert replay_default.status_code == 200
    replay_default_body = replay_default.json()
    assert replay_default_body["flowId"] == tabs_module.AUTO_HISTORY_FLOW_ID
    assert replay_default_body["executed"] is False
    assert [step["action"] for step in replay_default_body["flow"]] == ["navigate", "click"]

    missing = client.post("/managed/cli/memory/export", json={"profile": "profile-a", "flow_id": "missing"})
    assert missing.status_code == 404
    assert "missing" in str(missing.json())

    missing_default_replay = client.post("/managed/cli/memory/replay", json={"profile": "empty-profile"})
    assert missing_default_replay.status_code == 404
    assert tabs_module.AUTO_HISTORY_FLOW_ID in str(missing_default_replay.json())


@pytest.mark.asyncio
async def test_managed_memory_replay_execute_runs_navigation_without_llm(tmp_path, monkeypatch):
    monkeypatch.setattr(global_config, "profile_dir", str(tmp_path))
    app = create_app(Config(profile_dir=str(tmp_path)))
    client = TestClient(app, client=("127.0.0.1", 50000))
    fake_browser = FakeBrowser()

    async def fake_ensure_browser(*_args, **_kwargs):
        return {"browser": fake_browser, "persona": {}, "display": None, "launch_proxy": None}

    monkeypatch.setattr(browser_module, "ensure_browser", fake_ensure_browser)
    record_flow(
        "profile-a",
        [{"action": "navigate", "url": "https://example.com"}],
        flow_id="login",
        profile_dir=str(tmp_path),
    )

    replay = client.post(
        "/managed/cli/memory/replay",
        json={"profile": "profile-a", "flow_id": "login", "execute": True},
    )

    assert replay.status_code == 200
    body = replay.json()
    assert body["executed"] is True
    assert body["stepCount"] == 1
    assert body["url"] == "https://example.com"
    assert fake_browser.context_options is not None


@pytest.mark.asyncio
async def test_managed_cli_snapshot_returns_dom_snapshot_and_refs(tmp_path, monkeypatch):
    monkeypatch.setattr(global_config, "profile_dir", str(tmp_path))
    app = create_app(Config(profile_dir=str(tmp_path)))
    client = TestClient(app, client=("127.0.0.1", 50000))
    session = SessionState(context=FakeContext(), engine="camoufox-python", profile_dir=str(tmp_path))
    page = FakePage()
    page.url = "https://example.com/snapshot"
    page.snapshot_refs = [
        {"tag": "body", "role": "document", "name": "", "depth": 0, "interactive": False, "selector": "body"},
        {"tag": "button", "role": "button", "name": "Login", "depth": 1, "interactive": True, "selector": "#login"},
    ]
    tab_state = TabState(page=page)
    session.tab_groups["managed"] = {"tab-1": tab_state}
    sessions[make_browser_key("camoufox-python", "example-demo")] = session

    response = client.post("/managed/cli/snapshot", json={"profile": "example-demo"})

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    result = body["result"]
    assert result["url"] == "https://example.com/snapshot"
    assert "login" in result["snapshot"]
    assert result["refs"]["e1"]["selector"] == "#login"
    assert tab_state.refs["e1"]["name"] == "login"


@pytest.mark.asyncio
async def test_managed_cli_act_executes_single_action_via_replay(tmp_path, monkeypatch):
    monkeypatch.setattr(global_config, "profile_dir", str(tmp_path))
    app = create_app(Config(profile_dir=str(tmp_path)))
    client = TestClient(app, client=("127.0.0.1", 50000))
    fake_browser = FakeBrowser()

    async def fake_ensure_browser(*_args, **_kwargs):
        return {"browser": fake_browser, "persona": {}, "display": None, "launch_proxy": None}

    monkeypatch.setattr(browser_module, "ensure_browser", fake_ensure_browser)

    response = client.post(
        "/managed/cli/act",
        json={"profile": "profile-a", "action": "navigate", "params": {"url": "https://example.com"}},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["action"] == "navigate"
    assert body["result"]["url"] == "https://example.com"
    assert body["replay"]["executed"] is True


@pytest.mark.asyncio
async def test_managed_cli_act_fails_closed_on_bad_action(tmp_path):
    app = create_app(Config(profile_dir=str(tmp_path)))
    client = TestClient(app, client=("127.0.0.1", 50000))

    response = client.post("/managed/cli/act", json={"profile": "profile-a", "action": "definitely-unsupported"})

    assert response.status_code == 422
    assert "Unsupported replay action" in response.json()["detail"]["error"]


@pytest.mark.asyncio
async def test_managed_checkpoint_persists_storage_state(tmp_path, monkeypatch):
    monkeypatch.setattr(global_config, "profile_dir", str(tmp_path))
    app = create_app(Config(profile_dir=str(tmp_path)))
    client = TestClient(app, client=("127.0.0.1", 50000))
    session = SessionState(
        context=FakeContext({"cookies": [{"name": "sid", "value": "abc", "domain": "example.com", "path": "/"}], "origins": []}),
        engine="camoufox-python",
        profile_dir=str(tmp_path),
    )
    sessions[make_browser_key("camoufox-python", "profile-a")] = session

    response = client.post("/managed/cli/checkpoint", json={"profile": "profile-a"})

    assert response.status_code == 200
    assert response.json()["checkpointed"] is True
    assert get_user_persistence_paths(str(tmp_path), "profile-a")["storage_state"].is_file()


@pytest.mark.asyncio
async def test_close_session_persists_storage_state_before_closing_pages(tmp_path, monkeypatch):
    monkeypatch.setattr(global_config, "profile_dir", str(tmp_path))
    order: list[str] = []
    context = FakeContext({"cookies": [{"name": "sid", "value": "abc", "domain": "example.com", "path": "/"}], "origins": []})
    page = FakePage()

    original_storage_state = context.storage_state
    original_page_close = page.close
    original_context_close = context.close

    async def tracked_storage_state():
        order.append("storage_state")
        assert not page.closed
        assert not context.closed
        return await original_storage_state()

    async def tracked_page_close():
        order.append("page_close")
        await original_page_close()

    async def tracked_context_close():
        order.append("context_close")
        await original_context_close()

    context.storage_state = tracked_storage_state
    page.close = tracked_page_close
    context.close = tracked_context_close
    session = SessionState(context=context, engine="camoufox-python", profile_dir=str(tmp_path))
    session.tab_groups["default"] = {"tab-1": TabState(page=page)}
    sessions[make_browser_key("camoufox-python", "julien")] = session

    await close_session("julien", session, reason="test")

    assert order == ["storage_state", "page_close", "context_close"]
    assert get_user_persistence_paths(str(tmp_path), "julien")["storage_state"].is_file()


@pytest.mark.asyncio
async def test_replay_repairs_stale_ref_from_target_summary_without_llm(monkeypatch):
    page = FakePage()
    page.selector_counts = {"#old-login": 0, "#new-login": 1}
    tab_state = TabState(page=page, refs={"@old": {"selector": "#old-login"}})
    session = SessionState(context=FakeContext(), engine="camoufox-python")
    session.tab_groups["default"] = {"tab-1": tab_state}

    async def fake_build_snapshot(_page):
        return "button Login", {
            "@new": {
                "selector": "#new-login",
                "role": "button",
                "name": "Login",
                "text": "Login",
                "attributes": {"id": "new-login"},
            }
        }

    async def fake_human_click(page_arg, selector, **_kwargs):
        page_arg.clicked.append(selector)
        return {"ok": True}

    monkeypatch.setattr(replay_module, "build_snapshot", fake_build_snapshot)
    monkeypatch.setattr(replay_module, "human_click", fake_human_click)

    result = await replay_flow_steps(
        session,
        user_id="julien",
        flow=[
            {
                "action": "click",
                "ref": "@old",
                "target_summary": {
                    "role": "button",
                    "name": "Login",
                    "text": "Login",
                    "attributes": {"id": "new-login"},
                },
            }
        ],
    )

    assert result["ok"] is True
    assert result["results"][0]["mode"] == "repaired"
    assert result["results"][0]["llm_used"] is False
    assert result["results"][0]["selector"] == "#new-login"
    assert page.clicked == ["#new-login"]


@pytest.mark.asyncio
async def test_replay_resolves_node_style_placeholders_and_fails_missing_params(monkeypatch):
    page = FakePage()
    page.selector_counts = {"#q": 1}
    tab_state = TabState(page=page, refs={"@input": {"selector": "#q"}})
    session = SessionState(context=FakeContext(), engine="camoufox-python")
    session.tab_groups["default"] = {"tab-1": tab_state}

    async def fake_human_type(page_arg, selector, text, **_kwargs):
        page_arg.typed.append((selector, text))
        return {"ok": True, "chars": len(text)}

    monkeypatch.setattr(replay_module, "human_type", fake_human_type)

    result = await replay_flow_steps(
        session,
        user_id="julien",
        params={"query": "camoufox"},
        flow=[{"action": "type", "ref": "@input", "text": "search {{query}}"}],
    )

    assert result["results"][0]["chars"] == len("search camoufox")
    assert page.typed == [("#q", "search camoufox")]

    with pytest.raises(ReplayError, match="requires parameter"):
        await replay_flow_steps(
            session,
            user_id="julien",
            flow=[{"action": "type", "ref": "@input", "text": "search {{missing}}"}],
        )


@pytest.mark.asyncio
async def test_replay_refuses_redacted_secret_input():
    page = FakePage()
    page.selector_counts = {"#password": 1}
    tab_state = TabState(page=page, refs={"@password": {"selector": "#password"}})
    session = SessionState(context=FakeContext(), engine="camoufox-python")
    session.tab_groups["default"] = {"tab-1": tab_state}

    for redacted_text in ("__REDACTED__", "[REDACTED]", "<REDACTED>"):
        with pytest.raises(ReplayError, match="redacted input"):
            await replay_flow_steps(
                session,
                user_id="julien",
                flow=[{"action": "type", "ref": "@password", "text": redacted_text, "text_redacted": True}],
            )


@pytest.mark.asyncio
async def test_replay_supports_file_upload_with_node_style_path_fields(tmp_path):
    page = FakePage()
    page.selector_counts = {"#upload": 1}
    tab_state = TabState(page=page, refs={"@upload": {"selector": "#upload"}})
    session = SessionState(context=FakeContext(), engine="camoufox-python")
    session.tab_groups["default"] = {"tab-1": tab_state}
    first = tmp_path / "first.txt"
    second = tmp_path / "second.txt"
    first.write_text("a")
    second.write_text("b")

    result = await replay_flow_steps(
        session,
        user_id="julien",
        flow=[{"action": "file_upload", "ref": "@upload", "paths": f"{first}, {second}"}],
    )

    assert result["ok"] is True
    assert result["results"][0]["action"] == "file-upload"
    assert result["results"][0]["uploaded"] == 2
    assert page.uploaded_files == [
        {"selector": "#upload", "paths": [str(first), str(second)], "kwargs": {"timeout": 30000}}
    ]


@pytest.mark.asyncio
async def test_replay_file_upload_supports_placeholders_and_missing_paths(tmp_path):
    page = FakePage()
    page.selector_counts = {"#upload": 1}
    tab_state = TabState(page=page, refs={"@upload": {"selector": "#upload"}})
    session = SessionState(context=FakeContext(), engine="camoufox-python")
    session.tab_groups["default"] = {"tab-1": tab_state}
    upload = tmp_path / "upload.txt"
    upload.write_text("x")

    result = await replay_flow_steps(
        session,
        user_id="julien",
        params={"upload_path": str(upload)},
        flow=[{"action": "fileUpload", "ref": "@upload", "path": "{{upload_path}}"}],
    )

    assert result["results"][0]["paths"] == [str(upload)]
    assert page.uploaded_files[-1]["paths"] == [str(upload)]

    with pytest.raises(ReplayError, match="requires paths"):
        await replay_flow_steps(session, user_id="julien", flow=[{"action": "file_upload", "ref": "@upload"}])

    with pytest.raises(ReplayError, match="requires parameter"):
        await replay_flow_steps(
            session,
            user_id="julien",
            flow=[{"action": "file_upload", "ref": "@upload", "files": ["{{missing_upload}}"]}],
        )


@pytest.mark.asyncio
async def test_tab_routes_auto_record_successful_actions_without_llm(tmp_path, monkeypatch):
    monkeypatch.setattr(global_config, "profile_dir", str(tmp_path))
    page = FakePage()
    page.selector_counts = {"#login": 1, "#q": 1}
    tab_state = TabState(
        page=page,
        refs={
            "@login": {"selector": "#login", "role": "button", "name": "Login", "attributes": {"id": "login"}},
            "@q": {"selector": "#q", "role": "textbox", "name": "Search", "attributes": {"name": "q"}},
        },
    )
    session = SessionState(context=FakeContext(), engine="camoufox-python", profile_dir=str(tmp_path))
    session.tab_groups["default"] = {"tab-1": tab_state}
    sessions[make_browser_key("camoufox-python", "profile-a")] = session

    async def fake_with_tab_lock(_tab_id, fn):
        return await fn()

    async def fake_human_click(page_arg, selector, **_kwargs):
        page_arg.clicked.append(selector)
        return {"ok": True}

    async def fake_human_type(page_arg, selector, text, **_kwargs):
        page_arg.typed.append((selector, text))
        return {"ok": True, "chars": len(text)}

    monkeypatch.setattr(tabs_module, "with_tab_lock", fake_with_tab_lock)
    monkeypatch.setattr(tabs_module, "human_click", fake_human_click)
    monkeypatch.setattr(tabs_module, "human_type", fake_human_type)

    assert await tabs_module.navigate_tab("tab-1", tabs_module.NavigateRequest(userId="profile-a", url="https://example.com")) == {"ok": True, "url": "https://example.com"}
    assert await tabs_module.click_tab("tab-1", tabs_module.ClickRequest(userId="profile-a", ref="@login")) == {"ok": True, "ref": "@login"}
    assert await tabs_module.type_tab("tab-1", tabs_module.TypeRequest(userId="profile-a", ref="@q", text="hello")) == {"ok": True, "ref": "@q", "chars": 5}

    loaded = load_flow("profile-a", tabs_module.AUTO_HISTORY_FLOW_ID, profile_dir=str(tmp_path))
    assert loaded is not None
    flow = loaded["flow"]
    assert [step["action"] for step in flow] == ["navigate", "click", "type"]
    assert flow[1]["target_summary"]["name"] == "Login"
    assert flow[2]["text"] == "hello"
    assert session.tab_groups["default"]["tab-1"].agent_history_steps[-1]["action"] == "type"


@pytest.mark.asyncio
async def test_tab_routes_auto_record_press_and_scroll(tmp_path, monkeypatch):
    page = FakePage()
    session = SessionState(context=FakeContext(), engine="camoufox-python", profile_dir=str(tmp_path))
    session.tab_groups["default"] = {"tab-1": TabState(page=page)}
    sessions[make_browser_key("camoufox-python", "profile-a")] = session

    async def fake_with_tab_lock(_tab_id, fn):
        return await fn()

    async def fake_human_press(page_arg, key, **_kwargs):
        await page_arg.keyboard.press(key)
        return {"ok": True}

    async def fake_human_scroll(page_arg, direction="down", **_kwargs):
        page_arg.scrolled = getattr(page_arg, "scrolled", [])
        page_arg.scrolled.append(direction)
        return {"ok": True}

    monkeypatch.setattr(tabs_module, "with_tab_lock", fake_with_tab_lock)
    monkeypatch.setattr(tabs_module, "human_press", fake_human_press)
    monkeypatch.setattr(tabs_module, "human_scroll", fake_human_scroll)

    assert await tabs_module.press_tab("tab-1", tabs_module.PressRequest(userId="profile-a", key="Enter")) == {"ok": True, "key": "Enter"}
    assert await tabs_module.scroll_tab("tab-1", tabs_module.ScrollRequest(userId="profile-a", direction="down")) == {"ok": True, "direction": "down"}

    loaded = load_flow("profile-a", tabs_module.AUTO_HISTORY_FLOW_ID, profile_dir=str(tmp_path))
    assert loaded is not None
    assert [step["action"] for step in loaded["flow"]] == ["press", "scroll"]
    assert loaded["flow"][0]["key"] == "Enter"
    assert loaded["flow"][1]["direction"] == "down"


@pytest.mark.asyncio
async def test_tab_routes_auto_record_redacts_direct_sensitive_selector(tmp_path):
    page = FakePage()
    tab_state = TabState(page=page)
    session = SessionState(context=FakeContext(), engine="camoufox-python", profile_dir=str(tmp_path))
    session.tab_groups["default"] = {"tab-1": tab_state}

    tabs_module._record_successful_tab_action(
        session,
        tab_state,
        "profile-a",
        "tab-1",
        {"action": "type", "ref": "#password", "selector": "#password", "text": "clear-value"},
    )

    loaded = load_flow("profile-a", tabs_module.AUTO_HISTORY_FLOW_ID, profile_dir=str(tmp_path))
    assert loaded is not None
    step = loaded["flow"][0]
    assert step["target_summary"] == {"selector": "#password"}
    assert step["text"] == "[REDACTED]"
    assert step["text_redacted"] is True
    assert "clear-value" not in str(loaded)


@pytest.mark.asyncio
async def test_tab_routes_auto_record_redacts_sensitive_type_targets(tmp_path, monkeypatch):
    page = FakePage()
    page.selector_counts = {"#password": 1}
    tab_state = TabState(
        page=page,
        refs={"@pwd": {"selector": "#password", "role": "textbox", "name": "Password", "attributes": {"type": "password"}}},
    )
    session = SessionState(context=FakeContext(), engine="camoufox-python", profile_dir=str(tmp_path))
    session.tab_groups["default"] = {"tab-1": tab_state}
    sessions[make_browser_key("camoufox-python", "profile-a")] = session

    async def fake_with_tab_lock(_tab_id, fn):
        return await fn()

    async def fake_human_type(page_arg, selector, text, **_kwargs):
        page_arg.typed.append((selector, text))
        return {"ok": True, "chars": len(text)}

    monkeypatch.setattr(tabs_module, "with_tab_lock", fake_with_tab_lock)
    monkeypatch.setattr(tabs_module, "human_type", fake_human_type)

    response = await tabs_module.type_tab("tab-1", tabs_module.TypeRequest(userId="profile-a", ref="@pwd", text="super-secret"))

    assert response == {"ok": True, "ref": "@pwd", "chars": len("super-secret")}
    loaded = load_flow("profile-a", tabs_module.AUTO_HISTORY_FLOW_ID, profile_dir=str(tmp_path))
    assert loaded is not None
    step = loaded["flow"][0]
    assert step["action"] == "type"
    assert step["text"] == "[REDACTED]"
    assert step["text_redacted"] is True
    assert "super-secret" not in str(loaded)

    with pytest.raises(ReplayError, match="redacted input"):
        await replay_flow_steps(session, user_id="profile-a", flow=loaded["flow"])
