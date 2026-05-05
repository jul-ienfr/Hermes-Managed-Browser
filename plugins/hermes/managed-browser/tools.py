"""Hermes-native Managed Browser helpers.

This module exposes managed_browser_* tools inside Hermes and forwards requests
to the running Managed Browser REST server.
"""

from __future__ import annotations

import base64
import json
import re
import threading
import uuid
from copy import deepcopy
from typing import Any, Dict, Optional
from urllib.parse import parse_qsl, urlparse

import requests

from tools.browser_camofox import get_camofox_url
from tools.registry import tool_error

_DEFAULT_TIMEOUT = 30
_MANAGED_TABS: Dict[str, str] = {}
_MANAGED_TABS_LOCK = threading.Lock()
_TOKEN_PARAM_RE = re.compile(r"(?:token|jwt|session|secret|code|auth|authorization|access[_-]?token|refresh[_-]?token|reset|magic|otp|sso|ticket)", re.I)
_TOKEN_VALUE_RE = re.compile(r"^[A-Za-z0-9._~+/=-]{24,}$")
_TOKEN_PATH_RE = re.compile(r"/(?:token|auth|reset|magic|verify|confirm|sso|callback)/[A-Za-z0-9._~+/=-]{24,}(?:/|$)", re.I)
_BOT_DETECTION_TITLE_RE = re.compile(r"(?:captcha|cloudflare|just a moment|checking your browser|access denied|unusual traffic|are you human|robot|bot detection|security check|attention required)", re.I)

_MANAGED_PROFILES: Dict[str, Dict[str, Any]] = {
    "leboncoin-ju": {
        "profile": "leboncoin-ju",
        "siteKey": "leboncoin",
        "engine": "camoufox-python",
        "userId": "leboncoin-ju",
        "sessionKey": "managed:leboncoin-ju",
        "defaultStartUrl": "https://www.leboncoin.fr/",
        "profileDir": "/home/jul/.vnc-browser-profiles/leboncoin-ju",
        "browserPersonaKey": "managed:leboncoin-ju:browser",
        "humanPersonaKey": "managed:leboncoin-ju:human",
        "defaultHumanProfile": "fast",
        "displayPolicy": {"mode": "managed-autonomous", "allowServerOwnedVisibleLaunch": True},
        "lifecyclePolicy": {"warmup": {"enabled": False, "reason": "manual-profile-only"}, "rotation": {"mode": "manual", "maxSessionAgeMinutes": 240}},
        "securityPolicy": {"site": "leboncoin", "browserOnly": True, "requireConfirmationForBindingActions": True},
    },
    "leboncoin-ju-v2": {
        "profile": "leboncoin-ju-v2",
        "siteKey": "leboncoin",
        "engine": "camoufox-python",
        "userId": "leboncoin-ju-v2",
        "sessionKey": "managed:leboncoin-ju-v2",
        "defaultStartUrl": "https://www.leboncoin.fr/",
        "profileDir": "/home/jul/.vnc-browser-profiles/leboncoin-ju-v2",
        "browserPersonaKey": "managed:leboncoin-ju-v2:browser",
        "humanPersonaKey": "managed:leboncoin-ju-v2:human",
        "defaultHumanProfile": "fast",
        "displayPolicy": {"mode": "managed-autonomous", "allowServerOwnedVisibleLaunch": True},
        "lifecyclePolicy": {"warmup": {"enabled": False, "reason": "manual-profile-only"}, "rotation": {"mode": "manual", "maxSessionAgeMinutes": 240}},
        "securityPolicy": {"site": "leboncoin", "browserOnly": True, "requireConfirmationForBindingActions": True},
    },
    "leboncoin-ge": {
        "profile": "leboncoin-ge",
        "siteKey": "leboncoin",
        "engine": "camoufox-python",
        "userId": "leboncoin-ge",
        "sessionKey": "managed:leboncoin-ge",
        "defaultStartUrl": "https://www.leboncoin.fr/",
        "profileDir": "/home/jul/.vnc-browser-profiles/leboncoin-ge",
        "browserPersonaKey": "managed:leboncoin-ge:browser",
        "humanPersonaKey": "managed:leboncoin-ge:human",
        "defaultHumanProfile": "fast",
        "displayPolicy": {"mode": "managed-autonomous", "allowServerOwnedVisibleLaunch": True},
        "lifecyclePolicy": {"warmup": {"enabled": False, "reason": "manual-profile-only"}, "rotation": {"mode": "manual", "maxSessionAgeMinutes": 240}},
        "securityPolicy": {"site": "leboncoin", "browserOnly": True, "requireConfirmationForBindingActions": True},
    },
    "example-demo": {
        "profile": "example-demo",
        "siteKey": "example",
        "engine": "camoufox-python",
        "userId": "example-demo",
        "sessionKey": "managed:example-demo",
        "defaultStartUrl": "https://example.com/",
        "profileDir": "/home/jul/.vnc-browser-profiles/example-demo",
        "browserPersonaKey": "managed:example-demo:browser",
        "humanPersonaKey": "managed:example-demo:human",
        "defaultHumanProfile": "fast",
        "displayPolicy": {"mode": "managed-autonomous"},
        "lifecyclePolicy": {"warmup": {"enabled": True, "reason": "safe-demo-profile"}, "rotation": {"mode": "manual", "maxSessionAgeMinutes": 60}},
        "securityPolicy": {"site": "example", "browserOnly": True, "requireConfirmationForBindingActions": False},
    },
    "example-demo-cloak": {
        "profile": "example-demo-cloak",
        "siteKey": "example",
        "engine": "cloakbrowser",
        "userId": "example-demo-cloak",
        "sessionKey": "managed:example-demo-cloak",
        "defaultStartUrl": "https://example.com/",
        "profileDir": "/home/jul/.managed-browser/profiles/cloakbrowser/example-demo",
        "browserPersonaKey": "managed:example-demo-cloak:browser",
        "humanPersonaKey": "managed:example-demo-cloak:human",
        "defaultHumanProfile": "fast",
        "displayPolicy": {"mode": "managed-autonomous"},
        "lifecyclePolicy": {"warmup": {"enabled": True, "reason": "safe-demo-profile"}, "rotation": {"mode": "manual", "maxSessionAgeMinutes": 60}},
        "securityPolicy": {"site": "example", "browserOnly": True, "requireConfirmationForBindingActions": False},
    },
}
_PROFILE_ALIASES = {
    "ju": {"profile": "leboncoin-ju", "siteKey": "leboncoin"},
    "ju-v2": {"profile": "leboncoin-ju-v2", "siteKey": "leboncoin"},
    "ge": {"profile": "leboncoin-ge", "siteKey": "leboncoin"},
}
_FORBIDDEN_PROFILES = {"", "default", "camoufox-default", "leboncoin-manual"}
_FORBIDDEN_PROFILE_PATTERNS = (re.compile(r"^camofox-"),)

