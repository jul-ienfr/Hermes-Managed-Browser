"""Configuration — chargée depuis env vars + optional JSON config."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict, List, Optional

from pydantic import BaseModel


class ChallengeResolutionConfig(BaseModel):
    mode: str = "manual_vnc"          # manual_vnc
    allowlist: List[str] = []


class ProxyConfig(BaseModel):
    strategy: str = "round_robin"     # round_robin | backconnect
    provider_name: str = "generic"
    host: str = ""
    port: int = 0
    ports: List[int] = []
    username: str = ""
    password: str = ""
    backconnect_host: str = ""
    backconnect_port: int = 0
    country: str = ""
    state: str = ""
    city: str = ""
    session_duration_minutes: int = 10


class VncPluginConfig(BaseModel):
    enabled: bool = True
    resolution: str = "1920x1080"
    vnc_port: int = 5901
    novnc_port: int = 6081
    view_only: bool = False
    bind: str = "0.0.0.0"
    human_only: bool = True
    managed_registry_only: bool = True


class Config(BaseModel):
    # Server
    port: int = 9377
    node_env: str = "development"
    host: str = "0.0.0.0"

    # Auth
    api_key: str = ""
    admin_key: str = ""

    # Browser engines
    default_engine: str = "camoufox-python"
    cloakbrowser_enabled: bool = False
    cloakbrowser_executable_path: str = ""
    cloakbrowser_profile_dir: str = "~/.managed-browser/profiles/cloakbrowser"
    camofox_node_url: str = ""

    # Profile storage
    profile_dir: str = "~/.camofox/profiles"

    # Timeouts (ms)
    handler_timeout_ms: int = 30000
    session_timeout_ms: int = 600000    # 10 min
    tab_inactivity_ms: int = 300000     # 5 min
    navigate_timeout_ms: int = 25000
    buildrefs_timeout_ms: int = 12000
    browser_idle_timeout_ms: int = 300000
    tab_lock_timeout_ms: int = 35000
    page_close_timeout_ms: int = 5000

    # Limits
    max_sessions: int = 50
    max_tabs_per_session: int = 10
    max_tabs_global: int = 50
    max_concurrent_per_user: int = 3
    max_snapshot_nodes: int = 500

    # Prometheus
    prometheus_enabled: bool = False

    # Shared display (for visible browser via VNC)
    shared_display: str = ""
    shared_display_user_ids: List[str] = []

    # Keepalive tab
    keepalive_user_id: str = ""
    keepalive_session_key: str = "manual-login"
    keepalive_url: str = "about:blank"

    # Proxy
    proxy: ProxyConfig = ProxyConfig()

    # Challenge resolution
    challenge_resolution: ChallengeResolutionConfig = ChallengeResolutionConfig()

    # VNC plugin config
    vnc: VncPluginConfig = VncPluginConfig()

    @classmethod
    def load(cls) -> "Config":
        """Load config from env vars + optional config.json."""
        profile_dir = os.environ.get("CAMOFOX_PROFILE_DIR", "~/.camofox/profiles")
        proxy_ports_raw = os.environ.get("PROXY_PORTS", "")
        proxy_ports = []
        if proxy_ports_raw:
            for part in proxy_ports_raw.split(","):
                part = part.strip()
                if "-" in part:
                    lo, hi = part.split("-", 1)
                    proxy_ports.extend(range(int(lo.strip()), int(hi.strip()) + 1))
                else:
                    proxy_ports.append(int(part))

        challenge_allowlist = [
            s.strip()
            for s in os.environ.get("CHALLENGE_RESOLUTION_ALLOWLIST", "").split(",")
            if s.strip()
        ]

        # Read camofox.config.json for plugin config if present
        config_json_path = Path(os.environ.get("CAMOFOX_CONFIG", "camofox.config.json"))
        vnc_cfg = VncPluginConfig()
        if config_json_path.exists():
            try:
                data = json.loads(config_json_path.read_text())
                vnc_data = data.get("plugins", {}).get("vnc", {})
                if vnc_data:
                    vnc_cfg = VncPluginConfig(
                        enabled=vnc_data.get("enabled", True),
                        resolution=vnc_data.get("resolution", "1920x1080"),
                        vnc_port=int(vnc_data.get("vncPort", 5901)),
                        novnc_port=int(vnc_data.get("novncPort", 6081)),
                        view_only=bool(vnc_data.get("viewOnly", False)),
                        bind=vnc_data.get("bind", "0.0.0.0"),
                        human_only=bool(vnc_data.get("humanOnly", True)),
                        managed_registry_only=bool(vnc_data.get("managedRegistryOnly", True)),
                    )
            except Exception:
                pass

        return cls(
            port=int(os.environ.get("PORT", "9377")),
            node_env=os.environ.get("NODE_ENV", "development"),
            api_key=os.environ.get("CAMOFOX_API_KEY", ""),
            admin_key=os.environ.get("CAMOFOX_ADMIN_KEY", ""),
            default_engine=os.environ.get("MANAGED_BROWSER_DEFAULT_ENGINE", "camoufox-python"),
            cloakbrowser_enabled=os.environ.get("CLOAK_BROWSER_ENABLED", "0").lower() in ("1", "true", "yes"),
            cloakbrowser_executable_path=os.environ.get("CLOAK_BROWSER_EXECUTABLE_PATH", ""),
            cloakbrowser_profile_dir=os.environ.get("CLOAK_BROWSER_PROFILE_DIR", "~/.managed-browser/profiles/cloakbrowser"),
            camofox_node_url=os.environ.get("CAMOFOX_NODE_URL", ""),
            profile_dir=profile_dir,
            handler_timeout_ms=int(os.environ.get("CAMOFOX_HANDLER_TIMEOUT_MS", "30000")),
            session_timeout_ms=int(os.environ.get("CAMOFOX_SESSION_TIMEOUT_MS", "600000")),
            tab_inactivity_ms=int(os.environ.get("CAMOFOX_TAB_INACTIVITY_MS", "300000")),
            navigate_timeout_ms=int(os.environ.get("CAMOFOX_NAVIGATE_TIMEOUT_MS", "25000")),
            max_sessions=int(os.environ.get("CAMOFOX_MAX_SESSIONS", "50")),
            max_tabs_per_session=int(os.environ.get("CAMOFOX_MAX_TABS_PER_SESSION", "10")),
            max_tabs_global=int(os.environ.get("CAMOFOX_MAX_TABS_GLOBAL", "50")),
            max_concurrent_per_user=int(os.environ.get("CAMOFOX_MAX_CONCURRENT_PER_USER", "3")),
            browser_idle_timeout_ms=int(os.environ.get("CAMOFOX_BROWSER_IDLE_TIMEOUT_MS", "300000")),
            prometheus_enabled=os.environ.get("CAMOFOX_PROMETHEUS_ENABLED", "0") == "1",
            shared_display=os.environ.get("CAMOFOX_SHARED_DISPLAY", ""),
            shared_display_user_ids=[
                s.strip()
                for s in os.environ.get("CAMOFOX_SHARED_DISPLAY_USER_IDS", "").split(",")
                if s.strip()
            ],
            keepalive_user_id=os.environ.get("CAMOFOX_KEEPALIVE_USER_ID", ""),
            keepalive_session_key=os.environ.get("CAMOFOX_KEEPALIVE_SESSION_KEY", "manual-login"),
            keepalive_url=os.environ.get("CAMOFOX_KEEPALIVE_URL", "about:blank"),
            proxy=ProxyConfig(
                strategy=os.environ.get("PROXY_STRATEGY", "round_robin"),
                provider_name=os.environ.get("PROXY_PROVIDER", "generic"),
                host=os.environ.get("PROXY_HOST", ""),
                port=int(os.environ.get("PROXY_PORT", "0")),
                ports=proxy_ports,
                username=os.environ.get("PROXY_USERNAME", ""),
                password=os.environ.get("PROXY_PASSWORD", ""),
                backconnect_host=os.environ.get("PROXY_BACKCONNECT_HOST", ""),
                backconnect_port=int(os.environ.get("PROXY_BACKCONNECT_PORT", "0")),
                country=os.environ.get("PROXY_COUNTRY", ""),
                state=os.environ.get("PROXY_STATE", ""),
                city=os.environ.get("PROXY_CITY", ""),
                session_duration_minutes=int(os.environ.get("PROXY_SESSION_DURATION_MINUTES", "10")),
            ),
            challenge_resolution=ChallengeResolutionConfig(
                mode=os.environ.get("CHALLENGE_RESOLUTION_MODE", "manual_vnc"),
                allowlist=challenge_allowlist,
            ),
            vnc=vnc_cfg,
        )

    # Module-level singleton — imported as `from camofox.core.config import config`
    @classmethod
    def get_singleton(cls) -> "Config":
        if not hasattr(cls, "_instance"):
            cls._instance = cls.load()
        return cls._instance


config: Config = Config.get_singleton()
