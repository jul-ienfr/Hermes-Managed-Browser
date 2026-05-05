"""JSON schemas for Managed Browser browser plugin tools."""

PROFILE_PROPS = {
    "profile": {"type": "string", "description": "Explicit managed profile, e.g. leboncoin-ju, leboncoin-ge, ju, or ge."},
    "site": {"type": "string", "description": "Optional site key guard, e.g. leboncoin."},
}
TAB_PROPS = {
    "tab_id": {"type": "string", "description": "Optional tab identifier"},
    "tabId": {"type": "string", "description": "Optional tab identifier (camelCase compatibility)"},
}
HUMAN_PROPS = {
    "human_profile": {"type": "string", "description": "Optional human action profile"},
    "humanProfile": {"type": "string", "description": "Optional human action profile (camelCase compatibility)"},
}


def schema(name, description, properties, required):
    return {
        "name": name,
        "description": description,
        "parameters": {"type": "object", "properties": properties, "required": required},
    }

MANAGED_BROWSER_LAUNCH_VISIBLE_WINDOW = schema(
    "managed_browser_launch_visible_window",
    "Open a server-owned visible Managed Browser tab for an explicit managed profile.",
    {**PROFILE_PROPS, **HUMAN_PROPS, "url": {"type": "string", "description": "URL to open; defaults to the profile start URL"}},
    ["profile"],
)
MANAGED_BROWSER_PROFILE_STATUS = schema(
    "managed_browser_profile_status",
    "Inspect managed browser profile policy and current remembered tab without opening a browser.",
    PROFILE_PROPS,
    ["profile"],
)
MANAGED_BROWSER_CHECKPOINT_STORAGE = schema(
    "managed_browser_checkpoint_storage",
    "Persist Managed Browser storage state for an explicit profile.",
    {**PROFILE_PROPS, "reason": {"type": "string", "description": "Optional checkpoint reason"}},
    ["profile"],
)
MANAGED_BROWSER_HUMAN_VIEW_URL = schema(
    "managed_browser_human_view_url",
    "Return the human-only local noVNC URL for manual viewing/control; this tool does not inspect or control VNC.",
    PROFILE_PROPS,
    ["profile"],
)
MANAGED_BROWSER_NAVIGATE = schema(
    "managed_browser_navigate",
    "Navigate a Managed Browser profile tab; opens a managed tab if no tabId is supplied.",
    {**PROFILE_PROPS, **TAB_PROPS, "url": {"type": "string", "description": "URL to navigate to"}},
    ["profile"],
)
MANAGED_BROWSER_SNAPSHOT = schema(
    "managed_browser_snapshot",
    "Get a managed-profile accessibility snapshot with refs.",
    {**PROFILE_PROPS, **TAB_PROPS, "full": {"type": "boolean", "default": False}, "offset": {"type": "integer"}},
    ["profile"],
)
MANAGED_BROWSER_CLICK = schema(
    "managed_browser_click",
    "Humanized managed-profile click by accessibility ref.",
    {**PROFILE_PROPS, **TAB_PROPS, **HUMAN_PROPS, "ref": {"type": "string"}},
    ["profile", "ref"],
)
MANAGED_BROWSER_TYPE = schema(
    "managed_browser_type",
    "Humanized managed-profile typing by accessibility ref.",
    {**PROFILE_PROPS, **TAB_PROPS, **HUMAN_PROPS, "ref": {"type": "string"}, "text": {"type": "string"}},
    ["profile", "ref", "text"],
)
MANAGED_BROWSER_PRESS = schema(
    "managed_browser_press",
    "Humanized managed-profile key press.",
    {**PROFILE_PROPS, **TAB_PROPS, **HUMAN_PROPS, "key": {"type": "string"}},
    ["profile", "key"],
)
MANAGED_BROWSER_SCROLL = schema(
    "managed_browser_scroll",
    "Humanized managed-profile scroll.",
    {**PROFILE_PROPS, **TAB_PROPS, **HUMAN_PROPS, "direction": {"type": "string", "enum": ["up", "down"], "default": "down"}},
    ["profile"],
)
MANAGED_BROWSER_BACK = schema(
    "managed_browser_back",
    "Managed-profile browser history back.",
    {**PROFILE_PROPS, **TAB_PROPS},
    ["profile"],
)
MANAGED_BROWSER_CONSOLE = schema(
    "managed_browser_console",
    "Managed-profile diagnostics or page evaluation for DOM inspection.",
    {**PROFILE_PROPS, **TAB_PROPS, "expression": {"type": "string"}, "clear": {"type": "boolean", "default": False}},
    ["profile"],
)
MANAGED_BROWSER_GET_IMAGES = schema(
    "managed_browser_get_images",
    "List images from a managed-profile page snapshot.",
    {**PROFILE_PROPS, **TAB_PROPS},
    ["profile"],
)
MANAGED_BROWSER_VISION = schema(
    "managed_browser_vision",
    "Visual fallback for a managed-profile page. Use managed_browser_snapshot first; use vision only for CAPTCHA, visual ambiguity, or final visual verification.",
    {**PROFILE_PROPS, **TAB_PROPS, "question": {"type": "string", "description": "What to inspect visually"}, "annotate": {"type": "boolean", "default": False, "description": "Include accessibility snapshot context with element refs when analyzing"}},
    ["profile", "question"],
)

