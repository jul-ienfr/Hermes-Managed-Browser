"""
Humanized browser actions — bezier curves, typo simulation, and human timing patterns.

Mirrors lib/human-actions.js from camofox-browser (Node.js).
All public functions work with a Playwright ``Page`` and implement mouse/keyboard
interactions that resist bot detection by simulating human behaviour.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from typing import Any, Callable, Optional

log = logging.getLogger("camofox.actions")

# ---------------------------------------------------------------------------
# Speed Profiles
# ---------------------------------------------------------------------------

SPEED_PROFILES: dict[str, dict[str, Any]] = {
    "fast": {
        "name": "fast",
        "speed": 1.25,
        "click": {
            "pause_before_down_ms": (25, 75),
            "hold_ms": (25, 70),
            "pause_after_ms": (50, 130),
        },
        "typing": {
            "keystroke_delay_ms": (12, 65),
            "word_pause_ms": (25, 90),
            "correction_pause_ms": (60, 160),
        },
        "scroll": {
            "steps": (2, 5),
            "step_pause_ms": (10, 35),
            "pause_after_ms": (45, 120),
        },
    },
    "medium": {
        "name": "medium",
        "speed": 1.0,
        "click": {
            "pause_before_down_ms": (90, 220),
            "hold_ms": (55, 150),
            "pause_after_ms": (180, 420),
        },
        "typing": {
            "keystroke_delay_ms": (40, 220),
            "word_pause_ms": (80, 260),
            "correction_pause_ms": (160, 420),
        },
        "scroll": {
            "steps": (4, 9),
            "step_pause_ms": (30, 90),
            "pause_after_ms": (140, 360),
        },
    },
    "slow": {
        "name": "slow",
        "speed": 0.7,
        "click": {
            "pause_before_down_ms": (140, 360),
            "hold_ms": (70, 190),
            "pause_after_ms": (260, 700),
        },
        "typing": {
            "keystroke_delay_ms": (65, 320),
            "word_pause_ms": (140, 420),
            "correction_pause_ms": (240, 700),
        },
        "scroll": {
            "steps": (5, 12),
            "step_pause_ms": (45, 130),
            "pause_after_ms": (220, 600),
        },
    },
}

# ---------------------------------------------------------------------------
# Adjacent-key typo map (QWERTY)
# ---------------------------------------------------------------------------

_ADJACENT_KEYS: dict[str, str] = {
    "q": "wa",
    "w": "qeas",
    "e": "rdsw",
    "r": "etdf",
    "t": "ryfg",
    "y": "tugh",
    "u": "yijh",
    "i": "uokj",
    "o": "iplk",
    "p": "ol",
    "a": "qszw",
    "s": "awedxz",
    "d": "serfcx",
    "f": "drtgvc",
    "g": "ftyhbv",
    "h": "gyujnb",
    "j": "huikmn",
    "k": "jiolm",
    "l": "kop",
    "z": "asx",
    "x": "zsdc",
    "c": "xdfv",
    "v": "cfgb",
    "b": "vghn",
    "n": "bhjm",
    "m": "njk",
    "0": "9",
    "1": "2q",
    "2": "13w",
    "3": "24e",
    "4": "35r",
    "5": "46t",
    "6": "57y",
    "7": "68u",
    "8": "79i",
    "9": "80o",
}

_SENSITIVE_INPUT_KINDS: set[str] = {
    "password",
    "email",
    "tel",
    "otp",
    "code",
    "url",
    "number",
}

_ALPHA = "abcdefghijklmnopqrstuvwxyz"
_DIGITS = "0123456789"

# ---------------------------------------------------------------------------
# Seeded PRNG
# ---------------------------------------------------------------------------


def create_seeded_random(seed: Optional[str] = None) -> Callable[[], float]:
    """Deterministic PRNG (mulberry32) for repeatable human behaviour.

    Accepts an optional string *seed*; falls back to an integer hash of
    ``time.monotonic_ns()`` when *seed* is ``None``.
    """
    if seed is not None:
        # Simple hash of the string to an unsigned 32-bit integer
        state = 0
        for ch in str(seed):
            state = ((state << 5) - state) + ord(ch)
            state = state & 0xFFFFFFFF
    else:
        state = time.monotonic_ns() & 0xFFFFFFFF

    def _rng() -> float:
        nonlocal state
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        return state / 0x100000000  # 2**32

    return _rng


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _default_rng() -> float:
    """The default PRNG — Python's built-in ``random.random``."""
    return random.random()


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _rand(rng: Callable[[], float], lo: float, hi: float) -> float:
    return lo + (hi - lo) * rng()


def _rand_int(rng: Callable[[], float], lo: float, hi: float) -> int:
    return int(math.floor(_rand(rng, lo, hi + 1)))


