"""Managed browser profile registry and policy helpers.

Python port of the local Node.js ``managed-browser-policy.js`` module.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from camofox.core.utils import normalize_user_id


class ManagedProfileError(ValueError):
    def __init__(self, message: str, *, status_code: int = 400, code: str = "managed_profile_error"):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


def _policy(
    profile: str,
    site_key: str,
    default_start_url: str,
    *,
    require_confirmation: bool,
    warmup_enabled: bool = False,
    max_session_age_minutes: int = 240,
) -> dict[str, Any]:
    return {
        "profile": profile,
        "siteKey": site_key,
        "userId": profile,
        "sessionKey": f"managed:{profile}",
        "defaultStartUrl": default_start_url,
        "profileDir": f"/home/jul/.vnc-browser-profiles/{profile}",
        "browserPersonaKey": f"managed:{profile}:browser",
        "humanPersonaKey": f"managed:{profile}:human",
        "defaultHumanProfile": "fast",
        "displayPolicy": {"mode": "managed-autonomous", "allowServerOwnedVisibleLaunch": True},
        "lifecyclePolicy": {
            "warmup": {
                "enabled": warmup_enabled,
                "reason": "safe-demo-profile" if warmup_enabled else "manual-profile-only",
            },
            "rotation": {"mode": "manual", "maxSessionAgeMinutes": max_session_age_minutes},
        },
        "securityPolicy": {
            "site": site_key,
            "browserOnly": True,
            "requireConfirmationForBindingActions": require_confirmation,
        },
    }


MANAGED_PROFILES: dict[str, dict[str, Any]] = {
    "leboncoin-cim": _policy("leboncoin-cim", "leboncoin", "https://www.leboncoin.fr/", require_confirmation=True),
    "leboncoin-ge": _policy("leboncoin-ge", "leboncoin", "https://www.leboncoin.fr/", require_confirmation=True),
    "vinted-main": _policy("vinted-main", "vinted", "https://www.vinted.fr/", require_confirmation=True),
    "facebook-ju": _policy("facebook-ju", "facebook-marketplace", "https://www.facebook.com/marketplace/", require_confirmation=True),
    "emploi-officiel": _policy("emploi-officiel", "france-travail", "https://candidat.francetravail.fr/actualisation", require_confirmation=True),
    "emploi-candidature": _policy("emploi-candidature", "france-travail", "https://candidat.francetravail.fr/offres/recherche", require_confirmation=True),
    "courses": _policy("courses", "leclerc", "https://www.e.leclerc/", require_confirmation=False),
    "courses-auchan": _policy("courses-auchan", "auchan", "https://www.auchan.fr/", require_confirmation=False),
    "courses-intermarche": _policy("courses-intermarche", "intermarche", "https://www.intermarche.com/", require_confirmation=False),
    "example-demo": _policy("example-demo", "example", "https://example.com/", require_confirmation=False, warmup_enabled=True, max_session_age_minutes=60),
}
MANAGED_PROFILES["example-demo"]["displayPolicy"] = {"mode": "managed-autonomous"}

PROFILE_ALIASES: dict[str, dict[str, str]] = {
    "ju": {"profile": "leboncoin-cim", "siteKey": "leboncoin"},
    "leboncoin-cim": {"profile": "leboncoin-cim", "siteKey": "leboncoin"},
    "ge": {"profile": "leboncoin-ge", "siteKey": "leboncoin"},
    "cim": {"profile": "leboncoin-cim", "siteKey": "leboncoin"},
    "vinted": {"profile": "vinted-main", "siteKey": "vinted"},
    "emploi": {"profile": "emploi-candidature", "siteKey": "france-travail"},
    "france-travail": {"profile": "emploi-officiel", "siteKey": "france-travail"},
    "auchan": {"profile": "courses-auchan", "siteKey": "auchan"},
    "intermarche": {"profile": "courses-intermarche", "siteKey": "intermarche"},
}

FORBIDDEN_PROFILES = {"", "default", "camoufox-default", "leboncoin-manual"}
FORBIDDEN_PREFIXES = ("camofox-",)


def normalize_managed_browser_profile(profile: str | None, site: str | None = None) -> str:
    if not isinstance(profile, str) or not profile.strip():
        raise ManagedProfileError(
            'managed_browser requires an explicit profile. Use profile="leboncoin-cim" or profile="leboncoin-ge".',
            status_code=400,
            code="profile_required",
        )
    raw = profile.strip()
    normalized_site = site.strip() if isinstance(site, str) and site.strip() else None
    alias = PROFILE_ALIASES.get(raw)
    if alias:
        if normalized_site and normalized_site != alias["siteKey"]:
            raise ManagedProfileError(
                f'Profile alias "{raw}" belongs to site "{alias["siteKey"]}", not "{normalized_site}".',
                status_code=400,
                code="site_mismatch",
            )
        return alias["profile"]
    return raw


def build_managed_profile_identity(policy: dict[str, Any]) -> dict[str, str]:
    return {
        "cookies": policy["userId"],
        "storage": policy["userId"],
        "browserPersona": policy["browserPersonaKey"],
        "humanPersona": policy["humanPersonaKey"],
        "tabs": policy["sessionKey"],
        "sessionState": policy["sessionKey"],
    }


def resolve_managed_browser_profile(input: dict[str, Any] | None = None, *, profile: str | None = None, site: str | None = None) -> dict[str, Any]:
    data = input or {}
    selected_profile = profile if profile is not None else data.get("profile")
    selected_site = site if site is not None else data.get("site")
    normalized = normalize_managed_browser_profile(selected_profile, selected_site)
    if normalized in FORBIDDEN_PROFILES or normalized.startswith(FORBIDDEN_PREFIXES):
        raise ManagedProfileError(f'Profile "{normalized}" is not allowed for managed_browser.', status_code=400, code="profile_forbidden")
    policy = MANAGED_PROFILES.get(normalized)
    if not policy:
        raise ManagedProfileError(f'Unknown managed_browser profile "{normalized}".', status_code=404, code="profile_unknown")
    if selected_site and selected_site != policy["siteKey"]:
        raise ManagedProfileError(
            f'Profile "{normalized}" belongs to site "{policy["siteKey"]}", not "{selected_site}".',
            status_code=400,
            code="site_mismatch",
        )
    result = deepcopy(policy)
    result["identity"] = build_managed_profile_identity(result)
    return result


def require_managed_browser_profile_identity(input: dict[str, Any] | None = None, *, operation: str | None = None) -> dict[str, Any]:
    try:
        return resolve_managed_browser_profile(input)
    except ManagedProfileError as exc:
        if exc.code == "profile_required":
            prefix = f"{operation} " if operation else ""
            raise ManagedProfileError(
                f"{prefix}requires an explicit profile for managed browser identity; missing or blank profile is not allowed.",
                status_code=400,
                code="profile_required",
            ) from exc
        raise


def list_managed_browser_profiles() -> list[dict[str, Any]]:
    return [resolve_managed_browser_profile({"profile": name}) for name in MANAGED_PROFILES]


def managed_browser_profile_status(input: dict[str, Any] | None = None, *, ensure: bool = False, observed: dict[str, Any] | None = None) -> dict[str, Any]:
    policy = require_managed_browser_profile_identity(input, operation="profiles.ensure" if ensure else "profiles.status")
    observed = observed or {}
    current_tab_id = observed.get("currentTabId")
    lifecycle = observed.get("lifecycle") or {
        "state": "READY" if current_tab_id else "COLD",
        "updatedAt": observed.get("updatedAt"),
        "currentTabId": current_tab_id,
    }
    return {
        "ok": True,
        "ensured": bool(ensure),
        "profile": policy["profile"],
        "siteKey": policy["siteKey"],
        "userId": policy["userId"],
        "sessionKey": policy["sessionKey"],
        "profileDir": policy["profileDir"],
        "browserPersonaKey": policy["browserPersonaKey"],
        "humanPersonaKey": policy["humanPersonaKey"],
        "identity": policy["identity"],
        "displayPolicy": policy["displayPolicy"],
        "lifecyclePolicy": policy["lifecyclePolicy"],
        "securityPolicy": policy["securityPolicy"],
        "lifecycle": lifecycle,
    }


def profile_to_user_id(profile: str, site: str | None = None, *, allow_unknown: bool = False) -> str:
    try:
        return normalize_user_id(resolve_managed_browser_profile({"profile": profile, "site": site})["userId"])
    except ManagedProfileError:
        if allow_unknown and site is None:
            return normalize_user_id(profile)
        raise
