"""Browser engine helpers for managed browser dispatch."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from camofox.core.utils import normalize_user_id

CAMOUFOX_PYTHON = "camoufox-python"
CLOAKBROWSER = "cloakbrowser"
CAMOFOX_NODE = "camofox-node"

_ENGINE_ALIASES = {
    "": CAMOUFOX_PYTHON,
    "camoufox": CAMOUFOX_PYTHON,
    "camoufox-146": CAMOUFOX_PYTHON,
    "camoufox-python": CAMOUFOX_PYTHON,
    "camoufox_python": CAMOUFOX_PYTHON,
    "cloak": CLOAKBROWSER,
    "cloakbrowser": CLOAKBROWSER,
    "cloak-browser": CLOAKBROWSER,
    "cloak_browser": CLOAKBROWSER,
    "camofox": CAMOFOX_NODE,
    "camofox-node": CAMOFOX_NODE,
    "camofox_node": CAMOFOX_NODE,
    "node": CAMOFOX_NODE,
}

LOCAL_ENGINES = {CAMOUFOX_PYTHON, CLOAKBROWSER}
SUPPORTED_ENGINES = {CAMOUFOX_PYTHON, CLOAKBROWSER, CAMOFOX_NODE}


@dataclass
class BrowserLaunchResult:
    browser: Any
    engine: str
    profile_dir: str | None = None
    launch_proxy: dict | None = None
    display: str | None = None
    persona: dict | None = None
    executable_path: str | None = None
    camoufox: Any | None = None
    playwright: Any | None = None


def normalize_engine(value: str | None, default: str = CAMOUFOX_PYTHON) -> str:
    raw = (value or default or CAMOUFOX_PYTHON).strip().lower()
    engine = _ENGINE_ALIASES.get(raw)
    if engine is None:
        raise ValueError(
            f"Unsupported browser engine '{value}'. Supported engines: "
            f"{', '.join(sorted(SUPPORTED_ENGINES))}"
        )
    return engine


def make_browser_key(engine: str | None, user_id: str) -> str:
    return f"{normalize_engine(engine)}:{normalize_user_id(user_id)}"