def _gaussian(rng: Callable[[], float]) -> float:
    """Box-Muller transform."""
    u = 0.0
    v = 0.0
    while u == 0.0:
        u = rng()
    while v == 0.0:
        v = rng()
    return math.sqrt(-2.0 * math.log(u)) * math.cos(2.0 * math.pi * v)


def _jitter(value: float, percent: float, rng: Callable[[], float]) -> float:
    return max(0.0, value + _gaussian(rng) * value * percent)


def _range_delay(
    rng: Callable[[], float],
    range_: tuple[float, float],
    *,
    jitter_percent: float = 0.15,
) -> int:
    """Sample a delay (ms) from a gaussian-ish distribution bounded by *range_*."""
    lo, hi = range_
    mean = (lo + hi) / 2.0
    sigma = max(1.0, (hi - lo) / 4.0)
    sampled = _clamp(mean + _gaussian(rng) * sigma, lo, hi)
    return round(_clamp(_jitter(sampled, jitter_percent, rng), lo, hi))


def _ease_in_out_cubic(t: float) -> float:
    if t < 0.5:
        return 4.0 * t * t * t
    return 1.0 - math.pow(-2.0 * t + 2.0, 3.0) / 2.0


def _bezier(
    p0: tuple[float, float],
    p1: tuple[float, float],
    p2: tuple[float, float],
    p3: tuple[float, float],
    t: float,
) -> tuple[float, float]:
    mt = 1.0 - t
    mt2 = mt * mt
    mt3 = mt2 * mt
    t2 = t * t
    t3 = t2 * t
    x = mt3 * p0[0] + 3.0 * mt2 * t * p1[0] + 3.0 * mt * t2 * p2[0] + t3 * p3[0]
    y = mt3 * p0[1] + 3.0 * mt2 * t * p1[1] + 3.0 * mt * t2 * p2[1] + t3 * p3[1]
    return (x, y)


# ---------------------------------------------------------------------------
# Profile lookup
# ---------------------------------------------------------------------------


def get_human_profile(name: str = "medium") -> dict[str, Any]:
    """Return the speed profile dict for *name* (default ``"medium"``).

    Falls back to ``"fast"`` for unknown names.
    """
    return SPEED_PROFILES.get(name, SPEED_PROFILES["fast"])


# ---------------------------------------------------------------------------
# Human pause
# ---------------------------------------------------------------------------


async def human_pause(
    page,
    min_ms: int,
    max_ms: int,
    *,
    rng: Optional[Callable[[], float]] = None,
    timeout_ms: Optional[int] = None,
) -> int:
    """Pause for a random duration in [*min_ms*, *max_ms*] milliseconds.

    Uses the page's ``waitForTimeout`` when available, falling back to
    ``asyncio.sleep``.

    Returns the actual delay that was waited.
    """
    rng = rng or _default_rng
    delay = _range_delay(rng, (float(min_ms), float(max_ms)), jitter_percent=0.15)
    if hasattr(page, "wait_for_timeout"):
        guard_ms = max(delay + 250, timeout_ms or 1000)
        try:
            await asyncio.wait_for(
                page.wait_for_timeout(delay), timeout=guard_ms / 1000.0
            )
        except (asyncio.TimeoutError, Exception):
            pass
    else:
        await asyncio.sleep(delay / 1000.0)
    return delay


# ---------------------------------------------------------------------------
# Bezier motion planning
# ---------------------------------------------------------------------------


def _human_path(
    from_: tuple[float, float],
    to: tuple[float, float],
    steps: int,
    rng: Callable[[], float],
    randomness: float = 0.22,
) -> list[tuple[float, float]]:
    dx = to[0] - from_[0]
    dy = to[1] - from_[1]
    distance = math.hypot(dx, dy) or 1
    perp = (-dy / distance, dx / distance)
    p1_offset = _rand(rng, 0.2, 0.4)
    p2_offset = _rand(rng, 0.6, 0.8)
    dev1 = distance * randomness * _rand(rng, -1, 1)
    dev2 = distance * randomness * _rand(rng, -1, 1)
    p1 = (from_[0] + dx * p1_offset + perp[0] * dev1, from_[1] + dy * p1_offset + perp[1] * dev1)
    p2 = (from_[0] + dx * p2_offset + perp[0] * dev2, from_[1] + dy * p2_offset + perp[1] * dev2)
    path: list[tuple[float, float]] = []
    for i in range(1, steps + 1):
        t = _ease_in_out_cubic(i / steps)
        pt = _bezier(from_, p1, p2, to, t)
        path.append((pt[0] + _gaussian(rng) * 0.5, pt[1] + _gaussian(rng) * 0.5))
    return path


def _overshoot_point(
    from_: tuple[float, float],
    to: tuple[float, float],
    rng: Callable[[], float],
) -> tuple[float, float]:
    dx = to[0] - from_[0]
    dy = to[1] - from_[1]
    factor = _rand(rng, 0.03, 0.08)
    return (to[0] + dx * factor, to[1] + dy * factor)