_MANAGED_PROFILE_PROPERTIES = {
    "profile": {"type": "string", "description": "Explicit managed profile, e.g. leboncoin-ju, leboncoin-ge, ju, or ge."},
    "site": {"type": "string", "description": "Optional site key guard, e.g. leboncoin."},
}


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False)


def _base_url() -> str:
    return get_camofox_url() or "http://127.0.0.1:9377"


def check_enabled() -> bool:
    return bool(_base_url())


def _post(path: str, body: dict, timeout: int = _DEFAULT_TIMEOUT) -> dict:
    resp = requests.post(f"{_base_url()}{path}", json=body, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def _get(path: str, params: Optional[dict] = None, timeout: int = _DEFAULT_TIMEOUT) -> dict:
    resp = requests.get(f"{_base_url()}{path}", params=params, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def _get_raw(path: str, params: Optional[dict] = None, timeout: int = _DEFAULT_TIMEOUT) -> requests.Response:
    resp = requests.get(f"{_base_url()}{path}", params=params, timeout=timeout)
    resp.raise_for_status()
    return resp


def _normalize_profile(profile: str, site: Optional[str] = None) -> str:
    if not isinstance(profile, str) or not profile.strip():
        raise ValueError('managed_browser requires an explicit profile. Use profile="leboncoin-ju" or profile="leboncoin-ge".')
    raw = profile.strip()
    alias = _PROFILE_ALIASES.get(raw)
    if alias:
        if site and site != alias["siteKey"]:
            raise ValueError(f'Profile alias "{raw}" belongs to site "{alias["siteKey"]}", not "{site}".')
        return alias["profile"]
    return raw


def _resolve_profile(profile: str, site: Optional[str] = None) -> Dict[str, Any]:
    normalized = _normalize_profile(profile, site)
    if normalized in _FORBIDDEN_PROFILES or any(p.match(normalized) for p in _FORBIDDEN_PROFILE_PATTERNS):
        raise ValueError(f'Profile "{normalized}" is not allowed for managed_browser.')
    policy = _MANAGED_PROFILES.get(normalized)
    if not policy:
        raise ValueError(f'Unknown managed_browser profile "{normalized}".')
    if site and site != policy["siteKey"]:
        raise ValueError(f'Profile "{normalized}" belongs to site "{policy["siteKey"]}", not "{site}".')
    return deepcopy(policy)


def _context_key(policy: Dict[str, Any], task_id: Optional[str]) -> str:
    return f"{task_id or 'default'}:{policy.get('engine', 'camoufox-python')}:{policy['profile']}:{policy['sessionKey']}"


def _extract_tab_id(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    direct = payload.get("tabId") or payload.get("targetId")
    if isinstance(direct, str) and direct:
        return direct
    nested = payload.get("result")
    if isinstance(nested, dict):
        nested_id = nested.get("tabId") or nested.get("targetId")
        if isinstance(nested_id, str) and nested_id:
            return nested_id
    return None


def _remember_tab(policy: Dict[str, Any], payload: Any, task_id: Optional[str], explicit_tab_id: Optional[str] = None) -> Optional[str]:
    tab_id = explicit_tab_id or _extract_tab_id(payload)
    if tab_id:
        with _MANAGED_TABS_LOCK:
            _MANAGED_TABS[_context_key(policy, task_id)] = tab_id
    return tab_id


def _resolve_tab_id(policy: Dict[str, Any], task_id: Optional[str], tab_id: Optional[str] = None) -> str:
    if tab_id:
        return tab_id
    with _MANAGED_TABS_LOCK:
        remembered = _MANAGED_TABS.get(_context_key(policy, task_id))
    if not remembered:
        raise ValueError("No active managed browser tab. Call managed_browser_launch_visible_window or managed_browser_navigate first, or pass tabId explicitly.")
    return remembered


def _is_recoverable_tab_error(exc: Exception) -> bool:
    text = str(exc)
    response = getattr(exc, "response", None)
    if response is not None:
        try:
            text = f"{text} {response.text}"
        except Exception:
            pass
    return bool(re.search(r"tab (?:not found|closed)|browser disconnected|target closed|page closed", text, re.I))


def _recover_tab(policy: Dict[str, Any], task_id: Optional[str] = None, stale_tab_id: Optional[str] = None, fallback_url: Optional[str] = None) -> dict:
    target_url = fallback_url or policy["defaultStartUrl"]
    extra = {"fallbackUrl": target_url}
    if stale_tab_id:
        extra.update({"staleTabId": stale_tab_id, "tabId": stale_tab_id})
    payload = _managed_payload(policy, target_url, extra=extra)
    data = _post("/managed/recover-tab", payload, timeout=60)
    _remember_tab(policy, data, task_id)
    return data


def _tab_retry(policy: Dict[str, Any], task_id: Optional[str], tab_id: Optional[str], fallback_url: Optional[str], fn):
    resolved_tab_id = _resolve_tab_id(policy, task_id, tab_id)
    try:
        return fn(resolved_tab_id), resolved_tab_id, None
    except Exception as exc:
        if not _is_recoverable_tab_error(exc):
            raise
        previous_tab_id = resolved_tab_id
        recovery = _recover_tab(policy, task_id=task_id, stale_tab_id=previous_tab_id, fallback_url=fallback_url)
        recovered_tab_id = _extract_tab_id(recovery) or previous_tab_id
        return fn(recovered_tab_id), recovered_tab_id, {"recovered": True, "previous_tab_id": previous_tab_id}


def _managed_payload(policy: Dict[str, Any], url: str, human_profile: Optional[str] = None, extra: Optional[dict] = None) -> dict:
    payload = {
        "managedBrowser": True,
        "siteKey": policy["siteKey"],
        "engine": policy.get("engine", "camoufox-python"),
        "userId": policy["userId"],
        "sessionKey": policy["sessionKey"],
        "url": url,
        "profileDir": policy["profileDir"],
        "browserPersonaKey": policy["browserPersonaKey"],
        "humanPersonaKey": policy["humanPersonaKey"],
        "humanProfile": human_profile or policy["defaultHumanProfile"],
    }
    if extra:
        payload.update(extra)
    return payload


def _block_token_url(url: str) -> None:
    parsed = urlparse(url)
    if _TOKEN_PATH_RE.search(parsed.path or ""):
        raise ValueError("Refusing to navigate managed browser to token-looking URL path.")
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        if _TOKEN_PARAM_RE.search(key) and _TOKEN_VALUE_RE.match(value):
            raise ValueError(f'Refusing to navigate managed browser to token-looking URL parameter "{key}".')


def _bot_detection_warning(title: Any) -> Optional[str]:
    if isinstance(title, str) and _BOT_DETECTION_TITLE_RE.search(title):
        return f"Possible bot-detection page title: {title}"
    return None


def _result(success: bool, **data: Any) -> str:
    data["success"] = success
    return _json(data)


def _with_errors(fn):
    def wrapped(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except requests.ConnectionError:
            return _result(False, error=f"Cannot connect to Managed Browser at {_base_url()}")
        except Exception as exc:
            return tool_error(str(exc), success=False)
    return wrapped


@_with_errors
def _impl_managed_browser_profile_status(profile: str, site: Optional[str] = None, task_id: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    with _MANAGED_TABS_LOCK:
        tab_id = _MANAGED_TABS.get(_context_key(policy, task_id))
    return _result(True, profile=policy["profile"], siteKey=policy["siteKey"], engine=policy.get("engine", "camoufox-python"), userId=policy["userId"], sessionKey=policy["sessionKey"], profileDir=policy["profileDir"], displayPolicy=policy["displayPolicy"], lifecyclePolicy=policy["lifecyclePolicy"], securityPolicy=policy["securityPolicy"], rememberedTabId=tab_id)


@_with_errors
def _impl_managed_browser_launch_visible_window(profile: str, site: Optional[str] = None, url: Optional[str] = None, human_profile: Optional[str] = None, task_id: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    if not policy.get("displayPolicy", {}).get("allowServerOwnedVisibleLaunch"):
        raise ValueError(f"Managed profile {policy['profile']} does not allow server-owned launch.")
    payload = _managed_payload(policy, url or policy["defaultStartUrl"], human_profile)
    if policy.get("displayPolicy", {}).get("display"):
        payload["display"] = policy["displayPolicy"]["display"]
    data = _post("/managed/visible-tab", payload)
    tab_id = _remember_tab(policy, data, task_id)
    return _result(True, profile=policy["profile"], tab_id=tab_id, **data)


@_with_errors
def _impl_managed_browser_checkpoint_storage(profile: str, site: Optional[str] = None, reason: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    data = _post("/managed/storage-checkpoint", {"userId": policy["userId"], "engine": policy.get("engine", "camoufox-python"), "profileDir": policy["profileDir"], "reason": reason or "manual_checkpoint"})
    return _result(True, profile=policy["profile"], **data)


@_with_errors
def _impl_managed_browser_human_view_url(profile: str, site: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    health = _get("/health")
    vnc_profiles = None
    try:
        vnc_profiles = _get("/vnc/profiles")
    except Exception:
        vnc_profiles = None
    return _result(
        True,
        profile=policy["profile"],
        siteKey=policy["siteKey"],
        userId=policy["userId"],
        humanOnly=True,
        managedRegistryOnly=bool(health.get("vncManagedRegistryOnly")),
        vncEnabled=bool(health.get("vncEnabled")),
        novncUrl=health.get("novncUrl"),
        vncBind=health.get("vncBind"),
        selectedProfile=(vnc_profiles or {}).get("selected") if isinstance(vnc_profiles, dict) else None,
        profiles=(vnc_profiles or {}).get("profiles") if isinstance(vnc_profiles, dict) else None,
        instructions="Open novncUrl yourself for manual viewing/control. The agent must not open, inspect, screenshot, OCR, or control noVNC/VNC/X11; after manual login/CAPTCHA, resume with managed_browser_snapshot and checkpoint storage if session state changed.",
    )


@_with_errors
def _impl_managed_browser_navigate(profile: str, url: Optional[str] = None, site: Optional[str] = None, tab_id: Optional[str] = None, task_id: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    target_url = url or policy["defaultStartUrl"]
    _block_token_url(target_url)
    if tab_id:
        data = _post(f"/tabs/{tab_id}/navigate", _managed_payload(policy, target_url), timeout=60)
        resolved_tab_id = tab_id
        _remember_tab(policy, data, task_id, explicit_tab_id=tab_id)
    else:
        data = _post("/managed/visible-tab", _managed_payload(policy, target_url), timeout=60)
        resolved_tab_id = _remember_tab(policy, data, task_id)
    if resolved_tab_id:
        try:
            snapshot_data = _get(f"/tabs/{resolved_tab_id}/snapshot", params={"userId": policy["userId"], "engine": policy.get("engine", "camoufox-python"), "includeScreenshot": "false"})
            warning = _bot_detection_warning(snapshot_data.get("title"))
            data.update({
                "snapshot": snapshot_data.get("snapshot", ""),
                "element_count": snapshot_data.get("refsCount", 0),
                "truncated": snapshot_data.get("truncated"),
                "hasMore": snapshot_data.get("hasMore"),
                "nextOffset": snapshot_data.get("nextOffset"),
                "url": snapshot_data.get("url", data.get("url", "")),
            })
            if warning:
                data["bot_detection_warning"] = warning
        except Exception:
            pass
    return _result(True, profile=policy["profile"], **data)


@_with_errors
def _impl_managed_browser_snapshot(profile: str, site: Optional[str] = None, tab_id: Optional[str] = None, full: bool = False, offset: Optional[int] = None, task_id: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    params = {"userId": policy["userId"], "engine": policy.get("engine", "camoufox-python"), "full": "true" if full else "false", "includeScreenshot": "false"}
    if offset is not None:
        params["offset"] = offset
    data, resolved_tab_id, recovery = _tab_retry(policy, task_id, tab_id, None, lambda tid: _get(f"/tabs/{tid}/snapshot", params=params))
    return _result(True, profile=policy["profile"], tab_id=resolved_tab_id, snapshot=data.get("snapshot", ""), element_count=data.get("refsCount", 0), truncated=data.get("truncated"), hasMore=data.get("hasMore"), nextOffset=data.get("nextOffset"), url=data.get("url", ""), **(recovery or {}))


@_with_errors
def _impl_managed_browser_click(profile: str, ref: str, site: Optional[str] = None, tab_id: Optional[str] = None, human_profile: Optional[str] = None, task_id: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    data, resolved_tab_id, recovery = _tab_retry(policy, task_id, tab_id, None, lambda tid: _post(f"/tabs/{tid}/click", _managed_payload(policy, policy["defaultStartUrl"], human_profile, {"ref": ref.lstrip("@")})))
    return _result(True, profile=policy["profile"], tab_id=resolved_tab_id, **data, **(recovery or {}))


@_with_errors
def _impl_managed_browser_type(profile: str, ref: str, text: str, site: Optional[str] = None, tab_id: Optional[str] = None, human_profile: Optional[str] = None, task_id: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    data, resolved_tab_id, recovery = _tab_retry(policy, task_id, tab_id, None, lambda tid: _post(f"/tabs/{tid}/type", _managed_payload(policy, policy["defaultStartUrl"], human_profile, {"ref": ref.lstrip("@"), "text": text})))
    return _result(True, profile=policy["profile"], tab_id=resolved_tab_id, **data, **(recovery or {}))


@_with_errors
def _impl_managed_browser_press(profile: str, key: str, site: Optional[str] = None, tab_id: Optional[str] = None, human_profile: Optional[str] = None, task_id: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    data, resolved_tab_id, recovery = _tab_retry(policy, task_id, tab_id, None, lambda tid: _post(f"/tabs/{tid}/press", _managed_payload(policy, policy["defaultStartUrl"], human_profile, {"key": key})))
    return _result(True, profile=policy["profile"], tab_id=resolved_tab_id, **data, **(recovery or {}))


@_with_errors
def _impl_managed_browser_scroll(profile: str, direction: str = "down", site: Optional[str] = None, tab_id: Optional[str] = None, human_profile: Optional[str] = None, task_id: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    data, resolved_tab_id, recovery = _tab_retry(policy, task_id, tab_id, None, lambda tid: _post(f"/tabs/{tid}/scroll", _managed_payload(policy, policy["defaultStartUrl"], human_profile, {"direction": direction})))
    return _result(True, profile=policy["profile"], tab_id=resolved_tab_id, **data, **(recovery or {}))


@_with_errors
def _impl_managed_browser_back(profile: str, site: Optional[str] = None, tab_id: Optional[str] = None, task_id: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    data, resolved_tab_id, recovery = _tab_retry(policy, task_id, tab_id, None, lambda tid: _post(f"/tabs/{tid}/back", {"userId": policy["userId"], "engine": policy.get("engine", "camoufox-python")}))
    return _result(True, profile=policy["profile"], tab_id=resolved_tab_id, **data, **(recovery or {}))


@_with_errors
def _impl_managed_browser_console(profile: str, expression: Optional[str] = None, site: Optional[str] = None, tab_id: Optional[str] = None, clear: bool = False, task_id: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    if not expression:
        data, resolved_tab_id, recovery = _tab_retry(policy, task_id, tab_id, None, lambda tid: _get(f"/tabs/{tid}/diagnostics", params={"userId": policy["userId"], "engine": policy.get("engine", "camoufox-python"), "clear": "true" if clear else "false"}))
        return _result(True, profile=policy["profile"], tab_id=resolved_tab_id, **data, **(recovery or {}))
    data, resolved_tab_id, recovery = _tab_retry(policy, task_id, tab_id, None, lambda tid: _post(f"/tabs/{tid}/evaluate", {"userId": policy["userId"], "engine": policy.get("engine", "camoufox-python"), "expression": expression}))
    return _result(True, profile=policy["profile"], tab_id=resolved_tab_id, **data, **(recovery or {}))


@_with_errors
def _impl_managed_browser_get_images(profile: str, site: Optional[str] = None, tab_id: Optional[str] = None, task_id: Optional[str] = None) -> str:
    snap = json.loads(_impl_managed_browser_snapshot(profile=profile, site=site, tab_id=tab_id, task_id=task_id))
    if not snap.get("success"):
        return _json(snap)
    images = []
    lines = snap.get("snapshot", "").split("\n")
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith(("- img ", "img ")):
            alt_match = re.search(r'img\s+"([^"]*)"', stripped)
            url_match = re.search(r'/url:\s*(\S+)', lines[i + 1].strip()) if i + 1 < len(lines) else None
            images.append({"src": url_match.group(1) if url_match else "", "alt": alt_match.group(1) if alt_match else ""})
    recovery = {k: snap.get(k) for k in ("recovered", "previous_tab_id") if k in snap}
    return _result(True, profile=snap.get("profile"), tab_id=snap.get("tab_id"), images=images, count=len(images), **recovery)


@_with_errors
def _impl_managed_browser_run_memory(profile: str, site: Optional[str] = None, tab_id: Optional[str] = None, action_key: Optional[str] = None, parameters: Optional[dict] = None, url: Optional[str] = None, allow_llm_repair: bool = False, learn_repairs: bool = False, human_profile: Optional[str] = None, task_id: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    remembered_tab_id = None
    try:
        remembered_tab_id = _resolve_tab_id(policy, task_id, tab_id)
    except Exception:
        remembered_tab_id = tab_id
    payload = {
        "userId": policy["userId"],
        "siteKey": policy["siteKey"],
        "actionKey": action_key or "default",
        "parameters": parameters or {},
        "learnRepairs": learn_repairs is True,
        "humanProfile": human_profile or policy["defaultHumanProfile"],
    }
    if remembered_tab_id:
        payload["tabId"] = remembered_tab_id
    if url:
        payload["url"] = url
    if allow_llm_repair is True:
        payload["allowLlmRepair"] = True
    recovery = None
    try:
        data = _post("/memory/replay", payload, timeout=120)
    except Exception as exc:
        if not remembered_tab_id or not _is_recoverable_tab_error(exc):
            raise
        previous_tab_id = remembered_tab_id
        recovered = _recover_tab(policy, task_id=task_id, stale_tab_id=previous_tab_id, fallback_url=url)
        remembered_tab_id = _extract_tab_id(recovered) or previous_tab_id
        payload["tabId"] = remembered_tab_id
        recovery = {"recovered": True, "previous_tab_id": previous_tab_id}
        data = _post("/memory/replay", payload, timeout=120)
    replay_tab_id = _remember_tab(policy, data, task_id)
    failed = None
    if data.get("ok") is False:
        for item in data.get("results", []) if isinstance(data.get("results"), list) else []:
            if isinstance(item, dict) and item.get("ok") is False:
                failed = item.get("error") or item.get("mode")
                break
    return _result(True, profile=policy["profile"], tab_id=replay_tab_id or remembered_tab_id, llm_used=data.get("llm_used") is True, mode=data.get("mode"), failure_reason=failed or data.get("error"), **data, **(recovery or {}))


@_with_errors
def _impl_managed_browser_run_flow(profile: str, site: Optional[str] = None, flow_name: Optional[str] = None, **kwargs) -> str:
    return _impl_managed_browser_run_memory(profile=profile, site=site, action_key=flow_name or kwargs.pop("action_key", None), **kwargs)


@_with_errors
def _impl_managed_browser_record_flow(profile: str, site: Optional[str] = None, tab_id: Optional[str] = None, action_key: Optional[str] = None, flow_name: Optional[str] = None, parameters: Optional[dict] = None, url: Optional[str] = None, human_profile: Optional[str] = None, task_id: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    payload = {
        "userId": policy["userId"],
        "siteKey": policy["siteKey"],
        "actionKey": action_key or flow_name or "default",
        "flowName": flow_name or action_key or "default",
        "parameters": parameters or {},
        "humanProfile": human_profile or policy["defaultHumanProfile"],
    }
    if url:
        payload["url"] = url
    def record(tid):
        payload["tabId"] = tid
        return _post("/memory/record", payload, timeout=120)
    data, resolved_tab_id, recovery = _tab_retry(policy, task_id, tab_id, url, record)
    _remember_tab(policy, data, task_id, explicit_tab_id=resolved_tab_id)
    return _result(True, profile=policy["profile"], tab_id=resolved_tab_id, **data, **(recovery or {}))


@_with_errors
def _impl_managed_browser_list_memory(profile: str, site: Optional[str] = None, action_key: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    params = {"siteKey": policy["siteKey"]}
    if action_key:
        params["q"] = action_key
    data = _get("/memory/search", params=params)
    return _result(True, profile=policy["profile"], **data)


@_with_errors
def _impl_managed_browser_inspect_memory(profile: str, site: Optional[str] = None, action_key: Optional[str] = None, memory_id: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    data = _get("/memory/search", params={"siteKey": policy["siteKey"], "q": memory_id or action_key or "default"})
    return _result(True, profile=policy["profile"], **data)


@_with_errors
def _impl_managed_browser_delete_memory(profile: str, site: Optional[str] = None, action_key: Optional[str] = None, memory_id: Optional[str] = None) -> str:
    policy = _resolve_profile(profile, site)
    resp = requests.delete(f"{_base_url()}/memory/delete", params={"siteKey": policy["siteKey"], "actionKey": memory_id or action_key or "default"}, timeout=_DEFAULT_TIMEOUT)
    resp.raise_for_status()
    return _result(True, profile=policy["profile"], **resp.json())


@_with_errors
def _impl_managed_browser_vision(profile: str, question: str, site: Optional[str] = None, tab_id: Optional[str] = None, annotate: bool = False, task_id: Optional[str] = None) -> str:
    if not question:
        raise ValueError("managed_browser_vision requires a question.")
    policy = _resolve_profile(profile, site)
    resp, resolved_tab_id, recovery = _tab_retry(policy, task_id, tab_id, None, lambda tid: _get_raw(f"/tabs/{tid}/screenshot", params={"userId": policy["userId"]}, timeout=60))

    from hermes_constants import get_hermes_home
    screenshots_dir = get_hermes_home() / "browser_screenshots"
    screenshots_dir.mkdir(parents=True, exist_ok=True)
    screenshot_path = str(screenshots_dir / f"managed_browser_screenshot_{uuid.uuid4().hex[:8]}.png")
    with open(screenshot_path, "wb") as f:
        f.write(resp.content)

    result = {
        "profile": policy["profile"],
        "tab_id": resolved_tab_id,
        "screenshot_path": screenshot_path,
        "note": "Visual fallback only. Use managed_browser_snapshot as the primary page state source.",
    }
    if recovery:
        result.update(recovery)

    try:
        annotation_context = ""
        if annotate:
            try:
                snap_data = _get(f"/tabs/{resolved_tab_id}/snapshot", params={"userId": policy["userId"], "engine": policy.get("engine", "camoufox-python"), "includeScreenshot": "false"})
                annotation_context = f"\n\nAccessibility tree (element refs for interaction):\n{snap_data.get('snapshot', '')[:3000]}"
            except Exception:
                annotation_context = ""

        from agent.auxiliary_client import call_llm
        from agent.redact import redact_sensitive_text
        from hermes_cli.config import load_config

        annotation_context = redact_sensitive_text(annotation_context)
        cfg = load_config()
        vision_cfg = cfg.get("auxiliary", {}).get("vision", {})
        response = call_llm(
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": f"Analyze this browser screenshot and answer: {question}{annotation_context}"},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64.b64encode(resp.content).decode('utf-8')}"}},
                ],
            }],
            task="vision",
            temperature=float(vision_cfg.get("temperature", 0.1)),
            timeout=float(vision_cfg.get("timeout", 120)),
        )
        analysis = (response.choices[0].message.content or "").strip() if response.choices else ""
        result["analysis"] = redact_sensitive_text(analysis)
    except Exception as exc:
        result["vision_analysis_error"] = str(exc)

    return _result(True, **result)


# ---------------------------------------------------------------------------
# Hermes plugin handler adapters
# ---------------------------------------------------------------------------

def _tab_id(args: dict) -> Optional[str]:
    return args.get("tab_id") or args.get("tabId")


def _human_profile(args: dict) -> Optional[str]:
    return args.get("human_profile") or args.get("humanProfile")


def managed_browser_launch_visible_window_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_launch_visible_window(profile=args.get("profile", ""), site=args.get("site"), url=args.get("url"), human_profile=_human_profile(args), task_id=kw.get("task_id"))


def managed_browser_profile_status_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_profile_status(profile=args.get("profile", ""), site=args.get("site"), task_id=kw.get("task_id"))


def managed_browser_checkpoint_storage_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_checkpoint_storage(profile=args.get("profile", ""), site=args.get("site"), reason=args.get("reason"))


def managed_browser_human_view_url_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_human_view_url(profile=args.get("profile", ""), site=args.get("site"))


def managed_browser_navigate_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_navigate(profile=args.get("profile", ""), site=args.get("site"), url=args.get("url"), tab_id=_tab_id(args), task_id=kw.get("task_id"))


def managed_browser_snapshot_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_snapshot(profile=args.get("profile", ""), site=args.get("site"), tab_id=_tab_id(args), full=args.get("full", False), offset=args.get("offset"), task_id=kw.get("task_id"))


def managed_browser_click_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_click(profile=args.get("profile", ""), site=args.get("site"), ref=args.get("ref", ""), tab_id=_tab_id(args), human_profile=_human_profile(args), task_id=kw.get("task_id"))


def managed_browser_type_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_type(profile=args.get("profile", ""), site=args.get("site"), ref=args.get("ref", ""), text=args.get("text", ""), tab_id=_tab_id(args), human_profile=_human_profile(args), task_id=kw.get("task_id"))


def managed_browser_press_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_press(profile=args.get("profile", ""), site=args.get("site"), key=args.get("key", ""), tab_id=_tab_id(args), human_profile=_human_profile(args), task_id=kw.get("task_id"))


def managed_browser_scroll_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_scroll(profile=args.get("profile", ""), site=args.get("site"), direction=args.get("direction", "down"), tab_id=_tab_id(args), human_profile=_human_profile(args), task_id=kw.get("task_id"))


def managed_browser_back_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_back(profile=args.get("profile", ""), site=args.get("site"), tab_id=_tab_id(args), task_id=kw.get("task_id"))


def managed_browser_console_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_console(profile=args.get("profile", ""), site=args.get("site"), expression=args.get("expression"), tab_id=_tab_id(args), clear=args.get("clear", False), task_id=kw.get("task_id"))


def managed_browser_get_images_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_get_images(profile=args.get("profile", ""), site=args.get("site"), tab_id=_tab_id(args), task_id=kw.get("task_id"))


def managed_browser_vision_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_vision(profile=args.get("profile", ""), site=args.get("site"), question=args.get("question", ""), tab_id=_tab_id(args), annotate=args.get("annotate", False), task_id=kw.get("task_id"))


def _allow_llm_repair_arg(args: dict) -> bool:
    if "allowLlmRepair" in args:
        return args.get("allowLlmRepair") is True
    return args.get("allow_llm_repair") is True


def managed_browser_run_memory_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_run_memory(
        profile=args.get("profile", ""),
        site=args.get("site"),
        tab_id=_tab_id(args),
        action_key=args.get("action_key") or args.get("actionKey"),
        parameters=args.get("parameters") if isinstance(args.get("parameters"), dict) else {},
        url=args.get("url"),
        allow_llm_repair=_allow_llm_repair_arg(args),
        learn_repairs=args.get("learn_repairs") is True or args.get("learnRepairs") is True,
        human_profile=_human_profile(args),
        task_id=kw.get("task_id"),
    )


def managed_browser_run_flow_handler(args: dict, **kw) -> str:
    flow_name = args.get("flow_name") or args.get("action_key") or args.get("actionKey")
    return _impl_managed_browser_run_flow(
        profile=args.get("profile", ""),
        site=args.get("site"),
        flow_name=flow_name,
        tab_id=_tab_id(args),
        parameters=args.get("parameters") if isinstance(args.get("parameters"), dict) else {},
        url=args.get("url"),
        allow_llm_repair=_allow_llm_repair_arg(args),
        learn_repairs=args.get("learn_repairs") is True or args.get("learnRepairs") is True,
        human_profile=_human_profile(args),
        task_id=kw.get("task_id"),
    )


def managed_browser_record_flow_handler(args: dict, **kw) -> str:
    flow_name = args.get("flow_name") or args.get("action_key") or args.get("actionKey")
    return _impl_managed_browser_record_flow(profile=args.get("profile", ""), site=args.get("site"), flow_name=flow_name, action_key=args.get("action_key") or args.get("actionKey"), tab_id=_tab_id(args), parameters=args.get("parameters") if isinstance(args.get("parameters"), dict) else {}, url=args.get("url"), human_profile=_human_profile(args), task_id=kw.get("task_id"))


def managed_browser_list_memory_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_list_memory(profile=args.get("profile", ""), site=args.get("site"), action_key=args.get("action_key") or args.get("actionKey"))


def managed_browser_inspect_memory_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_inspect_memory(profile=args.get("profile", ""), site=args.get("site"), action_key=args.get("action_key") or args.get("actionKey"), memory_id=args.get("memory_id") or args.get("memoryId"))


def managed_browser_delete_memory_handler(args: dict, **kw) -> str:
    return _impl_managed_browser_delete_memory(profile=args.get("profile", ""), site=args.get("site"), action_key=args.get("action_key") or args.get("actionKey"), memory_id=args.get("memory_id") or args.get("memoryId"))

# Aliases used by __init__.py registration.
managed_browser_launch_visible_window = managed_browser_launch_visible_window_handler
managed_browser_profile_status = managed_browser_profile_status_handler
managed_browser_checkpoint_storage = managed_browser_checkpoint_storage_handler
managed_browser_human_view_url = managed_browser_human_view_url_handler
managed_browser_navigate = managed_browser_navigate_handler
managed_browser_snapshot = managed_browser_snapshot_handler
managed_browser_click = managed_browser_click_handler
managed_browser_type = managed_browser_type_handler
managed_browser_press = managed_browser_press_handler
managed_browser_scroll = managed_browser_scroll_handler
managed_browser_back = managed_browser_back_handler
managed_browser_console = managed_browser_console_handler
managed_browser_get_images = managed_browser_get_images_handler
managed_browser_vision = managed_browser_vision_handler
managed_browser_run_memory = managed_browser_run_memory_handler
managed_browser_run_flow = managed_browser_run_flow_handler
managed_browser_record_flow = managed_browser_record_flow_handler
managed_browser_list_memory = managed_browser_list_memory_handler
managed_browser_inspect_memory = managed_browser_inspect_memory_handler
managed_browser_delete_memory = managed_browser_delete_memory_handler
