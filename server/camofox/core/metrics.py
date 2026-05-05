"""Prometheus metrics for Managed Browser."""
from __future__ import annotations

from functools import partial

from prometheus_client import Counter, Gauge, Histogram

# Counters
failures_total = Counter(
    "camofox_failures_total",
    "Total failures by type and action",
    ["failure_type", "action"],
)

tabs_created_total = Counter(
    "camofox_tabs_created_total",
    "Total tabs created",
    ["user_id", "session_key"],
)

tabs_destroyed_total = Counter(
    "camofox_tabs_destroyed_total",
    "Total tabs destroyed by reason",
    ["reason"],
)

tabs_recycled_total = Counter(
    "camofox_tabs_recycled_total",
    "Total tabs recycled (limit reached)",
)

browser_restarts_total = Counter(
    "camofox_browser_restarts_total",
    "Total browser restarts by reason",
    ["reason"],
)

page_load_duration = Histogram(
    "camofox_page_load_duration_seconds",
    "Page load duration in seconds",
    ["action"],
    buckets=(0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 30.0, 60.0),
)

# Gauges
active_sessions = Gauge(
    "camofox_active_sessions",
    "Number of active browser sessions",
)

active_tabs = Gauge(
    "camofox_active_tabs",
    "Number of active tabs",
)

tab_lock_queue_depth = Gauge(
    "camofox_tab_lock_queue_depth",
    "Number of items in tab lock queues",
)

browser_instance_count = Gauge(
    "camofox_browser_instance_count",
    "Number of running browser instances",
)

# Convenience
record_failure = partial(failures_total.labels)
record_tab_destroyed = partial(tabs_destroyed_total.labels)


def refresh_active_sessions(count: int) -> None:
    active_sessions.set(count)


def refresh_active_tabs(count: int) -> None:
    active_tabs.set(count)


def refresh_tab_lock_queue_depth(count: int) -> None:
    tab_lock_queue_depth.set(count)