def _clamp_point_to_viewport(
    point: tuple[float, float],
    viewport: Optional[dict[str, int]] = None,
    *,
    edge_padding: float = 0,
) -> tuple[float, float]:
    if viewport is None:
        return point
    max_x = max(edge_padding, viewport.get("width", 1280) - 1)
    max_y = max(edge_padding, viewport.get("height", 720) - 1)
    return (
        _clamp(point[0], edge_padding, max_x),
        _clamp(point[1], edge_padding, max_y),
    )


def _plan_human_motion(
    *,
    from_: tuple[float, float] = (0, 0),
    to: tuple[float, float],
    profile: str = "fast",
    rng: Callable[[], float] = _default_rng,
    steps: Optional[int] = None,
    duration_ms: Optional[float] = None,
    overshoot_chance: float = 0.0,
    viewport: Optional[dict[str, int]] = None,
    motion_jitter: Optional[float] = None,
    slight_miss_chance: float = 0.0,
    target_box: Optional[dict[str, float]] = None,
) -> dict[str, Any]:
    """Build a motion plan (list of intermediate waypoints) for a mouse move.

    Returns a dict with keys: ``points``, ``final_point``, ``duration_ms``,
    ``interval_ms``, ``steps``, ``overshot``, ``missed``, ``care_factor``.
    """
    prof = get_human_profile(profile)
    bounded_to = _clamp_point_to_viewport(to, viewport, edge_padding=1)
    bounded_from = _clamp_point_to_viewport(from_, viewport, edge_padding=1)
    distance = math.hypot(bounded_to[0] - bounded_from[0], bounded_to[1] - bounded_from[1])

    target_care_factor = 1.0
    if target_box is not None:
        target_care_factor = choose_human_target_point(target_box, rng=rng)[1]

    should_overshoot = distance > 120 and rng() < overshoot_chance

    if duration_ms is None:
        raw_duration = 120 + distance * 1.7
        jittered = _jitter(raw_duration, 0.2, rng)
        actual_duration = round(
            _clamp(jittered * target_care_factor / prof["speed"], 80, 3500)
        )
    else:
        actual_duration = round(duration_ms)

    randomness = 0.22
    if motion_jitter is not None and math.isfinite(motion_jitter):
        randomness = _clamp(motion_jitter, 0.03, 0.5)

    all_paths: list[tuple[float, float]] = []
    missed = False

    if should_overshoot:
        overshoot = _overshoot_point(bounded_from, bounded_to, rng)
        overshoot = _clamp_point_to_viewport(overshoot, viewport, edge_padding=1)
        overshoot_distance = math.hypot(overshoot[0] - bounded_from[0], overshoot[1] - bounded_from[1])
        correction_distance = math.hypot(bounded_to[0] - overshoot[0], bounded_to[1] - overshoot[1])
        main_steps = steps or _clamp(round(overshoot_distance / 10), 10, 100)
        correction_steps = _clamp(round(correction_distance / 4), 3, 12)
        all_paths.extend(_human_path(bounded_from, overshoot, main_steps, rng, randomness))
        all_paths.extend(_human_path(overshoot, bounded_to, correction_steps, rng, 0.08))
    elif distance > 180 and rng() < slight_miss_chance:
        missed = True
        miss = (
            bounded_to[0] + _rand(rng, -10, 10),
            bounded_to[1] + _rand(rng, -8, 8),
        )
        miss = _clamp_point_to_viewport(miss, viewport, edge_padding=1)
        miss_steps = steps or _clamp(round(distance / 10), 10, 100)
        all_paths.extend(_human_path(bounded_from, miss, miss_steps, rng, randomness))
        correction_dist = math.hypot(bounded_to[0] - miss[0], bounded_to[1] - miss[1])
        correction_steps = _clamp(round(correction_dist / 3), 3, 10)
        all_paths.extend(_human_path(miss, bounded_to, correction_steps, rng, 0.06))
    else:
        actual_steps = steps or _clamp(round(distance / 10), 10, 100)
        all_paths.extend(_human_path(bounded_from, bounded_to, actual_steps, rng, randomness))

    bounded_points = [
        _clamp_point_to_viewport(p, viewport, edge_padding=1) for p in all_paths
    ]
    bounded_points.append(bounded_to)

    interval = max(8, round(actual_duration / max(1, len(bounded_points))))

    return {
        "points": bounded_points,
        "final_point": bounded_to,
        "duration_ms": actual_duration,
        "interval_ms": interval,
        "steps": len(bounded_points),
        "overshot": should_overshoot,
        "missed": missed,
        "care_factor": target_care_factor,
    }


# ---------------------------------------------------------------------------
# Target point selection
# ---------------------------------------------------------------------------


