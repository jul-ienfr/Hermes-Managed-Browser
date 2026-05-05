"""Plugin event bus — lightweight async pub/sub for internal events."""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Coroutine, Dict, List

logger = logging.getLogger("camofox.plugins")


class PluginEvents:
    """Async event emitter for plugin system.
    
    Mirrors the Node.js EventEmitter pattern with emitAsync support.
    Events: server:started, server:stopped, browser:launched, browser:closed,
            session:creating, session:created, session:destroying, session:destroyed,
            tab:created, tab:destroyed, tab:error, tab:recycled,
            vnc:watcher:started, vnc:watcher:stopped
    """

    def __init__(self):
        self._handlers: Dict[str, List[Callable[..., Coroutine]]] = {}

    def on(self, event: str, handler: Callable[..., Coroutine]) -> None:
        """Register an async event handler."""
        if event not in self._handlers:
            self._handlers[event] = []
        self._handlers[event].append(handler)

    def off(self, event: str, handler: Callable[..., Coroutine]) -> None:
        """Unregister an async event handler."""
        handlers = self._handlers.get(event, [])
        if handler in handlers:
            handlers.remove(handler)

    def emit(self, event: str, **kwargs) -> None:
        """Fire event synchronously (fire-and-forget coroutines)."""
        handlers = self._handlers.get(event, [])
        for handler in handlers:
            try:
                asyncio.ensure_future(handler(**kwargs))
            except Exception as e:
                logger.warning("Plugin event handler %s failed: %s", handler.__name__, e)

    async def emit_async(self, event: str, **kwargs) -> list:
        """Fire event and await all handlers."""
        handlers = self._handlers.get(event, [])
        results = []
        for handler in handlers:
            try:
                result = await handler(**kwargs)
                results.append(result)
            except Exception as e:
                logger.warning(
                    "Plugin async event handler %s failed for event %s: %s",
                    handler.__name__, event, e,
                )
                results.append(None)
        return results

    def remove_all(self, event: Optional[str] = None) -> None:
        """Remove all handlers for an event, or all events."""
        if event:
            self._handlers.pop(event, None)
        else:
            self._handlers.clear()


# Global singleton
plugin_events = PluginEvents()
