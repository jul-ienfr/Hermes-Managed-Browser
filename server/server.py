#!/usr/bin/env python3
"""
Managed Browser — Python backend entrypoint.

Usage:
  python server.py                          # all default
  CAMOFOX_API_KEY=secret python server.py   # with auth
  PORT=9377 python server.py                # custom port
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

import uvicorn

from camofox.core.config import Config


def main():
    parser = argparse.ArgumentParser(description="Managed Browser — Python")
    parser.add_argument("--port", type=int, default=None, help="Port to bind")
    parser.add_argument("--host", type=str, default=None, help="Host to bind")
    parser.add_argument("--log-level", type=str, default="info", help="Log level")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload (dev)")
    args = parser.parse_args()

    config = Config.load()

    host = args.host or config.host or "0.0.0.0"
    port = args.port or config.port or 9377
    log_level = args.log_level.upper()

    logging.basicConfig(
        level=getattr(logging, log_level, logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    logging.getLogger("camofox").setLevel(getattr(logging, log_level, logging.INFO))

    # Lazily create app so uvicorn reload picks up changes
    from camofox.core.app import create_app

    app = create_app(config)

    print(f"Managed Browser starting on http://{host}:{port}")

    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level=args.log_level or "info",
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