def choose_human_target_point(
    box: dict[str, float],
    *,
    rng: Optional[Callable[[], float]] = None,
) -> tuple[tuple[float, float], float]:
    """Pick a random point within *box* and return ``(point, care_factor)``.

    *box* should have keys ``x``, ``y``, ``width``, ``height`` (bounding box).

    The point is chosen from a centred region (about 80 % of the element) so
    that clicks rarely land on the very edge of the target.
    """
    if not box:
        raise ValueError("choose_human_target_point requires a box")
    rng = rng or _default_rng
    min_dimension = max(1, min(float(box["width"]) or 1, float(box["height"]) or 1))
    care_factor = _clamp(1 + (44 - min(44, min_dimension)) / 44, 1, 2)
    margin_x = min(
        max(2, box["width"] * 0.2 * care_factor),
        max(2, box["width"] / 2 - 1),
    )
    margin_y = min(
        max(2, box["height"] * 0.2 * care_factor),
        max(2, box["height"] / 2 - 1),
    )
    min_x = box["x"] + margin_x
    max_x = box["x"] + max(margin_x, box["width"] - margin_x)
    min_y = box["y"] + margin_y
    max_y = box["y"] + max(margin_y, box["height"] - margin_y)
    point = (
        _rand(rng, min(min_x, max_x), max(min_x, max_x)),
        _rand(rng, min(min_y, max_y), max(min_y, max_y)),
    )
    return point, care_factor


# ---------------------------------------------------------------------------
# Settle jitter (micro-moves after reaching target)
# ---------------------------------------------------------------------------


async def _human_settle(
    page,
    position: tuple[float, float],
    *,
    rng: Optional[Callable[[], float]] = None,
    enabled: bool = False,
    moves: Optional[int] = None,
) -> dict[str, Any]:
    """Perform 1-3 micro-moves around *position* after arriving at a target."""
    if not enabled:
        return {"position": position, "moves": 0}
    rng = rng or _default_rng
    move_count = _clamp(round(moves or _rand_int(rng, 1, 3)), 1, 3)
    for i in range(move_count):
        is_final = i == move_count - 1
        radius = 0.0 if is_final else _rand(rng, 1, 3)
        angle = _rand(rng, 0, math.pi * 2)
        if is_final:
            pt = position
        else:
            pt = (position[0] + math.cos(angle) * radius, position[1] + math.sin(angle) * radius)
        try:
            await page.mouse.move(pt[0], pt[1])
        except Exception:
            pass
        if not is_final and hasattr(page, "wait_for_timeout"):
            pause = _range_delay(rng, (6, 18), jitter_percent=0.1)
            try:
                await page.wait_for_timeout(pause)
            except Exception:
                await asyncio.sleep(pause / 1000.0)
    return {"position": position, "moves": move_count}


# ---------------------------------------------------------------------------
# Mouse move execution helpers
# ---------------------------------------------------------------------------


async def _bounded_mouse_move(
    page, x: float, y: float, timeout: float = 1000
) -> None:
    """Move the mouse to *(x, y)* with a soft timeout.

    Raises ``TimeoutError`` if the move does not complete within *timeout* ms.
    """
    timeout_s = max(500, timeout) / 1000.0
    try:
        await asyncio.wait_for(page.mouse.move(x, y, steps=1), timeout=timeout_s)
    except asyncio.TimeoutError:
        err = TimeoutError("mouse move soft timeout")
        err.code = "mouse_move_soft_timeout"  # type: ignore[attr-defined]
        raise err


async def _play_mouse_path(
    page,
    path: list[tuple[float, float]],
    interval: int,
    rng: Callable[[], float],
    *,
    move_timeout: float = 1000,
    viewport: Optional[dict[str, int]] = None,
    max_skipped_moves: int = 1,
) -> None:
    """Walk through a list of waypoints with human-like pauses."""
    skipped = 0
    for raw_pt in path:
        pt = _clamp_point_to_viewport(raw_pt, viewport)
        try:
            await _bounded_mouse_move(page, pt[0], pt[1], move_timeout)
            skipped = 0
        except TimeoutError as exc:
            if getattr(exc, "code", None) != "mouse_move_soft_timeout":
                raise
            skipped += 1
            if skipped >= max_skipped_moves:
                break
        pause_ms = _range_delay(
            rng,
            (max(5, interval * 0.7), interval * 1.3),
            jitter_percent=0.25,
        )
        if hasattr(page, "wait_for_timeout"):
            try:
                await page.wait_for_timeout(pause_ms)
            except Exception:
                await asyncio.sleep(pause_ms / 1000.0)
        else:
            await asyncio.sleep(pause_ms / 1000.0)


# ---------------------------------------------------------------------------
# Scroll planning
# ---------------------------------------------------------------------------