MEMORY_PROPS = {
    **PROFILE_PROPS,
    **TAB_PROPS,
    **HUMAN_PROPS,
    "action_key": {"type": "string", "description": "AgentHistory action key; defaults to default"},
    "actionKey": {"type": "string", "description": "CamelCase AgentHistory action key"},
    "flow_name": {"type": "string", "description": "Flow name alias for run_flow"},
    "parameters": {"type": "object", "description": "Runtime parameters for parameterized replay steps"},
    "url": {"type": "string", "description": "Optional URL context"},
    "allow_llm_repair": {"type": "boolean", "default": False, "description": "Allow server-side LLM repair only as a final fallback; default false"},
    "allowLlmRepair": {"type": "boolean", "default": False, "description": "CamelCase alias; default false"},
    "learn_repairs": {"type": "boolean", "default": False},
    "learnRepairs": {"type": "boolean", "default": False},
}

MANAGED_BROWSER_RUN_MEMORY = schema(
    "managed_browser_run_memory",
    "Replay a managed AgentHistory memory deterministically by default; allow_llm_repair must be explicitly true for final LLM repair fallback.",
    MEMORY_PROPS,
    ["profile"],
)
MANAGED_BROWSER_RUN_FLOW = schema(
    "managed_browser_run_flow",
    "Alias for managed_browser_run_memory using flow_name/action_key.",
    MEMORY_PROPS,
    ["profile"],
)
MANAGED_BROWSER_RECORD_FLOW = schema(
    "managed_browser_record_flow",
    "Record a managed AgentHistory flow from the current managed tab.",
    MEMORY_PROPS,
    ["profile"],
)
MEMORY_ADMIN_PROPS = {
    **PROFILE_PROPS,
    "action_key": {"type": "string", "description": "AgentHistory action key"},
    "actionKey": {"type": "string", "description": "CamelCase AgentHistory action key"},
    "memory_id": {"type": "string", "description": "Optional memory identifier"},
    "memoryId": {"type": "string", "description": "Optional memory identifier (camelCase compatibility)"},
}
MANAGED_BROWSER_LIST_MEMORY = schema(
    "managed_browser_list_memory",
    "List managed AgentHistory memories for an explicit profile.",
    MEMORY_ADMIN_PROPS,
    ["profile"],
)
MANAGED_BROWSER_INSPECT_MEMORY = schema(
    "managed_browser_inspect_memory",
    "Inspect a managed AgentHistory memory for an explicit profile.",
    MEMORY_ADMIN_PROPS,
    ["profile"],
)
MANAGED_BROWSER_DELETE_MEMORY = schema(
    "managed_browser_delete_memory",
    "Delete a managed AgentHistory memory for an explicit profile.",
    MEMORY_ADMIN_PROPS,
    ["profile"],
)
