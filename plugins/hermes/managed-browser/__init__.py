"""Hermes plugin: managed-browser.

Update-safe bridge exposing Managed Browser managed_browser_* tools inside
Hermes Python. Hermes does not load the upstream TypeScript plugin.ts directly.
"""

from __future__ import annotations

try:
    from . import schemas, tools
except ImportError:  # pragma: no cover - direct import smoke tests
    import importlib.util
    import sys
    from pathlib import Path

    _PLUGIN_DIR = Path(__file__).resolve().parent
    _PACKAGE = sys.modules.setdefault("managed_browser", sys.modules[__name__])
    setattr(_PACKAGE, "__path__", [str(_PLUGIN_DIR)])

    def _load_local_module(module_name: str, filename: str):
        full_name = f"managed_browser.{module_name}"
        existing = sys.modules.get(full_name)
        if existing is not None:
            return existing
        spec = importlib.util.spec_from_file_location(full_name, _PLUGIN_DIR / filename)
        if spec is None or spec.loader is None:
            raise ImportError(f"Unable to load {full_name} from {filename}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[full_name] = module
        spec.loader.exec_module(module)
        return module

    schemas = _load_local_module("schemas", "schemas.py")
    tools = _load_local_module("tools", "tools.py")


def _register(ctx, name, schema, handler, description, emoji="🦊"):
    ctx.register_tool(
        name=name,
        toolset="browser",
        schema=schema,
        handler=handler,
        check_fn=tools.check_enabled,
        description=description,
        emoji=emoji,
    )


def register(ctx):
    _register(ctx, "managed_browser_launch_visible_window", schemas.MANAGED_BROWSER_LAUNCH_VISIBLE_WINDOW, tools.managed_browser_launch_visible_window, "Open a server-owned visible Managed Browser tab for an explicit managed profile")
    _register(ctx, "managed_browser_profile_status", schemas.MANAGED_BROWSER_PROFILE_STATUS, tools.managed_browser_profile_status, "Inspect managed browser profile policy and current remembered tab")
    _register(ctx, "managed_browser_checkpoint_storage", schemas.MANAGED_BROWSER_CHECKPOINT_STORAGE, tools.managed_browser_checkpoint_storage, "Persist Managed Browser storage state for an explicit profile")
    _register(ctx, "managed_browser_human_view_url", schemas.MANAGED_BROWSER_HUMAN_VIEW_URL, tools.managed_browser_human_view_url, "Return the human-only local noVNC URL for manual viewing/control")
    _register(ctx, "managed_browser_navigate", schemas.MANAGED_BROWSER_NAVIGATE, tools.managed_browser_navigate, "Navigate a Managed Browser profile tab")
    _register(ctx, "managed_browser_snapshot", schemas.MANAGED_BROWSER_SNAPSHOT, tools.managed_browser_snapshot, "Get a managed-profile accessibility snapshot with refs")
    _register(ctx, "managed_browser_click", schemas.MANAGED_BROWSER_CLICK, tools.managed_browser_click, "Humanized managed-profile click by accessibility ref")
    _register(ctx, "managed_browser_type", schemas.MANAGED_BROWSER_TYPE, tools.managed_browser_type, "Humanized managed-profile typing by accessibility ref")
    _register(ctx, "managed_browser_press", schemas.MANAGED_BROWSER_PRESS, tools.managed_browser_press, "Humanized managed-profile key press")
    _register(ctx, "managed_browser_scroll", schemas.MANAGED_BROWSER_SCROLL, tools.managed_browser_scroll, "Humanized managed-profile scroll")
    _register(ctx, "managed_browser_back", schemas.MANAGED_BROWSER_BACK, tools.managed_browser_back, "Managed-profile browser history back")
    _register(ctx, "managed_browser_console", schemas.MANAGED_BROWSER_CONSOLE, tools.managed_browser_console, "Managed-profile diagnostics or page evaluation for DOM inspection")
    _register(ctx, "managed_browser_get_images", schemas.MANAGED_BROWSER_GET_IMAGES, tools.managed_browser_get_images, "List images from a managed-profile page snapshot")
    _register(ctx, "managed_browser_vision", schemas.MANAGED_BROWSER_VISION, tools.managed_browser_vision, "Visual fallback for a managed-profile page")
    _register(ctx, "managed_browser_run_memory", schemas.MANAGED_BROWSER_RUN_MEMORY, tools.managed_browser_run_memory, "Replay a managed AgentHistory memory with deterministic repair by default")
    _register(ctx, "managed_browser_run_flow", schemas.MANAGED_BROWSER_RUN_FLOW, tools.managed_browser_run_flow, "Replay a managed AgentHistory flow by name")
    _register(ctx, "managed_browser_record_flow", schemas.MANAGED_BROWSER_RECORD_FLOW, tools.managed_browser_record_flow, "Record a managed AgentHistory flow from the current managed tab")
    _register(ctx, "managed_browser_list_memory", schemas.MANAGED_BROWSER_LIST_MEMORY, tools.managed_browser_list_memory, "List managed AgentHistory memories for an explicit profile")
    _register(ctx, "managed_browser_inspect_memory", schemas.MANAGED_BROWSER_INSPECT_MEMORY, tools.managed_browser_inspect_memory, "Inspect a managed AgentHistory memory for an explicit profile")
    _register(ctx, "managed_browser_delete_memory", schemas.MANAGED_BROWSER_DELETE_MEMORY, tools.managed_browser_delete_memory, "Delete a managed AgentHistory memory for an explicit profile")