def _plan_human_scroll(
    *,
    rng: Callable[[], float] = _default_rng,
    profile: str = "fast",
    direction: str = "down",
    amount: Optional[float] = None,
    bursty: bool = True,
    inverse_correction_chance: float = 0.08,
) -> dict[str, Any]:
    """Build a scroll plan (list of wheel deltas).

    Returns a dict with keys: ``direction``, ``amount``, ``bursty``,
    ``inverse_correction``, ``events`` (each event has ``delta_x``,
    ``delta_y``, ``pause_range_ms``).
    """
    prof = get_human_profile(profile)
    sign = -1 if direction in ("up", "left") else 1
    vertical = direction in ("up", "down")
    total_amount = abs(amount) if amount is not None else _rand_int(rng, 180, 520)
    total = total_amount * sign

    wheel_deltas: list[float] = []

    if bursty:
        burst_count = _rand_int(rng, float(prof["scroll"]["steps"][0]), float(prof["scroll"]["steps"][1]))
        weights = [_rand(rng, 0.45, 1.65) for _ in range(burst_count)]
        total_weight = sum(weights) or 1
        sent = 0.0
        for burst_idx in range(burst_count):
            if burst_idx == burst_count - 1:
                burst_target = total - sent
            else:
                burst_target = total * (weights[burst_idx] / total_weight)
            events_in_burst = _rand_int(rng, 1, 4)
            burst_sent = 0.0
            for ev_idx in range(events_in_burst):
                remaining = burst_target - burst_sent
                if ev_idx == events_in_burst - 1:
                    delta = remaining
                else:
                    base = remaining / (events_in_burst - ev_idx)
                    delta = _jitter(base, 0.35, rng)
                burst_sent += delta
                sent += delta
                wheel_deltas.append(delta)
    else:
        step_count = _rand_int(rng, float(prof["scroll"]["steps"][0]), float(prof["scroll"]["steps"][1]))
        sent = 0.0
        for i in range(step_count):
            remaining = total - sent
            if i == step_count - 1:
                delta = remaining
            else:
                base = remaining / (step_count - i)
                delta = _jitter(base, 0.2, rng)
            sent += delta
            wheel_deltas.append(delta)

    inverse_correction = False
    if total_amount >= 150 and rng() < inverse_correction_chance:
        inverse_correction = True
        correction = -sign * _rand(rng, min(12, total_amount * 0.03), min(45, total_amount * 0.12))
        wheel_deltas.append(correction)

    events = [
        {
            "delta_x": 0.0 if vertical else delta,
            "delta_y": delta if vertical else 0.0,
            "pause_range_ms": prof["scroll"]["step_pause_ms"],
            "index": idx,
        }
        for idx, delta in enumerate(wheel_deltas)
    ]

    return {
        "direction": direction,
        "amount": total_amount,
        "bursty": bursty,
        "inverse_correction": inverse_correction,
        "events": events,
    }


# ---------------------------------------------------------------------------
# Public functions
# ---------------------------------------------------------------------------


async def human_prepare_target(
    page,
    locator,
    *,
    rng: Optional[Callable[[], float]] = None,
    timeout: float = 10000,
    box_timeout: float = 1000,
    prefer_bounding_box: bool = False,
    allow_bounding_box_fallback: bool = True,
    scroll_timeout: float = 3000,
    after_scroll_pause_ms: int = 120,
    skip_comfort_scroll: bool = False,
    profile: str = "fast",
    viewport: Optional[dict[str, int]] = None,
    skip_reading_pause: bool = False,
    reading_pause_ms: Optional[tuple[int, int]] = None,
    behavior_persona: Optional[dict[str, Any]] = None,
) -> Optional[dict[str, Any]]:
    """Scroll the page if the target is outside the comfortable viewport band
    (20-80 %), then return the element's bounding box.

    Returns ``{"ok": True, "box": {x, y, width, height}}`` or ``None`` if
    the element cannot be found.
    """
    rng = rng or _default_rng

    async def _bounding_box_with_timeout(loc, tmo: float):
        try:
            return await asyncio.wait_for(loc.bounding_box(), timeout=tmo / 1000.0)
        except asyncio.TimeoutError:
            return None

    initial_box = None
    if prefer_bounding_box:
        initial_box = await _bounding_box_with_timeout(locator, box_timeout)
        if initial_box is None and not allow_bounding_box_fallback:
            return None

    if initial_box is None:
        try:
            await asyncio.wait_for(
                locator.wait_for(state="visible"), timeout=timeout / 1000.0
            )
        except (asyncio.TimeoutError, Exception) as exc:
            if not allow_bounding_box_fallback:
                return None
            fallback_box = await _bounding_box_with_timeout(locator, box_timeout)
            if fallback_box is None:
                return None
            initial_box = fallback_box

    box = initial_box or await _bounding_box_with_timeout(locator, box_timeout)
    if box is None:
        try:
            await locator.scroll_into_view_if_needed(timeout=scroll_timeout / 1000.0)
        except Exception:
            pass
        await human_pause(page, after_scroll_pause_ms, after_scroll_pause_ms, rng=rng)
        box = await _bounding_box_with_timeout(locator, box_timeout)
    if box is None:
        return None

    resolved_viewport = viewport
    if resolved_viewport is None and hasattr(page, "viewport_size"):
        resolved_viewport = page.viewport_size
    if resolved_viewport is None:
        resolved_viewport = {"width": 1280, "height": 720}

    center_y = box["y"] + box["height"] / 2
    comfortable_top = resolved_viewport["height"] * 0.20
    comfortable_bottom = resolved_viewport["height"] * 0.80

    if not skip_comfort_scroll and (center_y < comfortable_top or center_y > comfortable_bottom):
        delta = center_y - resolved_viewport["height"] * 0.5
        await human_scroll(
            page,
            direction="down" if delta > 0 else "up",
            amount=abs(delta),
            rng=rng,
            profile=profile,
        )
        await human_pause(page, after_scroll_pause_ms, after_scroll_pause_ms, rng=rng)
        box = await _bounding_box_with_timeout(locator, box_timeout)
        if box is None:
            return None

    reading_speed = 1.0
    if behavior_persona:
        reading_speed = float(behavior_persona.get("reading_speed", 1.0))
    if skip_reading_pause:
        rp = (0, 0)
    elif reading_pause_ms is not None:
        rp = reading_pause_ms
    else:
        rp = (round(40 / reading_speed), round(140 / reading_speed))
    await human_pause(page, rp[0], rp[1], rng=rng)

    return {"ok": True, "box": box}


