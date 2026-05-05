import pytest
from fastapi import HTTPException

from camofox.api import managed as managed_api
from camofox.managed.leases import ProfileLeaseError, ProfileLeaseManager
from camofox.managed.profiles import (
    ManagedProfileError,
    list_managed_browser_profiles,
    managed_browser_profile_status,
    normalize_managed_browser_profile,
    profile_to_user_id,
    resolve_managed_browser_profile,
)


def test_managed_profile_alias_resolution():
    assert normalize_managed_browser_profile("emploi") == "emploi-candidature"
    assert normalize_managed_browser_profile("ju", "leboncoin") == "leboncoin-cim"
    assert profile_to_user_id("emploi") == "emploi-candidature"


def test_managed_profile_rejects_unknown_and_mismatched_site():
    with pytest.raises(ManagedProfileError) as exc:
        resolve_managed_browser_profile({"profile": "unknown-profile"})
    assert exc.value.status_code == 404
    assert exc.value.code == "profile_unknown"

    with pytest.raises(ManagedProfileError) as exc:
        resolve_managed_browser_profile({"profile": "emploi", "site": "leboncoin"})
    assert exc.value.status_code == 400
    assert exc.value.code == "site_mismatch"


def test_managed_profile_status_contains_node_compat_identity():
    status = managed_browser_profile_status({"profile": "emploi"}, ensure=True, observed={"currentTabId": "tab-1"})
    assert status["ok"] is True
    assert status["ensured"] is True
    assert status["profile"] == "emploi-candidature"
    assert status["siteKey"] == "france-travail"
    assert status["identity"]["cookies"] == "emploi-candidature"
    assert status["lifecycle"]["state"] == "READY"
    assert status["lifecycle"]["currentTabId"] == "tab-1"


def test_list_managed_profiles_exposes_known_profiles():
    profiles = list_managed_browser_profiles()
    names = {profile["profile"] for profile in profiles}
    assert "emploi-candidature" in names
    assert "leboncoin-cim" in names
    assert all(profile["identity"]["tabs"] == profile["sessionKey"] for profile in profiles)


def test_profile_lease_manager_acquire_conflict_renew_release():
    manager = ProfileLeaseManager(ttl_ms=1_000)
    lease = manager.acquire(profile="emploi-candidature", owner="pytest", ttl_ms=2_000)
    assert lease["profile"] == "emploi-candidature"
    assert lease["owner"] == "pytest"

    with pytest.raises(ProfileLeaseError) as exc:
        manager.acquire(profile="emploi-candidature", owner="other")
    assert exc.value.status_code == 423
    assert exc.value.reason == "locked"

    renewed = manager.renew(profile="emploi-candidature", lease_id=lease["lease_id"], ttl_ms=3_000)
    assert renewed["lease_id"] == lease["lease_id"]
    assert renewed["expires_at"] >= lease["expires_at"]

    released = manager.release(profile="emploi-candidature", lease_id=lease["lease_id"])
    assert released["released"] is True
    assert manager.status("emploi-candidature")["locked"] is False


def test_profile_lease_manager_requires_matching_lease_id():
    manager = ProfileLeaseManager(ttl_ms=1_000)
    manager.acquire(profile="emploi-candidature", owner="pytest")
    with pytest.raises(ProfileLeaseError) as exc:
        manager.renew(profile="emploi-candidature", lease_id="wrong")
    assert exc.value.reason == "lease_mismatch"
    assert exc.value.required_lease_id is True


@pytest.mark.asyncio
async def test_managed_api_ensure_profile_alias():
    response = await managed_api.ensure_profile(managed_api.ProfileEnsureRequest(profile="emploi"))
    assert response["ok"] is True
    assert response["ensured"] is True
    assert response["profile"] == "emploi-candidature"


@pytest.mark.asyncio
async def test_managed_api_lease_endpoints(monkeypatch):
    manager = ProfileLeaseManager(ttl_ms=1_000)
    monkeypatch.setattr(managed_api, "lease_manager", manager)

    acquired = await managed_api.acquire_lease(
        managed_api.LeaseAcquireRequest(profile="emploi", owner="pytest", ttlMs=2_000)
    )
    assert acquired["ok"] is True
    assert acquired["profile"] == "emploi-candidature"
    assert acquired["lease"]["owner"] == "pytest"

    renewed = await managed_api.renew_lease(
        managed_api.LeaseRenewRequest(profile="emploi", lease_id=acquired["lease_id"], ttl_ms=3_000)
    )
    assert renewed["lease_id"] == acquired["lease_id"]

    released = await managed_api.release_lease(
        managed_api.LeaseReleaseRequest(profile="emploi", lease_id=acquired["lease_id"])
    )
    assert released["released"] is True


@pytest.mark.asyncio
async def test_managed_api_lease_conflict_returns_http_423(monkeypatch):
    manager = ProfileLeaseManager(ttl_ms=1_000)
    monkeypatch.setattr(managed_api, "lease_manager", manager)
    await managed_api.acquire_lease(managed_api.LeaseAcquireRequest(profile="emploi", owner="one"))

    with pytest.raises(HTTPException) as exc:
        await managed_api.acquire_lease(managed_api.LeaseAcquireRequest(profile="emploi", owner="two"))
    assert exc.value.status_code == 423
    assert exc.value.detail["code"] == "profile_locked"
