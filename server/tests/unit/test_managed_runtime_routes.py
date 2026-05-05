from __future__ import annotations

from fastapi.testclient import TestClient

from camofox.core.app import create_app
from camofox.core.config import Config, config as global_config
from camofox.domain.memory_store import record_flow
from camofox.domain.notifications_store import add_notification


def test_legacy_flow_list_inspect_and_dry_run(tmp_path, monkeypatch):
    monkeypatch.setattr(global_config, "profile_dir", str(tmp_path))
    app = create_app(Config(profile_dir=str(tmp_path)))
    client = TestClient(app, client=("127.0.0.1", 50000))
    record_flow(
        "profile-a",
        [{"action": "navigate", "url": "https://example.com"}],
        flow_id="login",
        metadata={"token": "must-redact"},
        profile_dir=str(tmp_path),
    )
    record_flow(
        "profile-a",
        [{"action": "click", "ref": "@go", "target_summary": {"name": "Go"}}],
        flow_id="browser-actions",
        metadata={"source": "auto-record"},
        profile_dir=str(tmp_path),
    )

    listed = client.post("/flow/list", json={"profile": "profile-a", "site": "example"})
    assert listed.status_code == 200
    listed_body = listed.json()
    assert listed_body["success"] is True
    assert listed_body["result"]["count"] == 2
    listed_flows = {flow["flow_id"]: flow for flow in listed_body["result"]["flows"]}
    assert listed_flows["login"]["metadata"]["token"] == "[REDACTED]"
    assert listed_flows["browser-actions"]["metadata"]["source"] == "auto-record"
    assert "must-redact" not in str(listed_body)

    inspected = client.post("/flow/inspect", json={"profile": "profile-a", "site": "example", "flow": "login"})
    assert inspected.status_code == 200
    inspected_body = inspected.json()
    assert inspected_body["success"] is True
    assert inspected_body["result"]["flowId"] == "login"
    assert inspected_body["result"]["metadata"]["token"] == "[REDACTED]"
    assert inspected_body["result"]["flow"][0]["action"] == "navigate"
    assert "must-redact" not in str(inspected_body)

    dry_run = client.post("/flow/run", json={"profile": "profile-a", "site": "example", "flow": "login", "execute": False})
    assert dry_run.status_code == 200
    assert dry_run.json()["result"]["executed"] is False
    assert dry_run.json()["result"]["flowId"] == "login"
    assert dry_run.json()["result"]["steps"][0]["action"] == "navigate"

    default_dry_run = client.post("/flow/run", json={"profile": "profile-a", "site": "example", "execute": False})
    assert default_dry_run.status_code == 200
    assert default_dry_run.json()["result"]["executed"] is False
    assert default_dry_run.json()["result"]["flowId"] == "browser-actions"
    assert default_dry_run.json()["result"]["steps"][0]["action"] == "click"

    missing = client.post("/flow/inspect", json={"profile": "profile-a", "site": "example", "flow": "missing"})
    assert missing.status_code == 404
    assert "missing" in str(missing.json())

    missing_default_run = client.post("/flow/run", json={"profile": "empty-profile", "site": "example", "execute": False})
    assert missing_default_run.status_code == 404
    assert "browser-actions" in str(missing_default_run.json())

    unsafe_inspect = client.post("/flow/inspect", json={"profile": "profile-a", "site": "example", "flow": "../escape"})
    assert unsafe_inspect.status_code == 400
    assert "flow_id" in str(unsafe_inspect.json())

    unsafe_run = client.post("/flow/run", json={"profile": "profile-a", "site": "example", "flow": "../escape", "execute": False})
    assert unsafe_run.status_code == 400
    assert "flow_id" in str(unsafe_run.json())


def test_legacy_notifications_are_persistent(tmp_path, monkeypatch):
    monkeypatch.setattr(global_config, "profile_dir", str(tmp_path))
    app = create_app(Config(profile_dir=str(tmp_path)))
    client = TestClient(app, client=("127.0.0.1", 50000))

    enabled = client.post("/notifications/enable", json={"profile": "profile-a", "site": "example", "confirm": True})
    assert enabled.status_code == 200
    assert enabled.json()["result"]["enabled"] is True

    self_test = client.post("/notifications/self-test", json={"profile": "profile-a", "site": "example", "origin": "unit"})
    assert self_test.status_code == 200
    notification_id = self_test.json()["result"]["notification"]["id"]

    app2 = create_app(Config(profile_dir=str(tmp_path)))
    client2 = TestClient(app2, client=("127.0.0.1", 50001))
    listed = client2.post("/notifications/list", json={"profile": "profile-a", "site": "example"})
    assert listed.status_code == 200
    assert listed.json()["result"]["count"] == 1
    assert listed.json()["result"]["notifications"][0]["id"] == notification_id

    watched = client2.post("/notifications/watch", json={"profile": "profile-a", "site": "example"})
    assert watched.status_code == 200
    assert watched.json()["result"]["count"] == 1

    marked = client2.post("/notifications/mark-read", json={"profile": "profile-a", "site": "example"})
    assert marked.status_code == 200
    assert marked.json()["result"]["marked"] == 1


def test_native_notifications_poll_marks_unread_without_deleting(tmp_path, monkeypatch):
    monkeypatch.setattr(global_config, "profile_dir", str(tmp_path))
    add_notification("profile-a", {"title": "hello"}, profile_dir=str(tmp_path))
    app = create_app(Config(profile_dir=str(tmp_path)))
    client = TestClient(app, client=("127.0.0.1", 50000))

    poll = client.post("/notifications/poll", json={"userId": "profile-a"})
    assert poll.status_code == 200
    assert poll.json()["count"] == 1

    listed = client.post("/notifications/list", json={"profile": "profile-a", "site": "example"})
    assert listed.status_code == 200
    assert listed.json()["result"]["count"] == 1
    assert listed.json()["result"]["notifications"][0]["read"] is True


def test_managed_job_and_recovery_registry_persist(tmp_path, monkeypatch):
    monkeypatch.setattr(global_config, "profile_dir", str(tmp_path))
    app = create_app(Config(profile_dir=str(tmp_path)))
    client = TestClient(app, client=("127.0.0.1", 50000))

    recorded = client.post(
        "/managed/jobs/record",
        json={"profile": "profile-a", "kind": "replay", "status": "queued", "payload": {"flow": "login"}},
    )
    assert recorded.status_code == 200
    job_id = recorded.json()["id"]

    updated = client.post("/managed/jobs/update", json={"job_id": job_id, "status": "done", "result": {"ok": True}})
    assert updated.status_code == 200
    assert updated.json()["status"] == "done"

    app2 = create_app(Config(profile_dir=str(tmp_path)))
    client2 = TestClient(app2, client=("127.0.0.1", 50001))
    listed = client2.post("/managed/jobs/list", json={"profile": "profile-a"})
    assert listed.status_code == 200
    assert listed.json()["count"] == 1
    assert listed.json()["jobs"][0]["id"] == job_id