async def human_move(
    page,
    target_x: float,
    target_y: float,
    *,
    from_: Optional[tuple[float, float]] = None,
    profile: str = "fast",
    rng: Optional[Callable[[], float]] = None,
    steps: Optional[int] = None,
    duration_ms: Optional[float] = None,
    overshoot_chance: float = 0.08,
    move_timeout: float = 1000,
    viewport: Optional[dict[str, int]] = None,
    motion_jitter: Optional[float] = None,
    slight_miss_chance: float = 0.0,
    target_box: Optional[dict[str, float]] = None,
) -> dict[str, Any]:
    """Move the mouse to *(target_x, target_y)* using a bezier-curved path
    with cubic easing.

    Returns a dict with keys: ``position``, ``steps``, ``duration_ms``,
    ``overshot``, ``missed``, ``care_factor``.
    """
    rng = rng or _default_rng
    resolved_viewport = viewport
    if resolved_viewport is None and hasattr(page, "viewport_size"):
        resolved_viewport = page.viewport_size

    from_pos = from_ or (0, 0)
    plan = _plan_human_motion(
        from_=from_pos,
        to=(target_x, target_y),
        profile=profile,
        rng=rng,
        steps=steps,
        duration_ms=duration_ms,
        overshoot_chance=overshoot_chance,
        viewport=resolved_viewport,
        motion_jitter=motion_jitter,
        slight_miss_chance=slight_miss_chance,
        target_box=target_box,
    )

    await _play_mouse_path(
        page,
        plan["points"],
        plan["interval_ms"],
        rng,
        move_timeout=move_timeout,
        viewport=resolved_viewport,
    )
    final_pt = plan["final_point"]
    await _bounded_mouse_move(page, final_pt[0], final_pt[1], move_timeout)
    settle_pause = _range_delay(
        rng,
        (max(5, plan["interval_ms"] * 0.7), plan["interval_ms"] * 1.3),
        jitter_percent=0.25,
    )
    if hasattr(page, "wait_for_timeout"):
        try:
            await page.wait_for_timeout(settle_pause)
        except Exception:
            await asyncio.sleep(settle_pause / 1000.0)
    else:
        await asyncio.sleep(settle_pause / 1000.0)

    return {
        "position": final_pt,
        "steps": plan["steps"] + 1,
        "duration_ms": plan["duration_ms"],
        "overshot": plan["overshot"],
        "missed": plan["missed"],
        "care_factor": plan["care_factor"],
    }


