"""Session and tab management — BrowserContext, tab groups, tab locks, lifecycle.

Mirrors the Node.js session management from server.js / browser.ts:
  - SessionState holds a Playwright BrowserContext + tab groups per userId
  - TabLock serializes operations on a single tab
  - get_session() / close_session() manage the full session lifecycle
  - handle_route_error() centralises error-to-HTTP-response mapping
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from camofox.core.config import config
from camofox.core.engines import normalize_engine, make_browser_key
from camofox.core.metrics import (
    refresh_active_tabs,
    refresh_active_sessions,
    refresh_tab_lock_queue_depth,
    record_failure,
    record_tab_destroyed,
    tabs_recycled_total,
    page_load_duration,
)
from camofox.core.plugins import plugin_events
from camofox.core.utils import (
    coalesce_inflight,
    make_session_id,
    make_tab_id,
    normalize_user_id,
    safe_page_close,
)
from camofox.domain.profile import load_persisted_storage_state, persist_storage_state

log = logging.getLogger("camofox.session")

# ---------------------------------------------------------------------------
# Custom exceptions
# ---------------------------------------------------------------------------


class TabLockTimeoutError(asyncio.TimeoutError):
    """Raised when a tab lock cannot be acquired within the configured timeout."""


class TabDestroyedError(RuntimeError):
    """Raised when an operation targets a tab that has been destroyed."""


# ---------------------------------------------------------------------------
# TabState  (per-tab runtime metadata)
# ---------------------------------------------------------------------------


@dataclass
class TabState:
    """Runtime state for a single browser tab (Playwright Page + metadata)."""

    page: Any  # playwright Page
    refs: dict = field(default_factory=dict)  # refId -> {role, name, nth, …}
    visited_urls: set = field(default_factory=set)
    downloads: list = field(default_factory=list)
    tool_calls: int = 0
    consecutive_timeouts: int = 0
    last_snapshot: Any = None
    last_snapshot_url: str | None = None
    last_requested_url: str | None = None
    keep_alive: bool = False
    google_retry_count: int = 0
    navigate_abort: Any = None  # asyncio.Event for abort signal
    recovery_meta: dict = field(default_factory=dict)
    agent_history_steps: list = field(default_factory=list)
    console_messages: list = field(default_factory=list)
    js_errors: list = field(default_factory=list)
    human_session: Any = None
    behavior_persona: Any = None


# ---------------------------------------------------------------------------
# SessionState  (per-user BrowserContext + tab groups)
# ---------------------------------------------------------------------------


@dataclass
class SessionState:
    """State for one user session (Playwright BrowserContext + tabs)."""

    context: Any  # playwright BrowserContext
    engine: str
    tab_groups: dict[str, dict[str, TabState]] = field(default_factory=dict)
    # sessionKey -> {tabId: TabState}
    profile_dir: str | None = None
    launch_persona: dict | None = None
    display: str | None = None
    last_access: float = field(default_factory=time.time)
    proxy_session_id: str | None = None
    browser_proxy_session_id: str | None = None
    _closing: bool = False


# ---------------------------------------------------------------------------
# Global state  (keyed by normalised userId)
# ---------------------------------------------------------------------------

sessions: dict[str, SessionState] = {}
session_creations: dict[str, asyncio.Task] = {}
tab_locks: dict[str, "_TabLock"] = {}

# Lazy-loaded proxy_pool reference (matches browser.py pattern)
_proxy_pool_instance: Any = None


def _get_proxy_pool():
    """Lazy import of proxy_pool to avoid circular dependency."""
    global _proxy_pool_instance
    if _proxy_pool_instance is None:
        try:
            from camofox.core.proxy_pool import proxy_pool

            _proxy_pool_instance = proxy_pool
        except ImportError:
            _proxy_pool_instance = False  # sentinel
    return _proxy_pool_instance if _proxy_pool_instance is not False else None


# ---------------------------------------------------------------------------
# TabLock  — async context manager serialising operations on a single tab
# ---------------------------------------------------------------------------


class _TabLock:
    """Async context manager that serialises access to a tab.

    Each tab gets one _TabLock instance.  Callers ``await lock.acquire()``
    to wait their turn; the lock is automatically released on ``__aexit__``.
    """

    def __init__(self, tab_id: str, timeout_ms: int | None = None) -> None:
        self.tab_id = tab_id
        self._timeout_ms = timeout_ms or config.tab_lock_timeout_ms
        self._queue: asyncio.Queue[asyncio.Future | None] = asyncio.Queue()
        self._current_holder: asyncio.Future | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def acquire(self) -> "_TabLock":
        """Enter the lock queue and wait for our turn."""
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        await self._queue.put(fut)

        # If we are the only waiter we can proceed immediately
        if self._queue.qsize() == 1:
            self._current_holder = fut
            fut.set_result(self)
            return self

        # Wait with timeout
        timeout_s = self._timeout_ms / 1000.0
        try:
            await asyncio.wait_for(fut, timeout=timeout_s)
        except asyncio.TimeoutError:
            # Remove our future from the queue (best-effort)
            self._drain_future(fut)
            raise TabLockTimeoutError(
                f"Tab lock timeout for {self.tab_id} after {self._timeout_ms}ms"
            ) from None

        return self

    async def release(self) -> None:
        """Release the lock and wake the next waiter."""
        self._current_holder = None
        if self._queue.qsize() > 0:
            _ = await self._queue.get()  # remove the just-released holder
            self._queue.task_done()
            # Wake next waiter
            if self._queue.qsize() > 0:
                next_fut = self._queue.get_nowait()
                self._current_holder = next_fut
                next_fut.set_result(self)
                self._queue.task_done()

    def drain(self) -> None:
        """Cancel all pending waiters (tab is being destroyed)."""
        while self._queue.qsize() > 0:
            try:
                fut = self._queue.get_nowait()
                self._queue.task_done()
                if fut is not None and not fut.done():
                    fut.cancel()
            except asyncio.QueueEmpty:
                break
        self._current_holder = None

    def queue_depth(self) -> int:
        """Return the number of waiters currently in the queue."""
        return self._queue.qsize()

    # ------------------------------------------------------------------
    # Context manager support
    # ------------------------------------------------------------------

    async def __aenter__(self) -> "_TabLock":
        return await self.acquire()

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: Any,
    ) -> None:
        await self.release()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _drain_future(self, fut: asyncio.Future) -> None:
        """Remove a specific future from the queue if still present."""
        remaining: list[asyncio.Future | None] = []
        while self._queue.qsize() > 0:
            try:
                item = self._queue.get_nowait()
                self._queue.task_done()
                if item is not fut and item is not None:
                    remaining.append(item)
            except asyncio.QueueEmpty:
                break
        for item in remaining:
            self._queue.put_nowait(item)


# ---------------------------------------------------------------------------
# Convenience wrapper: with_tab_lock
# ---------------------------------------------------------------------------


async def with_tab_lock(
    tab_id: str,
    fn: Callable[..., Any],
    timeout_ms: int | None = None,
) -> Any:
    """Acquire tab lock, execute ``fn``, release.

    ``fn`` receives no arguments; use a closure or functools.partial to
    pass context.
    """
    lock = tab_locks.get(tab_id)
    if lock is None:
        lock = _TabLock(tab_id, timeout_ms=timeout_ms)
        tab_locks[tab_id] = lock
    async with lock:
        return await fn()


# ---------------------------------------------------------------------------
# TabLock helpers (for metrics)
# ---------------------------------------------------------------------------


def _update_tab_lock_metrics() -> None:
    """Refresh Prometheus gauge for total queue depth across all locks."""
    total_depth = sum(lock.queue_depth() for lock in tab_locks.values())
    refresh_tab_lock_queue_depth(total_depth)


# ---------------------------------------------------------------------------
# get_total_tab_count
# ---------------------------------------------------------------------------


def get_total_tab_count() -> int:
    """Count tabs across ALL sessions."""
    total = 0
    for session in sessions.values():
        for group in session.tab_groups.values():
            total += len(group)
    return total


# ---------------------------------------------------------------------------
# get_session   (main session getter / creator)
# ---------------------------------------------------------------------------


async def get_session(
    user_id: str,
    profile_dir: str | None = None,
    engine: str | None = None,
) -> SessionState:
    """Return a usable ``SessionState`` for *user_id*.

    1. Normalise the user id.
    2. If an existing session is found:
       - If the context is dead → close and recreate.
       - If the profile dir differs → close and recreate.
    3. If no session exists → create a new BrowserContext via
       :func:`_create_session`.
    4. Update ``last_access`` on every call.
    5. Concurrent calls for the same userId are coalesced via
       ``coalesce_inflight``.
    """
    uid = normalize_user_id(user_id)
    normalized_engine = normalize_engine(engine or config.default_engine)
    browser_key = make_browser_key(normalized_engine, uid)

    async def _do_get() -> SessionState:
        session = sessions.get(browser_key)
        if session is not None:
            # Check for dead context
            if not _context_is_alive(session):
                log.warning("Dead context detected for %s — recreating session", uid)
                await close_session(uid, session, reason="dead_context")
                session = None
            elif session._closing:
                log.warning("Session %s is closing — waiting then recreating", uid)
                await _wait_for_closing(session)
                session = None
            elif profile_dir is not None and session.profile_dir != profile_dir:
                log.info(
                    "Profile dir changed for %s (%s -> %s) — recreating session",
                    uid,
                    session.profile_dir,
                    profile_dir,
                )
                await close_session(uid, session, reason="profile_dir_changed")
                session = None

        if session is None:
            session = await _create_session(uid, profile_dir=profile_dir, engine=normalized_engine)

        session.last_access = time.time()
        return session

    return await coalesce_inflight(session_creations, browser_key, _do_get)


def _context_is_alive(session: SessionState) -> bool:
    """Quick synchronous alive check for the BrowserContext."""
    ctx = session.context
    if ctx is None:
        return False
    try:
        # Playwright BrowserContext has a `pages` property that raises
        # if the context is closed.
        _ = ctx.pages
        return True
    except Exception:
        return False


async def _wait_for_closing(session: SessionState) -> None:
    """Wait until a session is no longer in the closing state."""
    deadline = time.time() + 10.0
    while session._closing and time.time() < deadline:
        await asyncio.sleep(0.1)


# ---------------------------------------------------------------------------
# _create_session   (low-level context creation)
# ---------------------------------------------------------------------------


async def _create_session(
    user_id: str,
    profile_dir: str | None = None,
    engine: str | None = None,
) -> SessionState:
    """Create a new BrowserContext + SessionState.

    Steps:
      1. Ensure a browser is running for this user (via ``ensure_browser``).
      2. Determine persona-dependent context options (viewport, locale,
         timezone, geolocation, …).
      3. Obtain a proxy session from the proxy pool (if rotating sessions).
      4. Create a new BrowserContext on the shared browser instance.
      5. Inject ``deviceMemory`` via ``add_init_script``.
      6. Install notification/page-event capture on all pages.
      7. Build and return the ``SessionState``.
    """
    from camofox.core.browser import ensure_browser

    uid = normalize_user_id(user_id)
    normalized_engine = normalize_engine(engine or config.default_engine)
    browser_key = make_browser_key(normalized_engine, uid)

    # --- 1. Ensure browser is running ---
    browser_info = await ensure_browser(user_id=uid, profile_dir=profile_dir, engine=normalized_engine)
    browser = browser_info["browser"]
    launch_persona = browser_info.get("persona", {})
    display = browser_info.get("display")
    launch_proxy = browser_info.get("launch_proxy")

    # --- 2. Determine context options ---
    context_defaults = launch_persona.get("contextDefaults", {}) if launch_persona else {}

    viewport = context_defaults.get("viewport", {"width": 1280, "height": 720})
    locale = context_defaults.get("locale") or launch_persona.get("locale")
    timezone_id = context_defaults.get("timezoneId") or launch_persona.get("timezoneId")
    geolocation = context_defaults.get("geolocation") or launch_persona.get("geolocation")
    permissions = context_defaults.get("permissions", ["geolocation"])
    device_memory = context_defaults.get("deviceMemory")

    context_options: dict[str, Any] = {
        "viewport": viewport,
        "permissions": permissions,
        "user_agent": context_defaults.get("userAgent"),
    }

    if locale:
        context_options["locale"] = locale
    if timezone_id:
        context_options["timezone_id"] = timezone_id
    if geolocation:
        context_options["geolocation"] = geolocation

    # --- 3. Proxy for context ---
    proxy_for_context: dict | None = None
    proxy_pool = _get_proxy_pool()
    if proxy_pool is not None:
        try:
            can_rotate = getattr(proxy_pool, "canRotateSessions", False)
            if can_rotate:
                proxy_for_context = await proxy_pool.getNext()
            else:
                # Use the same proxy as the browser launch
                proxy_for_context = launch_proxy
        except Exception as exc:
            log.warning("Failed to obtain context proxy: %s", exc)
    else:
        proxy_for_context = launch_proxy

    if proxy_for_context:
        proxy_dict: dict[str, str] = {}
        if proxy_for_context.get("host"):
            proxy_dict["server"] = (
                f"{proxy_for_context['host']}:{proxy_for_context.get('port', 0)}"
            )
        if proxy_for_context.get("username"):
            proxy_dict["username"] = proxy_for_context["username"]
        if proxy_for_context.get("password"):
            proxy_dict["password"] = proxy_for_context["password"]
        if proxy_dict:
            context_options["proxy"] = proxy_dict

    # --- 4. Create the BrowserContext ---
    effective_profile_dir = profile_dir or config.profile_dir
    storage_state_path = load_persisted_storage_state(effective_profile_dir, uid)
    if storage_state_path:
        context_options["storage_state"] = storage_state_path
        log.debug("Loading persisted storage state for %s from %s", uid, storage_state_path)

    plugin_events.emit("session:creating", user_id=uid)
    context = await browser.new_context(**context_options)

    # --- 5. Inject deviceMemory if specified ---
    if device_memory is not None:
        try:
            await context.add_init_script(
                f"Object.defineProperty(navigator, 'deviceMemory', {{ getter: () => {device_memory} }});"
            )
        except Exception as exc:
            log.warning("Failed to inject deviceMemory: %s", exc)

    # --- 6. Install notification capture on all pages ---
    try:
        await context.add_init_script("""
            // Capture console messages
            window.__camofox_console = [];
            const origConsole = {};
            ['log','warn','error','info','debug'].forEach(m => {
                origConsole[m] = console[m];
                console[m] = (...args) => {
                    window.__camofox_console.push({method: m, args: args.map(a => String(a)), timestamp: Date.now()});
                    origConsole[m].apply(console, args);
                };
            });
        """)
    except Exception as exc:
        log.warning("Failed to install console capture: %s", exc)

    # Listen for new pages to attach event handlers
    context.on("page", _on_new_page)

    session_id = make_session_id()
    proxy_session_id = f"psess-{session_id}"
    browser_proxy_session_id = launch_proxy.get("sessionId") if launch_proxy else None

    session_state = SessionState(
        context=context,
        engine=normalized_engine,
        profile_dir=effective_profile_dir,
        launch_persona=launch_persona,
        display=display,
        proxy_session_id=proxy_session_id,
        browser_proxy_session_id=browser_proxy_session_id,
    )

    sessions[browser_key] = session_state
    refresh_active_sessions(len(sessions))

    plugin_events.emit("session:created", user_id=uid, session=session_state)

    log.info("Session created for %s (%s, engine=%s)", uid, session_id, normalized_engine)
    return session_state


def _on_new_page(page: Any) -> None:
    """Attach page-level event listeners for console, error, and close."""
    try:
        page.on("console", _make_console_handler(page))
        page.on("pageerror", _make_page_error_handler(page))
        page.on("close", _make_page_close_handler(page))
    except Exception as exc:
        log.warning("Failed to attach page handlers: %s", exc)


def _make_console_handler(page: Any) -> Callable:
    """Return a handler that captures console messages into TabState."""

    def handler(msg: Any) -> None:
        # Find the owning tab and append
        for session in sessions.values():
            for group in session.tab_groups.values():
                for tab_id, ts in group.items():
                    if ts.page is page:
                        ts.console_messages.append(
                            {
                                "type": msg.type,
                                "text": msg.text,
                                "timestamp": time.time(),
                            }
                        )
                        return

    return handler


def _make_page_error_handler(page: Any) -> Callable:
    """Return a handler that captures JS errors into TabState."""

    def handler(error: Any) -> None:
        for session in sessions.values():
            for group in session.tab_groups.values():
                for tab_id, ts in group.items():
                    if ts.page is page:
                        ts.js_errors.append(
                            {
                                "message": str(error),
                                "timestamp": time.time(),
                            }
                        )
                        return

    return handler


def _make_page_close_handler(page: Any) -> Callable:
    """Return a handler that cleans up TabState on page close."""

    def handler() -> None:
        tab_id = None
        for session in sessions.values():
            for group_key, group in list(session.tab_groups.items()):
                for tid, ts in list(group.items()):
                    if ts.page is page:
                        tab_id = tid
                        del group[tid]
                        if not group:
                            del session.tab_groups[group_key]
                        return

    return handler


# ---------------------------------------------------------------------------
# close_session
# ---------------------------------------------------------------------------


async def close_session(
    user_id: str,
    session: SessionState,
    reason: str = "session_closed",
    clear_downloads: bool = True,
    clear_locks: bool = True,
) -> None:
    """Close a session: save storage state, clear downloads, emit events, close context.

    * Marks the session as ``_closing`` to prevent re-use.
    * Drains all tab locks if *clear_locks* is ``True``.
    * Clears download references if *clear_downloads* is ``True``.
    * Attempts to save storage state (cookies / localStorage).
    * Closes the Playwright BrowserContext.
    * Removes the session from the global registry.
    """
    uid = normalize_user_id(user_id)
    browser_key = make_browser_key(session.engine, uid)

    if session._closing:
        log.debug("Session %s already closing — skipping", uid)
        return
    session._closing = True

    plugin_events.emit("session:destroying", user_id=uid, reason=reason)

    log.info("Closing session %s (reason=%s)", uid, reason)

    # --- Clear locks ---
    if clear_locks:
        for group in session.tab_groups.values():
            for tab_id in list(group.keys()):
                lock = tab_locks.pop(tab_id, None)
                if lock is not None:
                    lock.drain()

    # --- Save storage state before page/context teardown ---
    # Playwright can refuse BrowserContext.storage_state() once pages or the
    # underlying browser have started closing. Persist first, then destroy tabs.
    try:
        if session.profile_dir is not None and hasattr(session.context, "storage_state"):
            result = await asyncio.wait_for(
                persist_storage_state(session.profile_dir, uid, session.context), timeout=5.0
            )
            if result.get("error"):
                log.warning("Failed to persist storage state for %s: %s", uid, result["error"])
            else:
                log.debug("Storage state persisted for %s to %s", uid, result.get("path"))
    except Exception as exc:
        log.warning("Failed to save storage state for %s: %s", uid, exc)

    # --- Clear downloads before tab registry teardown ---
    if clear_downloads:
        for group in session.tab_groups.values():
            for ts in group.values():
                ts.downloads.clear()

    # --- Destroy tabs ---
    for group_key, group in list(session.tab_groups.items()):
        for tab_id, ts in list(group.items()):
            try:
                await safe_page_close(ts.page, timeout_ms=config.page_close_timeout_ms)
            except Exception:
                pass
            record_tab_destroyed(reason=reason).inc()
            group.pop(tab_id, None)
        if not group:
            session.tab_groups.pop(group_key, None)

    # --- Close the context ---
    ctx = session.context
    if ctx is not None:
        try:
            await asyncio.wait_for(ctx.close(), timeout=10.0)
        except asyncio.TimeoutError:
            log.warning("Context close timed out for %s", uid)
        except Exception as exc:
            log.warning("Error closing context for %s: %s", uid, exc)

    # --- Remove from registry ---
    if sessions.get(browser_key) is session:
        del sessions[browser_key]

    refresh_active_sessions(len(sessions))
    refresh_active_tabs(get_total_tab_count())

    plugin_events.emit("session:destroyed", user_id=uid, reason=reason)
    log.info("Session closed for %s (reason=%s)", uid, reason)


# ---------------------------------------------------------------------------
# destroy_session  (fire-and-forget)
# ---------------------------------------------------------------------------


def destroy_session(user_id: str, engine: str | None = None) -> None:
    """Immediately remove session from the global dict (fire-and-forget close).

    The actual close is scheduled as an asyncio task to avoid blocking.
    """
    uid = normalize_user_id(user_id)
    normalized_engine = normalize_engine(engine or config.default_engine)
    browser_key = make_browser_key(normalized_engine, uid)
    session = sessions.pop(browser_key, None)
    if session is None:
        return
    refresh_active_sessions(len(sessions))
    asyncio.ensure_future(
        close_session(uid, session, reason="destroyed", clear_downloads=True, clear_locks=True)
    )


# ---------------------------------------------------------------------------
# close_all_sessions
# ---------------------------------------------------------------------------


async def close_all_sessions(reason: str = "server_shutdown") -> None:
    """Close every tracked session."""
    keys = list(sessions.keys())
    if not keys:
        return
    log.info("Closing all sessions (%d total)", len(keys))
    for key in keys:
        session = sessions.get(key)
        if session is not None:
            uid = key.split(":", 1)[1] if ":" in key else key
            await close_session(uid, session, reason=reason)
    log.info("All sessions closed")


# ---------------------------------------------------------------------------
# find_tab
# ---------------------------------------------------------------------------


def find_tab(
    session: SessionState,
    tab_id: str,
) -> dict | None:
    """Locate a tab across all groups in a session.

    Returns ``{tab_state, list_item_id, group}`` or ``None`` if not found.
    """
    for group_key, group in session.tab_groups.items():
        if tab_id in group:
            return {
                "tab_state": group[tab_id],
                "list_item_id": tab_id,
                "group": group_key,
            }
    return None


# ---------------------------------------------------------------------------
# get_tab_group
# ---------------------------------------------------------------------------


def get_tab_group(session: SessionState, session_key: str) -> dict:
    """Get or create a tab group (``dict[str, TabState]``) for *session_key*."""
    if session_key not in session.tab_groups:
        session.tab_groups[session_key] = {}
    return session.tab_groups[session_key]


# ---------------------------------------------------------------------------
# destroy_tab
# ---------------------------------------------------------------------------


async def destroy_tab(
    session: SessionState,
    tab_id: str,
    reason: str,
    user_id: str | None = None,
) -> bool:
    """Destroy a stuck / errored tab.

    1. Drain the tab lock queue (cancels pending operations).
    2. Close the page.
    3. Remove from the group.
    4. Emit ``tab:destroyed`` event.

    Returns ``True`` if the tab was found and destroyed, ``False`` otherwise.
    """
    found = find_tab(session, tab_id)
    if found is None:
        return False

    ts = found["tab_state"]
    group_key = found["group"]
    group = session.tab_groups.get(group_key, {})
    if tab_id in group:
        del group[tab_id]
        if not group:
            del session.tab_groups[group_key]

    # Drain the tab lock
    lock = tab_locks.pop(tab_id, None)
    if lock is not None:
        lock.drain()

    # Close the page
    try:
        await safe_page_close(ts.page, timeout_ms=config.page_close_timeout_ms)
    except Exception:
        pass

    record_tab_destroyed(reason=reason).inc()
    refresh_active_tabs(get_total_tab_count())

    plugin_events.emit(
        "tab:destroyed",
        tab_id=tab_id,
        user_id=user_id,
        reason=reason,
    )

    log.debug("Tab %s destroyed (reason=%s)", tab_id, reason)
    return True


# ---------------------------------------------------------------------------
# recycle_oldest_tab
# ---------------------------------------------------------------------------


async def recycle_oldest_tab(
    session: SessionState,
    user_id: str | None = None,
) -> dict | None:
    """Recycle the tab with the fewest ``tool_calls`` across all groups.

    Returns the recycled tab's info dict (``{tab_state, list_item_id, group}``)
    or ``None`` if no tabs exist.
    """
    best: dict | None = None
    best_calls: int | None = None

    for group_key, group in session.tab_groups.items():
        for tab_id, ts in group.items():
            if best is None or ts.tool_calls < best_calls:
                best = {
                    "tab_state": ts,
                    "list_item_id": tab_id,
                    "group": group_key,
                }
                best_calls = ts.tool_calls

    if best is not None:
        tab_id = best["list_item_id"]
        await destroy_tab(
            session,
            tab_id,
            reason="recycled",
            user_id=user_id,
        )
        tabs_recycled_total.inc()
        log.debug("Tab %s recycled (tool_calls=%d)", tab_id, best_calls)

    return best


# ---------------------------------------------------------------------------
# create_tab_state
# ---------------------------------------------------------------------------


def create_tab_state(page: Any, options: dict | None = None) -> TabState:
    """Create a ``TabState`` with all defaults, optionally merging *options*."""
    opts = options or {}
    return TabState(
        page=page,
        refs=opts.get("refs", {}),
        visited_urls=opts.get("visited_urls", set()),
        downloads=opts.get("downloads", []),
        tool_calls=opts.get("tool_calls", 0),
        consecutive_timeouts=opts.get("consecutive_timeouts", 0),
        keep_alive=opts.get("keep_alive", False),
        google_retry_count=opts.get("google_retry_count", 0),
        last_snapshot_url=opts.get("last_snapshot_url"),
        last_requested_url=opts.get("last_requested_url"),
        recovery_meta=opts.get("recovery_meta", {}),
        agent_history_steps=opts.get("agent_history_steps", []),
        console_messages=opts.get("console_messages", []),
        js_errors=opts.get("js_errors", []),
        human_session=opts.get("human_session"),
        behavior_persona=opts.get("behavior_persona"),
        navigate_abort=opts.get("navigate_abort"),
    )


# ---------------------------------------------------------------------------
# create_server_owned_tab
# ---------------------------------------------------------------------------


async def create_server_owned_tab(
    session: SessionState,
    *,
    user_id: str,
    session_key: str,
    url: str | None = None,
) -> dict:
    """Create a new tab in *session*.

    1. Creates a new Playwright ``Page`` on the session's context.
    2. Attaches the page to the tab group for *session_key*.
    3. Optionally navigates to *url*.
    4. Returns a dict with ``tab_id``, ``tab_state``, and ``page``.
    """
    uid = normalize_user_id(user_id)
    context = session.context
    if context is None:
        raise RuntimeError(f"Session for {uid} has no BrowserContext")

    page = await context.new_page()

    # Attach page event handlers
    _on_new_page(page)

    tab_id = make_tab_id()
    tab_state = create_tab_state(page)

    # Add to tab group
    group = get_tab_group(session, session_key)
    group[tab_id] = tab_state

    refresh_active_tabs(get_total_tab_count())

    plugin_events.emit(
        "tab:created",
        tab_id=tab_id,
        user_id=uid,
        session_key=session_key,
    )

    # Navigate if URL given
    if url:
        try:
            await asyncio.wait_for(
                page.goto(url, timeout=config.navigate_timeout_ms / 1000.0),
                timeout=config.navigate_timeout_ms / 1000.0 + 2.0,
            )
            tab_state.visited_urls.add(url)
        except Exception as exc:
            log.warning("Failed to navigate new tab to %s: %s", url, exc)

    return {
        "tab_id": tab_id,
        "tab_state": tab_state,
        "page": page,
    }


# ---------------------------------------------------------------------------
# fit_visible_window_to_vnc_display
# ---------------------------------------------------------------------------


async def fit_visible_window_to_vnc_display(
    page: Any,
    session: SessionState,
) -> dict | None:
    """If VNC display is active, resize the X11 window to match the viewport.

    On Linux with an active ``DISPLAY``, this uses ``xdotool`` or
    ``wmctrl`` to resize the browser window to the viewport dimensions.

    Returns a dict with ``{display, viewport}`` or ``None`` if not applicable.
    """
    display = session.display
    if not display:
        return None

    # Determine viewport from the page
    try:
        viewport_size = await page.evaluate(
            "({width: window.innerWidth, height: window.innerHeight})"
        )
    except Exception:
        viewport_size = {"width": 1280, "height": 720}

    width = viewport_size.get("width", 1280)
    height = viewport_size.get("height", 720)

    import os
    import subprocess
    import sys

    if sys.platform != "linux":
        return None

    try:
        # Try xdotool first
        subprocess.run(
            [
                "xdotool",
                "search",
                "--name",
                "Firefox",
                "windowmove",
                "0",
                "0",
                "windowsize",
                str(width),
                str(height),
            ],
            capture_output=True,
            timeout=5,
            env={**os.environ, "DISPLAY": display},
        )
    except FileNotFoundError:
        try:
            # Fall back to wmctrl
            subprocess.run(
                [
                    "wmctrl",
                    "-r",
                    ":ACTIVE:",
                    "-e",
                    f"0,0,0,{width},{height}",
                ],
                capture_output=True,
                timeout=5,
                env={**os.environ, "DISPLAY": display},
            )
        except Exception:
            pass
    except Exception:
        pass

    return {
        "display": display,
        "viewport": {"width": width, "height": height},
    }


# ---------------------------------------------------------------------------
# Error helpers  (exception -> bool)
# ---------------------------------------------------------------------------


def is_dead_context_error(err: Exception) -> bool:
    """Check if *err* is a dead context / browser error."""
    msg = str(err)
    return any(
        phrase in msg
        for phrase in [
            "Target page, context or browser has been closed",
            "browser has been closed",
            "Context closed",
            "Browser closed",
            "has been closed",
            "context was destroyed",
            "Execution context was destroyed",
        ]
    )


def is_timeout_error(err: Exception) -> bool:
    """Check if *err* is a timeout error."""
    msg = str(err)
    if isinstance(err, asyncio.TimeoutError):
        return True
    return "timed out after" in msg or ("Timeout" in msg and "exceeded" in msg)


def is_proxy_error(err: Exception) -> bool:
    """Check if *err* is proxy-related."""
    msg = str(err)
    return any(
        phrase in msg
        for phrase in [
            "NS_ERROR_PROXY",
            "proxy connection",
            "Proxy connection",
            "PROXY_CONNECTION",
        ]
    )


def is_tab_lock_queue_timeout(err: Exception) -> bool:
    """Check if *err* is a :class:`TabLockTimeoutError`."""
    return isinstance(err, TabLockTimeoutError)


def is_tab_destroyed_error(err: Exception) -> bool:
    """Check if *err* is a :class:`TabDestroyedError`."""
    return isinstance(err, TabDestroyedError)


# ---------------------------------------------------------------------------
# handle_route_error   (centralised error -> HTTP response)
# ---------------------------------------------------------------------------


async def handle_route_error(
    err: Exception,
    user_id: str | None = None,
    tab_id: str | None = None,
) -> tuple[int, dict]:
    """Map an exception to an HTTP status code and JSON body.

    Performs side-effects such as destroying sessions / tabs when needed.

    ========================= ====== ========================================
    Condition                 Status  Body
    ========================= ====== ========================================
    Dead context              500    ``{error, action, destroySession}``
    Proxy error + rotation    500    ``{error, action, destroySession}``
    Consecutive timeouts      408    ``{error, action, destroyTab}``
    Tab lock timeout          503    ``{error, action, destroyTab}``
    Tab destroyed             410    ``{error, action, gone}``
    Other                     500    ``{error, action, retry}``
    ========================= ====== ========================================
    """
    uid = normalize_user_id(user_id) if user_id else None
    error_str = str(err)

    # --- Dead context ---
    if is_dead_context_error(err):
        if uid and uid in sessions:
            destroy_session(uid)
        record_failure("dead_context", "handle_route_error").inc()
        return (
            500,
            {
                "error": error_str,
                "action": "destroySession",
                "destroySession": True,
            },
        )

    # --- Proxy error with session rotation ---
    if is_proxy_error(err):
        proxy_pool = _get_proxy_pool()
        can_rotate = proxy_pool is not None and getattr(proxy_pool, "canRotateSessions", False)
        if can_rotate:
            if uid and uid in sessions:
                destroy_session(uid)
            record_failure("proxy_error", "handle_route_error").inc()
            return (
                500,
                {
                    "error": error_str,
                    "action": "destroySession",
                    "destroySession": True,
                },
            )

    # --- Tab lock timeout ---
    if is_tab_lock_queue_timeout(err):
        if uid and tab_id:
            session = next((sess for sess in sessions.values() if find_tab(sess, tab_id) is not None), None)
            if session:
                await destroy_tab(session, tab_id, reason="tab_lock_timeout", user_id=uid)
        record_failure("tab_lock_timeout", "handle_route_error").inc()
        return (
            503,
            {
                "error": error_str,
                "action": "destroyTab",
                "destroyTab": True,
            },
        )

    # --- Tab destroyed ---
    if is_tab_destroyed_error(err):
        return (
            410,
            {
                "error": error_str,
                "action": "gone",
                "gone": True,
            },
        )

    # --- Fallback: generic error ---
    record_failure("unknown", "handle_route_error").inc()
    return (
        500,
        {
            "error": error_str,
            "action": "retry",
            "retry": True,
        },
    )
