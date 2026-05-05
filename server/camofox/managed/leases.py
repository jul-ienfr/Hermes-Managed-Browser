"""In-memory managed browser profile leases.

Python port of ``profile-lease-manager.js``. Leases protect managed profiles
from concurrent writers. They are intentionally runtime state, not persisted.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, asdict
from typing import Any
from uuid import uuid4

DEFAULT_TTL_MS = 5 * 60 * 1000


class ProfileLeaseError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status_code: int = 423,
        code: str = "profile_locked",
        profile: str | None = None,
        lease: dict[str, Any] | None = None,
        reason: str = "locked",
        required_lease_id: bool = False,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.profile = profile
        self.reason = reason
        self.required_lease_id = required_lease_id
        self.lease = lease or {}


def normalize_profile(profile: str | None) -> str:
    if not isinstance(profile, str) or not profile.strip():
        raise ProfileLeaseError(
            "profile is required for managed browser lease operations.",
            status_code=400,
            code="profile_required",
            reason="profile_required",
        )
    return profile.strip()


def normalize_lease_id(value: str | None) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def create_profile_locked_error(*, profile: str, lease: dict[str, Any] | None = None, reason: str = "locked", required_lease_id: bool = False) -> ProfileLeaseError:
    normalized = normalize_profile(profile)
    return ProfileLeaseError(
        f'Managed browser profile "{normalized}" is locked by another writer.',
        status_code=423,
        code="profile_locked",
        profile=normalized,
        lease=lease,
        reason=reason,
        required_lease_id=required_lease_id,
    )


@dataclass
class ProfileLease:
    lease_id: str
    profile: str
    owner: str | None
    acquired_at: int
    renewed_at: int
    expires_at: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ProfileLeaseManager:
    def __init__(self, ttl_ms: int = DEFAULT_TTL_MS):
        self.ttl_ms = ttl_ms if isinstance(ttl_ms, int) and ttl_ms > 0 else DEFAULT_TTL_MS
        self.leases: dict[str, ProfileLease] = {}

    def now(self) -> int:
        return int(time.time() * 1000)

    def _ttl(self, ttl_ms: int | None) -> int:
        return ttl_ms if isinstance(ttl_ms, int) and ttl_ms > 0 else self.ttl_ms

    def _purge_expired(self, profile: str) -> None:
        lease = self.leases.get(profile)
        if lease and lease.expires_at <= self.now():
            self.leases.pop(profile, None)

    def _require_active_lease(self, profile: str, lease_id: str | None) -> ProfileLease:
        self._purge_expired(profile)
        lease = self.leases.get(profile)
        normalized_lease_id = normalize_lease_id(lease_id)
        if lease is None:
            raise create_profile_locked_error(profile=profile, reason="missing_lease", required_lease_id=True)
        if not normalized_lease_id or lease.lease_id != normalized_lease_id:
            raise create_profile_locked_error(
                profile=profile,
                lease=lease.to_dict(),
                reason="lease_mismatch" if normalized_lease_id else "missing_lease",
                required_lease_id=True,
            )
        return lease

    def acquire(self, *, profile: str, owner: str | None = None, ttl_ms: int | None = None) -> dict[str, Any]:
        normalized = normalize_profile(profile)
        self._purge_expired(normalized)
        existing = self.leases.get(normalized)
        if existing:
            raise create_profile_locked_error(profile=normalized, lease=existing.to_dict())
        created_at = self.now()
        lease = ProfileLease(
            lease_id=str(uuid4()),
            profile=normalized,
            owner=owner.strip() if isinstance(owner, str) and owner.strip() else None,
            acquired_at=created_at,
            renewed_at=created_at,
            expires_at=created_at + self._ttl(ttl_ms),
        )
        self.leases[normalized] = lease
        return lease.to_dict()

    def renew(self, *, profile: str, lease_id: str, ttl_ms: int | None = None) -> dict[str, Any]:
        normalized = normalize_profile(profile)
        lease = self._require_active_lease(normalized, lease_id)
        now = self.now()
        lease.renewed_at = now
        lease.expires_at = now + self._ttl(ttl_ms)
        self.leases[normalized] = lease
        return lease.to_dict()

    def release(self, *, profile: str, lease_id: str) -> dict[str, Any]:
        normalized = normalize_profile(profile)
        lease = self._require_active_lease(normalized, lease_id)
        self.leases.pop(normalized, None)
        return {"ok": True, "profile": normalized, "lease_id": lease.lease_id, "released": True}

    def release_all(self, *, profile: str) -> dict[str, Any]:
        normalized = normalize_profile(profile)
        lease = self.leases.pop(normalized, None)
        return {
            "ok": True,
            "profile": normalized,
            "lease_id": lease.lease_id if lease else None,
            "released": lease is not None,
        }

    def status(self, profile: str) -> dict[str, Any]:
        normalized = normalize_profile(profile)
        self._purge_expired(normalized)
        lease = self.leases.get(normalized)
        if lease is None:
            return {"profile": normalized, "locked": False, "lease_id": None, "owner": None, "expires_at": None}
        return {"profile": normalized, "locked": True, "lease_id": lease.lease_id, "owner": lease.owner, "expires_at": lease.expires_at}

    def validate(self, *, profile: str, lease_id: str | None) -> dict[str, Any]:
        normalized = normalize_profile(profile)
        lease = self._require_active_lease(normalized, lease_id)
        return {"ok": True, "profile": normalized, "lease_id": lease.lease_id, "owner": lease.owner, "expires_at": lease.expires_at}


def serialize_profile_lease_error(err: Exception) -> dict[str, Any]:
    body = {"error": str(err)}
    if isinstance(err, ProfileLeaseError):
        body.update({
            "code": err.code,
            "reason": err.reason,
            "required_lease_id": err.required_lease_id,
        })
        if err.profile is not None:
            body["profile"] = err.profile
        lease = err.lease or {}
        for key in ("lease_id", "owner", "expires_at"):
            if key in lease:
                body[key] = lease[key]
    return body


lease_manager = ProfileLeaseManager()
