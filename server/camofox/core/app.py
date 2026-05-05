"""
FastAPI app factory — create_app(config) builds and returns the ASGI application.

Mounts all API routers, registers startup/shutdown hooks, configures CORS and auth.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from camofox.core.config import Config
from camofox.core.auth import require_auth
from camofox.core.plugins import plugin_events
from camofox.core.browser import close_all_browsers
from camofox.core.session import close_all_sessions, handle_route_error
from camofox.domain.proxy import create_proxy_pool

log = logging.getLogger("camofox.app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler — startup and shutdown."""
    log.info("managed-browser starting up")

    # Startup: initialize proxy pool if configured
    proxy_config = app.state.config.proxy
    if proxy_config.host or proxy_config.ports:
        pool = create_proxy_pool(proxy_config)
        log.info("Proxy pool initialized: %s", "success" if pool else "none (no pool created)")

    await plugin_events.emit_async("server:started", config=app.state.config)
    yield
    # Shutdown
    log.info("managed-browser shutting down")
    await plugin_events.emit_async("server:stopped")
    await close_all_sessions("server_shutdown")
    await close_all_browsers()


def create_app(config: Optional[Config] = None) -> FastAPI:
    """Create and configure the FastAPI application."""
    if config is None:
        config = Config.load()

    app = FastAPI(
        title="Managed Browser",
        description="Managed browser automation server with multi-engine support",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.state.config = config

    # CORS — allow all origins, methods, and headers
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Auth middleware
    auth_middleware = require_auth(config)
    app.middleware("http")(auth_middleware)

    # Mount API routers
    from camofox.api.admin import router as admin_router
    from camofox.api.sessions import router as sessions_router
    from camofox.api.tabs import router as tabs_router
    from camofox.api.managed import router as managed_router
    from camofox.api.notifications import router as notifications_router
    from camofox.api.memory import router as memory_router
    from camofox.api.vnc import router as vnc_router
    from camofox.api.legacy import router as legacy_router

    app.include_router(admin_router, prefix="")       # /health, /metrics
    app.include_router(legacy_router, prefix="")      # Node.js compatibility
    app.include_router(sessions_router, prefix="")    # /start, /stop, /sessions/...
    app.include_router(tabs_router, prefix="")        # /tabs/...
    app.include_router(managed_router, prefix="/managed")  # /managed/profiles, /managed/cli...
    app.include_router(notifications_router, prefix="/notifications")
    app.include_router(memory_router, prefix="/memory")
    app.include_router(vnc_router, prefix="/vnc")

    # Global exception handler for common Playwright / camofox errors
    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception):
        log.error("Unhandled exception on %s %s: %s", request.method, request.url.path, exc)
        status, body = await handle_route_error(exc)
        return JSONResponse(status_code=status, content=body)

    return app