async def human_click(
    page,
    ref_or_selector: str,
    *,
    from_: Optional[dict[str, float]] = None,
    profile: str = "fast",
    rng: Optional[Callable[[], float]] = None,
    timeout: float = 10000,
    box_timeout: Optional[float] = None,
    move_timeout: float = 1000,
    mouse_timeout: float = 2000,
    overshoot_chance: float = 0.0,
    settle_jitter: bool = False,
    settle_moves: Optional[int] = None,
    viewport: Optional[dict[str, int]] = None,
    locator_click_timeout: float = 3000,
    focus_timeout: float = 1000,
    allow_keyboard_activate_fallback: bool = True,
    allow_locator_click_fallback: bool = True,
    **kwargs: Any,
) -> dict[str, Any]:
    """Perform a complete human-like click sequence on the element identified
    by *ref_or_selector* (CSS selector string).

    Steps:
        1. :func:`human_prepare_target` — scroll into view if needed.
        2. Get the element's bounding box.
        3. Choose a target point within the element.
        4. :func:`human_move` to the target.
        5. Small settle pause (optional jitter).
        6. ``mousedown`` → pause → ``mouseup``.

    Fallback chain: human move+click → ``page.locator(sel).click()`` →
    ``page.keyboard.press('Enter')``.

    Returns a dict with keys: ``ok``, ``position``, ``cursor``, ``move``,
    ``settle``, and optionally ``fallback``.
    """
    rng = rng or _default_rng
    prof = get_human_profile(profile)

    if box_timeout is None:
        box_timeout = min(1000, max(100, timeout))

    locator = page.locator(ref_or_selector)

    async def _locator_click_fallback(err: Exception) -> dict[str, Any]:
        """Fallback chain: locator.click → keyboard.Enter."""
        fallback = "locator.click"
        fallback_error = err
        try:
            await locator.click(timeout=min(locator_click_timeout, max(100, timeout)))
        except Exception as click_err:
            fallback_error = click_err
            if not allow_keyboard_activate_fallback:
                raise
            fallback = "keyboard.activate"
            await locator.focus(timeout=min(focus_timeout, max(100, timeout)) / 1000.0)
            await human_pause(page, 15, 45, rng=rng, timeout_ms=250)
            await page.keyboard.press("Enter")
        cursor = from_ or {"x": 0, "y": 0}
        return {
            "ok": True,
            "position": (cursor["x"], cursor["y"]),
            "cursor": cursor,
            "move": {
                "position": (cursor["x"], cursor["y"]),
                "steps": 0,
                "duration_ms": 0,
                "fallback": fallback,
                "error": str(fallback_error),
            },
            "settle": {"position": (cursor["x"], cursor["y"]), "moves": 0},
            "fallback": fallback,
        }

    # ---- 1. Prepare target ----
    prep = await human_prepare_target(
        page,
        locator,
        rng=rng,
        timeout=timeout,
        box_timeout=box_timeout,
        profile=profile,
        viewport=viewport,
        prefer_bounding_box=True,
        allow_bounding_box_fallback=True,
    )
    if prep is None:
        return await _locator_click_fallback(
            Exception("Element not visible (no bounding box)")
        )
    box = prep["box"]

    # ---- 2. Target point ----
    target_pt, _ = choose_human_target_point(box, rng=rng)

    # ---- 3. Move ----
    try:
        move_result = await human_move(
            page,
            target_pt[0],
            target_pt[1],
            from_=from_ or (0, 0),
            profile=profile,
            rng=rng,
            overshoot_chance=overshoot_chance,
            move_timeout=move_timeout,
            viewport=viewport,
        )
    except TimeoutError as exc:
        if getattr(exc, "code", None) == "mouse_move_soft_timeout" and allow_locator_click_fallback:
            return await _locator_click_fallback(exc)
        raise

    # ---- 4. Settle jitter ----
    settle_result = await _human_settle(
        page,
        target_pt,
        rng=rng,
        enabled=settle_jitter,
        moves=settle_moves,
    )

    # ---- 5. Click ----
    await human_pause(page, prof["click"]["pause_before_down_ms"][0], prof["click"]["pause_before_down_ms"][1], rng=rng)
    await _bounded_action(page, page.mouse.down, mouse_timeout)
    await human_pause(page, prof["click"]["hold_ms"][0], prof["click"]["hold_ms"][1], rng=rng)
    await _bounded_action(page, page.mouse.up, mouse_timeout)
    await human_pause(page, prof["click"]["pause_after_ms"][0], prof["click"]["pause_after_ms"][1], rng=rng)

    return {
        "ok": True,
        "position": target_pt,
        "cursor": target_pt,
        "move": move_result,
        "settle": settle_result,
    }


async def _bounded_action(page, action, timeout_ms: float) -> None:
    """Execute a mouse action with a soft timeout."""
    timeout_s = max(100, timeout_ms) / 1000.0
    try:
        await asyncio.wait_for(action(), timeout=timeout_s)
    except asyncio.TimeoutError:
        raise TimeoutError(f"mouse action timed out after {timeout_ms}ms")


# ---------------------------------------------------------------------------
# Typing helpers
# ---------------------------------------------------------------------------


def _typo_for(char: str, rng: Callable[[], float]) -> str:
    """Return a plausible typo replacement for *char*."""
    lower = char.lower()
    adjacent = _ADJACENT_KEYS.get(lower)
    if adjacent:
        return adjacent[_rand_int(rng, 0, len(adjacent) - 1)]
    if len(char) == 1 and char.isalpha():
        return _ALPHA[_rand_int(rng, 0, 25)]
    if char.isdigit():
        return _DIGITS[_rand_int(rng, 0, 9)]
    return char


