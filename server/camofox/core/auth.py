"""Authentication middleware for FastAPI."""
from __future__ import annotations

from typing import Optional

from fastapi import HTTPException, Request
from starlette.status import HTTP_403_FORBIDDEN

from .config import Config
from .utils import is_loopback_address, timing_safe_compare


def require_auth(config: Config):
    """Return a FastAPI middleware/dependency that checks auth."""
    api_key = config.api_key
    is_production = config.node_env == "production"

    async def auth_middleware(request: Request, call_next):
        # Allow preflight OPTIONS
        if request.method == "OPTIONS":
            return await call_next(request)

        # No key configured and not production → allow loopback only
        if not api_key and not is_production:
            client_host = request.client.host if request.client else ""
            if is_loopback_address(client_host):
                return await call_next(request)
            raise HTTPException(
                status_code=HTTP_403_FORBIDDEN,
                detail="Forbidden: non-loopback requests require an API key",
            )

        # Key configured → require it
        if api_key:
            auth_header = request.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                provided_key = auth_header[7:]
                if timing_safe_compare(provided_key, api_key):
                    return await call_next(request)
            raise HTTPException(
                status_code=HTTP_403_FORBIDDEN,
                detail="Forbidden: invalid or missing API key",
            )

        # No key, not production → allow all
        return await call_next(request)

    return auth_middleware
