"""Core modules for Managed Browser."""
from .config import Config, ProxyConfig, ChallengeResolutionConfig
from .auth import require_auth
from .plugins import plugin_events, PluginEvents
from .utils import (
    normalize_user_id,
    make_tab_id,
    user_dir_from_id,
    sha256_hex,
    timing_safe_compare,
    is_loopback_address,
    validate_url,
    safe_page_close,
    is_dead_context_error,
    is_timeout_error,
    is_proxy_error,
    resolve_profile_root,
    coalesce_inflight,
    random_id,
    clamp_to_viewport,
    make_session_id,
)