def effective_mistakes_rate(
    *,
    input_kind: Optional[str] = None,
    mistakes_rate: Optional[float] = None,
) -> float:
    """Return the effective typo rate for a given input kind.

    Returns 0 for sensitive fields (password, email, otp, code, etc.).
    """
    if input_kind and input_kind.lower() in _SENSITIVE_INPUT_KINDS:
        return 0.0
    rate = mistakes_rate if mistakes_rate is not None else 0.02
    if not math.isfinite(rate):
        return 0.0
    return _clamp(rate, 0.0, 1.0)


async def human_type(
    page,
    ref_or_selector: str,
    text: str,
    *,
    profile: str = "fast",
    rng: Optional[Callable[[], float]] = None,
    timeout: float = 10000,
    clear_first: bool = True,
    input_kind: Optional[str] = None,
    mistakes_rate: Optional[float] = None,
    allow_dom_focus_fallback: bool = True,
    **kwargs: Any,
) -> dict[str, Any]:
    """Type *text* into the element identified by *ref_or_selector* (CSS
    selector) with human-like delays and optional typos.

    * ``clear_first=True`` (default) → ``Ctrl+A`` + ``Backspace`` to clear.
    * 2 % chance of a typo per printable character (0 % for password/email/otp/code fields).
    * Typos are corrected: type wrong char → pause → Backspace → type correct.

    Returns ``{"ok": True, "chars": len(text)}``.
    """
    rng = rng or _default_rng
    prof = get_human_profile(profile)
    effective_rate = effective_mistakes_rate(
        input_kind=input_kind, mistakes_rate=mistakes_rate
    )

    locator = page.locator(ref_or_selector)

    # Focus the element
    try:
        await asyncio.wait_for(locator.focus(), timeout=timeout / 1000.0)
    except Exception:
        if not allow_dom_focus_fallback:
            raise
        try:
            await locator.evaluate("(el) => el.focus()")
        except Exception:
            pass

    await human_pause(page, 60, 160, rng=rng)

    # Clear field
    if clear_first:
        await page.keyboard.press("Control+A")
        await human_pause(page, 40, 110, rng=rng)
        await page.keyboard.press("Backspace")
        await human_pause(page, 70, 170, rng=rng)

    # Type each character
    for char in text:
        keystroke_delay = _range_delay(rng, prof["typing"]["keystroke_delay_ms"])
        if len(char) == 1 and (char.isalpha() or char.isdigit()) and rng() < effective_rate:
            # Typo!
            typo_char = _typo_for(char, rng)
            await page.keyboard.type(typo_char, delay=keystroke_delay)
            await human_pause(
                page,
                prof["typing"]["correction_pause_ms"][0],
                prof["typing"]["correction_pause_ms"][1],
                rng=rng,
            )
            await page.keyboard.press("Backspace")
            await human_pause(page, 50, 130, rng=rng)
        # Type the intended character (always)
        await page.keyboard.type(char, delay=keystroke_delay)
        if char == " ":
            await human_pause(
                page,
                prof["typing"]["word_pause_ms"][0],
                prof["typing"]["word_pause_ms"][1],
                rng=rng,
            )

    return {"ok": True, "chars": len(text)}


async def human_press(
    page,
    key: str,
    *,
    rng: Optional[Callable[[], float]] = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Press a keyboard key with human-like timing.

    Returns ``{"ok": True, "key": key}``.
    """
    rng = rng or _default_rng
    await human_pause(page, 60, 180, rng=rng)
    await page.keyboard.press(key)
    await human_pause(page, 80, 260, rng=rng)
    return {"ok": True, "key": key}


async def human_scroll(
    page,
    *,
    rng: Optional[Callable[[], float]] = None,
    profile: str = "fast",
    direction: str = "down",
    amount: Optional[float] = None,
    bursty: bool = True,
    inverse_correction_chance: float = 0.08,
    **kwargs: Any,
) -> dict[str, Any]:
    """Simulate human scroll with bursty wheel events.

    *direction*: ``"down"`` (default) or ``"up"``.

    Returns a dict with keys: ``ok``, ``direction``, ``amount``, ``steps``,
    ``bursty``, ``inverse_correction``.
    """
    rng = rng or _default_rng
    prof = get_human_profile(profile)
    plan = _plan_human_scroll(
        rng=rng,
        profile=profile,
        direction=direction,
        amount=amount,
        bursty=bursty,
        inverse_correction_chance=inverse_correction_chance,
    )

    for event in plan["events"]:
        await page.mouse.wheel(event["delta_x"], event["delta_y"])
        pause_range = event["pause_range_ms"]
        await human_pause(page, pause_range[0], pause_range[1], rng=rng)

    await human_pause(
        page,
        prof["scroll"]["pause_after_ms"][0],
        prof["scroll"]["pause_after_ms"][1],
        rng=rng,
    )

    return {
        "ok": True,
        "direction": plan["direction"],
        "amount": plan["amount"],
        "steps": len(plan["events"]),
        "bursty": plan["bursty"],
        "inverse_correction": plan["inverse_correction"],
    }
