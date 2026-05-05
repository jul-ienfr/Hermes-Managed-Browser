from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from camofox.api import vnc as vnc_api


def _client(monkeypatch, tmp_path, registry: dict, selection: Path | None = None) -> TestClient:
    registry_file = tmp_path / "camofox-vnc-displays.json"
    registry_file.write_text(json.dumps(registry))
    selection_file = selection or (tmp_path / "camofox-vnc-selected-display.json")

    monkeypatch.setattr("camofox.domain.vnc.DISPLAY_REGISTRY_PATH", registry_file)
    monkeypatch.setattr("camofox.api.vnc.read_display_registry", lambda: json.loads(registry_file.read_text()))
    monkeypatch.setattr("camofox.api.vnc._selection_path", lambda: str(selection_file))

    app = FastAPI()
    app.include_router(vnc_api.router, prefix="/vnc")
    return TestClient(app)


def test_vnc_profiles_keeps_dead_pid_entry_when_display_socket_exists(monkeypatch, tmp_path):
    registry = {
        "leboncoin-cim": {
            "userId": "leboncoin-cim",
            "display": ":1287",
            "pid": 999999999,
            "updatedAt": "2026-05-05T17:00:00Z",
        }
    }
    client = _client(monkeypatch, tmp_path, registry)
    monkeypatch.setattr(vnc_api, "_display_socket_exists", lambda display: display == ":1287")

    response = client.get("/vnc/profiles")

    assert response.status_code == 200
    body = response.json()
    assert [p["userId"] for p in body["profiles"]] == ["leboncoin-cim"]
    assert body["selected"]["userId"] == "leboncoin-cim"


def test_vnc_profiles_hides_dead_pid_entry_without_display_socket(monkeypatch, tmp_path):
    registry = {
        "stale": {
            "userId": "stale",
            "display": ":9999",
            "pid": 999999999,
        }
    }
    client = _client(monkeypatch, tmp_path, registry)
    monkeypatch.setattr(vnc_api, "_display_socket_exists", lambda display: False)

    response = client.get("/vnc/profiles")

    assert response.status_code == 200
    body = response.json()
    assert body["profiles"] == []
    assert body["selected"] is None


def test_vnc_select_writes_node_compatible_selection_json(monkeypatch, tmp_path):
    registry = {
        "leboncoin-cim": {
            "userId": "leboncoin-cim",
            "display": ":1287",
            "pid": 999999999,
        }
    }
    selection = tmp_path / "camofox-vnc-selected-display.json"
    client = _client(monkeypatch, tmp_path, registry, selection)
    monkeypatch.setattr(vnc_api, "_display_socket_exists", lambda display: True)

    response = client.post("/vnc/select", json={"userId": "leboncoin-cim"})

    assert response.status_code == 200
    selected = json.loads(selection.read_text())
    assert selected["userId"] == "leboncoin-cim"
    assert selected["display"] == ":1287"
