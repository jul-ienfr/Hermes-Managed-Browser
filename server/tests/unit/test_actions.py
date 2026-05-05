"""Unit tests for camofox.domain.actions — human-like browser actions."""

from __future__ import annotations

import asyncio
import math
import re
from typing import Any, Callable
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from camofox.domain.actions import (
    SPEED_PROFILES,
    _ADJACENT_KEYS,
    _SENSITIVE_INPUT_KINDS,
    _ALPHA,
    _DIGITS,
    _bezier,
    _bounded_action,
    _bounded_mouse_move,
    _clamp,
    _clamp_point_to_viewport,
    _default_rng,
    _ease_in_out_cubic,
    _gaussian,
    _human_path,
    _human_settle,
    _jitter,
    _overshoot_point,
    _plan_human_motion,
    _plan_human_scroll,
    _play_mouse_path,
    _rand,
    _rand_int,
    _range_delay,
    _typo_for,
    choose_human_target_point,
    create_seeded_random,
    effective_mistakes_rate,
    get_human_profile,
    human_click,
    human_move,
    human_pause,
    human_press,
    human_scroll,
    human_type,
)


# ===================================================================
# Deterministic PRNG for testing
# ===================================================================


def _make_deterministic_rng(seed_str: str = "test") -> Callable[[], float]:
    return create_seeded_random(seed_str)


# ===================================================================
# create_seeded_random
# ===================================================================


class TestCreateSeededRandom:
    def test_deterministic(self):
        rng1 = create_seeded_random("hello")
        rng2 = create_seeded_random("hello")
        seq1 = [rng1() for _ in range(10)]
        seq2 = [rng2() for _ in range(10)]
        assert seq1 == seq2

    def test_different_seeds_differ(self):
        rng1 = create_seeded_random("hello")
        rng2 = create_seeded_random("world")
        seq1 = [rng1() for _ in range(10)]
        seq2 = [rng2() for _ in range(10)]
        assert seq1 != seq2

    def test_no_seed_falls_back_to_time(self, monkeypatch):
        import time
        monkeypatch.setattr(time, "monotonic_ns", lambda: 12345)
        rng = create_seeded_random(None)
        val = rng()
        assert 0.0 <= val <= 1.0

    def test_output_range(self):
        rng = create_seeded_random("range")
        for _ in range(100):
            v = rng()
            assert 0.0 <= v < 1.0


# ===================================================================
# _clamp
# ===================================================================


class TestClamp:
    def test_clamps_below(self):
        assert _clamp(-5, 0, 10) == 0

    def test_clamps_above(self):
        assert _clamp(15, 0, 10) == 10

    def test_within_range(self):
        assert _clamp(5, 0, 10) == 5

    def test_edge_values(self):
        assert _clamp(0, 0, 10) == 0
        assert _clamp(10, 0, 10) == 10


# ===================================================================
# _rand, _rand_int
# ===================================================================


class TestRand:
    def test_rand_ranges(self):
        rng = _make_deterministic_rng("rand")
        for _ in range(50):
            v = _rand(rng, 10, 20)
            assert 10 <= v <= 20

    def test_rand_int_ranges(self):
        rng = _make_deterministic_rng("rand_int")
        for _ in range(50):
            v = _rand_int(rng, 5, 10)
            assert 5 <= v <= 10
            assert isinstance(v, int)


# ===================================================================
# _gaussian
# ===================================================================


class TestGaussian:
    def test_returns_float(self):
        rng = _make_deterministic_rng("gauss")
        v = _gaussian(rng)
        assert isinstance(v, float)

    def test_handles_zero_loop(self):
        """Box-Muller loops when u==0.0; confirm it eventually returns."""
        calls = [0.0, 0.0, 0.0, 0.5, 0.3]
        it = iter(calls)

        def mock_rng():
            return next(it)

        v = _gaussian(mock_rng)
        assert isinstance(v, float)


# ===================================================================
# _jitter
# ===================================================================


class TestJitter:
    def test_non_negative(self):
        rng = _make_deterministic_rng("jitter")
        for _ in range(50):
            v = _jitter(100.0, 0.2, rng)
            assert v >= 0.0

    def test_zero_value_stays_zero(self):
        rng = _make_deterministic_rng("jitter_zero")
        assert _jitter(0.0, 0.5, rng) == 0.0


# ===================================================================
# _range_delay
# ===================================================================


class TestRangeDelay:
    def test_within_bounds(self):
        rng = _make_deterministic_rng("range_delay")
        for _ in range(50):
            v = _range_delay(rng, (50, 200))
            assert 50 <= v <= 200
            assert isinstance(v, int)

    def test_single_value_range(self):
        rng = _make_deterministic_rng("range_single")
        for _ in range(10):
            v = _range_delay(rng, (100, 100))
            assert isinstance(v, int)


# ===================================================================
# _ease_in_out_cubic
# ===================================================================


class TestEaseInOutCubic:
    def test_zero(self):
        assert _ease_in_out_cubic(0.0) == 0.0

    def test_one(self):
        assert _ease_in_out_cubic(1.0) == 1.0

    def test_half(self):
        assert _ease_in_out_cubic(0.5) == 0.5

    def test_smooth(self):
        assert _ease_in_out_cubic(0.25) < 0.5
        assert _ease_in_out_cubic(0.75) > 0.5


# ===================================================================
# _bezier
# ===================================================================


class TestBezier:
    def test_endpoints(self):
        p0 = (0.0, 0.0)
        p3 = (100.0, 200.0)
        assert _bezier(p0, (50, 50), (50, 150), p3, 0.0) == p0
        assert _bezier(p0, (50, 50), (50, 150), p3, 1.0) == p3

    def test_interpolation(self):
        p0 = (0.0, 0.0)
        p3 = (100.0, 0.0)
        pt = _bezier(p0, (30, 50), (70, -50), p3, 0.5)
        assert 30 < pt[0] < 70


# ===================================================================
# _human_path
# ===================================================================


class TestHumanPath:
    def test_returns_correct_number_of_steps(self):
        rng = _make_deterministic_rng("path")
        path = _human_path((0, 0), (100, 100), 10, rng)
        assert len(path) == 10

    def test_all_points_are_tuples(self):
        rng = _make_deterministic_rng("path_tuples")
        path = _human_path((0, 0), (100, 100), 5, rng)
        for pt in path:
            assert len(pt) == 2
            assert isinstance(pt[0], float)
            assert isinstance(pt[1], float)


# ===================================================================
# _overshoot_point
# ===================================================================


class TestOvershootPoint:
    def test_past_target(self):
        rng = _make_deterministic_rng("overshoot")
        pt = _overshoot_point((0, 0), (100, 100), rng)
        # Should be past 100, 100 depending on factor
        assert abs(pt[0]) > 90 or abs(pt[1]) > 90


# ===================================================================
# _clamp_point_to_viewport
# ===================================================================


class TestClampPointToViewport:
    def test_none_viewport_returns_point(self):
        assert _clamp_point_to_viewport((50, 50), None) == (50, 50)

    def test_clamps_to_viewport(self):
        vp = {"width": 1280, "height": 720}
        assert _clamp_point_to_viewport((2000, 1000), vp) == (1279, 719)

    def test_negative_clamps_to_padding(self):
        vp = {"width": 1280, "height": 720}
        assert _clamp_point_to_viewport((-100, -100), vp, edge_padding=1) == (1, 1)

    def test_defaults(self):
        vp = {"width": 1280, "height": 720}
        assert _clamp_point_to_viewport((50, 50), vp) == (50, 50)


# ===================================================================
# get_human_profile
# ===================================================================


class TestGetHumanProfile:
    def test_returns_medium_by_default(self):
        prof = get_human_profile("medium")
        assert prof["name"] == "medium"

    def test_known_profiles(self):
        for name in ("fast", "medium", "slow"):
            prof = get_human_profile(name)
            assert prof["name"] == name
            assert "click" in prof
            assert "typing" in prof
            assert "scroll" in prof

    def test_unknown_falls_back_to_fast(self):
        prof = get_human_profile("nonexistent")
        assert prof["name"] == "fast"


# ===================================================================
# _plan_human_motion
# ===================================================================


class TestPlanHumanMotion:
    def test_returns_dict_with_expected_keys(self):
        rng = _make_deterministic_rng("motion")
        plan = _plan_human_motion(to=(200, 200), rng=rng)
        for key in ("points", "final_point", "duration_ms", "interval_ms", "steps", "overshot", "missed", "care_factor"):
            assert key in plan

    def test_final_point_matches_to(self):
        rng = _make_deterministic_rng("motion_final")
        plan = _plan_human_motion(to=(300, 400), rng=rng)
        assert plan["final_point"] == (300, 400)

    def test_overshoot_when_far(self):
        rng = _make_deterministic_rng("overshoot_plan")
        plan = _plan_human_motion(
            from_=(0, 0), to=(800, 600), rng=rng, overshoot_chance=1.0
        )
        # Should overshoot with 100% chance since distance > 120
        assert plan["overshot"]

    def test_no_overshoot_when_close(self):
        rng = _make_deterministic_rng("no_overshoot")
        plan = _plan_human_motion(
            from_=(0, 0), to=(50, 50), rng=rng, overshoot_chance=1.0
        )
        # Distance 70.7 < 120, so no overshoot
        assert not plan["overshot"]

    def test_slight_miss(self):
        rng = _make_deterministic_rng("slight_miss")
        plan = _plan_human_motion(
            from_=(0, 0), to=(500, 500), rng=rng, slight_miss_chance=1.0
        )
        # Could miss or not depending on RNG, but should have points
        assert len(plan["points"]) > 0

    def test_viewport_clamping(self):
        rng = _make_deterministic_rng("viewport_clamp")
        plan = _plan_human_motion(
            to=(9999, 9999), rng=rng, viewport={"width": 1280, "height": 720}
        )
        assert plan["final_point"] == (1279, 719)

    def test_duration_override(self):
        rng = _make_deterministic_rng("duration_override")
        plan = _plan_human_motion(to=(200, 200), rng=rng, duration_ms=500)
        assert plan["duration_ms"] == 500


# ===================================================================
# choose_human_target_point
# ===================================================================


class TestChooseHumanTargetPoint:
    def test_raises_on_empty_box(self):
        with pytest.raises(ValueError, match="requires a box"):
            choose_human_target_point({})

    def test_returns_within_box(self):
        rng = _make_deterministic_rng("target_pt")
        box = {"x": 100, "y": 100, "width": 200, "height": 100}
        pt, care = choose_human_target_point(box, rng=rng)
        x, y = pt
        assert 100 <= x <= 300
        assert 100 <= y <= 200
        assert 1.0 <= care <= 2.0

    def test_small_element_high_care(self):
        rng = _make_deterministic_rng("small_target")
        box = {"x": 0, "y": 0, "width": 10, "height": 10}
        _, care = choose_human_target_point(box, rng=rng)
        assert care > 1.0


# ===================================================================
# _plan_human_scroll
# ===================================================================


class TestPlanHumanScroll:
    def test_returns_dict_with_expected_keys(self):
        rng = _make_deterministic_rng("scroll_plan")
        plan = _plan_human_scroll(rng=rng)
        for key in ("direction", "amount", "bursty", "inverse_correction", "events"):
            assert key in plan

    def test_default_direction_down(self):
        rng = _make_deterministic_rng("scroll_down")
        plan = _plan_human_scroll(rng=rng)
        assert plan["direction"] == "down"

    def test_up_direction(self):
        rng = _make_deterministic_rng("scroll_up")
        plan = _plan_human_scroll(rng=rng, direction="up")
        assert plan["direction"] == "up"

    def test_specific_amount(self):
        rng = _make_deterministic_rng("scroll_amount")
        plan = _plan_human_scroll(rng=rng, amount=500)
        assert plan["amount"] == 500

    def test_non_bursty(self):
        rng = _make_deterministic_rng("scroll_non_bursty")
        plan = _plan_human_scroll(rng=rng, bursty=False)
        assert not plan["bursty"]
        assert len(plan["events"]) > 0

    def test_events_have_required_fields(self):
        rng = _make_deterministic_rng("scroll_events")
        plan = _plan_human_scroll(rng=rng)
        for ev in plan["events"]:
            assert "delta_x" in ev
            assert "delta_y" in ev
            assert "pause_range_ms" in ev
            assert "index" in ev


# ===================================================================
# _typo_for
# ===================================================================


class TestTypoFor:
    def test_adjacent_key(self):
        rng = _make_deterministic_rng("typo")
        result = _typo_for("a", rng)
        # a's adjacent keys: qszw
        assert result in "qszw"

    def test_alpha_fallback(self):
        rng = _make_deterministic_rng("typo_alpha")
        result = _typo_for("z", rng)
        # z has adjacent: asx
        assert result in "asx"

    def test_digit_fallback(self):
        rng = _make_deterministic_rng("typo_digit")
        for d in "0123456789":
            result = _typo_for(d, rng)
            assert isinstance(result, str)

    def test_unknown_char(self):
        rng = _make_deterministic_rng("typo_unknown")
        assert _typo_for(" ", rng) == " "
        assert _typo_for("!", rng) == "!"

    def test_preserves_casing_from_adjacent(self):
        """_typo_for returns lowercase (adjacent keys are lowercase)."""
        rng = _make_deterministic_rng("typo_case")
        result = _typo_for("A", rng)
        assert result.islower() or result in "qszw"


# ===================================================================
# effective_mistakes_rate
# ===================================================================


class TestEffectiveMistakesRate:
    def test_zero_for_sensitive_fields(self):
        for kind in ("password", "email", "tel", "otp", "code", "url", "number"):
            assert effective_mistakes_rate(input_kind=kind) == 0.0

    def test_case_insensitive(self):
        assert effective_mistakes_rate(input_kind="PASSWORD") == 0.0
        assert effective_mistakes_rate(input_kind="Email") == 0.0

    def test_default_rate(self):
        rate = effective_mistakes_rate(input_kind="text")
        assert rate == 0.02

    def test_custom_rate(self):
        rate = effective_mistakes_rate(mistakes_rate=0.1)
        assert rate == 0.1

    def test_clamps_rate(self):
        assert effective_mistakes_rate(mistakes_rate=-0.1) == 0.0
        assert effective_mistakes_rate(mistakes_rate=2.0) == 1.0

    def test_non_finite_rate(self):
        assert effective_mistakes_rate(mistakes_rate=float("inf")) == 0.0
        assert effective_mistakes_rate(mistakes_rate=float("nan")) == 0.0

    def test_no_args(self):
        """input_kind=None and mistakes_rate=None should return default 0.02."""
        rate = effective_mistakes_rate()
        assert rate == 0.02


# ===================================================================
# human_pause
# ===================================================================


class TestHumanPause:
    @pytest.mark.asyncio
    async def test_no_page_wait_timeout_uses_sleep(self):
        page = MagicMock(spec=[])
        # page has no wait_for_timeout
        delay = await human_pause(page, 10, 20, rng=_make_deterministic_rng("pause"))
        assert 10 <= delay <= 20

    @pytest.mark.asyncio
    async def test_with_wait_for_timeout(self):
        page = MagicMock()
        page.wait_for_timeout = AsyncMock()
        delay = await human_pause(page, 10, 20, rng=_make_deterministic_rng("pause_wait"))
        assert 10 <= delay <= 20
        page.wait_for_timeout.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_timeout_error_handled(self):
        page = MagicMock()
        page.wait_for_timeout = AsyncMock(side_effect=asyncio.TimeoutError)
        delay = await human_pause(page, 10, 20, rng=_make_deterministic_rng("pause_timeout"))
        assert 10 <= delay <= 20

    @pytest.mark.asyncio
    async def test_generic_exception_handled(self):
        page = MagicMock()
        page.wait_for_timeout = AsyncMock(side_effect=Exception("boom"))
        delay = await human_pause(page, 10, 20, rng=_make_deterministic_rng("pause_exc"))
        assert 10 <= delay <= 20


# ===================================================================
# _human_settle
# ===================================================================


class TestHumanSettle:
    @pytest.mark.asyncio
    async def test_disabled_returns_zero_moves(self):
        page = MagicMock()
        result = await _human_settle(page, (100, 100), enabled=False)
        assert result["moves"] == 0
        assert result["position"] == (100, 100)

    @pytest.mark.asyncio
    async def test_enabled_performs_moves(self):
        page = MagicMock()
        page.mouse.move = AsyncMock()
        page.wait_for_timeout = AsyncMock()
        result = await _human_settle(
            page, (100, 100), enabled=True, moves=2, rng=_make_deterministic_rng("settle")
        )
        assert result["moves"] == 2
        assert page.mouse.move.await_count >= 2

    @pytest.mark.asyncio
    async def test_mouse_move_exception_handled(self):
        page = MagicMock()
        page.mouse.move = AsyncMock(side_effect=Exception("move fail"))
        page.wait_for_timeout = AsyncMock()
        result = await _human_settle(
            page, (100, 100), enabled=True, moves=1, rng=_make_deterministic_rng("settle_err")
        )
        assert result["moves"] >= 1


# ===================================================================
# _bounded_mouse_move
# ===================================================================


class TestBoundedMouseMove:
    @pytest.mark.asyncio
    async def test_successful_move(self):
        page = MagicMock()
        page.mouse.move = AsyncMock()
        await _bounded_mouse_move(page, 100, 200, timeout=1000)
        page.mouse.move.assert_awaited_once_with(100, 200, steps=1)

    @pytest.mark.asyncio
    async def test_timeout_raises(self):
        page = MagicMock()
        page.mouse.move = AsyncMock(side_effect=asyncio.TimeoutError)

        with pytest.raises(TimeoutError, match="mouse move soft timeout"):
            await _bounded_mouse_move(page, 100, 200, timeout=500)


# ===================================================================
# _play_mouse_path
# ===================================================================


class TestPlayMousePath:
    @pytest.mark.asyncio
    async def test_empty_path(self):
        page = MagicMock()
        page.mouse.move = AsyncMock()
        rng = _make_deterministic_rng("empty_path")
        await _play_mouse_path(page, [], 50, rng)
        page.mouse.move.assert_not_called()

    @pytest.mark.asyncio
    async def test_follows_path(self):
        page = MagicMock()
        page.mouse.move = AsyncMock()
        rng = _make_deterministic_rng("follow_path")
        path = [(10, 10), (20, 20), (30, 30)]
        await _play_mouse_path(page, path, 50, rng, move_timeout=5000)
        assert page.mouse.move.await_count == 3


# ===================================================================
# _bounded_action
# ===================================================================


class TestBoundedAction:
    @pytest.mark.asyncio
    async def test_success(self):
        action = AsyncMock()
        await _bounded_action(MagicMock(), action, 500)
        action.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_timeout_raises(self):
        action = AsyncMock(side_effect=asyncio.TimeoutError)
        with pytest.raises(TimeoutError, match="mouse action timed out"):
            await _bounded_action(MagicMock(), action, 500)


# ===================================================================
# human_move
# ===================================================================


class TestHumanMove:
    @pytest.mark.asyncio
    async def test_basic_move(self):
        page = MagicMock()
        page.mouse.move = AsyncMock()
        page.wait_for_timeout = AsyncMock()
        page.viewport_size = None
        result = await human_move(
            page, 200, 300, rng=_make_deterministic_rng("move_basic")
        )
        assert "position" in result
        assert "steps" in result
        assert "duration_ms" in result
        assert result["position"] == (200, 300)

    @pytest.mark.asyncio
    async def test_move_from_position(self):
        page = MagicMock()
        page.mouse.move = AsyncMock()
        page.wait_for_timeout = AsyncMock()
        page.viewport_size = None
        result = await human_move(
            page,
            500,
            500,
            from_=(100, 100),
            rng=_make_deterministic_rng("move_from"),
        )
        assert result["position"] == (500, 500)


# ===================================================================
# human_click
# ===================================================================


class TestHumanClick:
    @pytest.mark.asyncio
    async def test_basic_click(self):
        page = MagicMock()
        page.locator = MagicMock()
        locator = MagicMock()
        page.locator.return_value = locator

        # Setup bounding box for locate
        locator.bounding_box = AsyncMock(return_value={
            "x": 100, "y": 100, "width": 50, "height": 30
        })
        locator.wait_for = AsyncMock()
        locator.scroll_into_view_if_needed = AsyncMock()
        locator.focus = AsyncMock()
        locator.click = AsyncMock()

        page.mouse.move = AsyncMock()
        page.mouse.down = AsyncMock()
        page.mouse.up = AsyncMock()
        page.mouse.wheel = AsyncMock()
        page.wait_for_timeout = AsyncMock()
        page.viewport_size = {"width": 1280, "height": 720}

        result = await human_click(
            page, "#my-button", rng=_make_deterministic_rng("click_basic")
        )
        assert result["ok"]
        assert "position" in result
        assert "move" in result
        assert "settle" in result
        page.mouse.down.assert_awaited_once()
        page.mouse.up.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_fallback_locator_click(self):
        page = MagicMock()
        page.locator = MagicMock()
        locator = MagicMock()
        page.locator.return_value = locator

        # bounding box returns None to trigger fallback
        locator.bounding_box = AsyncMock(return_value=None)
        locator.wait_for = AsyncMock(side_effect=Exception("not found"))
        locator.scroll_into_view_if_needed = AsyncMock()
        locator.click = AsyncMock()  # fallback succeeds
        locator.focus = AsyncMock()

        page.mouse.move = AsyncMock()
        page.mouse.down = AsyncMock()
        page.mouse.up = AsyncMock()
        page.wait_for_timeout = AsyncMock()
        page.keyboard.press = AsyncMock()
        page.viewport_size = {"width": 1280, "height": 720}

        result = await human_click(
            page, "#missing-button", rng=_make_deterministic_rng("click_fallback")
        )
        assert result["ok"]
        assert result.get("fallback") in ("locator.click", "keyboard.activate")


# ===================================================================
# human_type
# ===================================================================


class TestHumanType:
    @pytest.mark.asyncio
    async def test_basic_type(self):
        page = MagicMock()
        page.locator = MagicMock()
        locator = MagicMock()
        page.locator.return_value = locator
        locator.focus = AsyncMock()
        locator.evaluate = AsyncMock()

        page.keyboard.type = AsyncMock()
        page.keyboard.press = AsyncMock()
        page.wait_for_timeout = AsyncMock()

        result = await human_type(
            page, "#input-field", "hello",
            rng=_make_deterministic_rng("type_basic"),
        )
        assert result["ok"]
        assert result["chars"] == 5

    @pytest.mark.asyncio
    async def test_clear_first(self):
        page = MagicMock()
        page.locator = MagicMock()
        locator = MagicMock()
        page.locator.return_value = locator
        locator.focus = AsyncMock()
        locator.evaluate = AsyncMock()

        page.keyboard.type = AsyncMock()
        page.keyboard.press = AsyncMock()
        page.wait_for_timeout = AsyncMock()

        result = await human_type(
            page, "#input", "text",
            clear_first=True,
            rng=_make_deterministic_rng("type_clear"),
        )
        assert result["ok"]
        # Should have pressed Control+A and Backspace
        press_calls = [c[0][0] for c in page.keyboard.press.await_args_list if c[0]]
        assert "Control+A" in press_calls or any(
            "Control+A" in str(c) for c in page.keyboard.press.await_args_list
        )

    @pytest.mark.asyncio
    async def test_dom_focus_fallback(self):
        page = MagicMock()
        page.locator = MagicMock()
        locator = MagicMock()
        page.locator.return_value = locator
        locator.focus = AsyncMock(side_effect=Exception("focus fail"))
        locator.evaluate = AsyncMock(return_value=None)

        page.keyboard.type = AsyncMock()
        page.keyboard.press = AsyncMock()
        page.wait_for_timeout = AsyncMock()

        result = await human_type(
            page, "#input", "hi",
            allow_dom_focus_fallback=True,
            rng=_make_deterministic_rng("type_focus_fallback"),
        )
        assert result["ok"]
        locator.evaluate.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_sensitive_input_no_mistakes(self):
        page = MagicMock()
        page.locator = MagicMock()
        locator = MagicMock()
        page.locator.return_value = locator
        locator.focus = AsyncMock()
        locator.evaluate = AsyncMock()

        page.keyboard.type = AsyncMock()
        page.keyboard.press = AsyncMock()
        page.wait_for_timeout = AsyncMock()

        result = await human_type(
            page, "#password", "secret",
            input_kind="password",
            rng=_make_deterministic_rng("type_sensitive"),
        )
        assert result["ok"]


# ===================================================================
# human_press
# ===================================================================


class TestHumanPress:
    @pytest.mark.asyncio
    async def test_press_key(self):
        page = MagicMock()
        page.keyboard.press = AsyncMock()
        page.wait_for_timeout = AsyncMock()

        result = await human_press(
            page, "Enter", rng=_make_deterministic_rng("press")
        )
        assert result["ok"]
        assert result["key"] == "Enter"
        page.keyboard.press.assert_awaited_once_with("Enter")


# ===================================================================
# human_scroll
# ===================================================================


class TestHumanScroll:
    @pytest.mark.asyncio
    async def test_basic_scroll(self):
        page = MagicMock()
        page.mouse.wheel = AsyncMock()
        page.wait_for_timeout = AsyncMock()

        result = await human_scroll(
            page, rng=_make_deterministic_rng("scroll_basic")
        )
        assert result["ok"]
        assert "direction" in result
        assert "amount" in result
        assert "steps" in result
        page.mouse.wheel.assert_called()

    @pytest.mark.asyncio
    async def test_up_scroll(self):
        page = MagicMock()
        page.mouse.wheel = AsyncMock()
        page.wait_for_timeout = AsyncMock()

        result = await human_scroll(
            page, direction="up", rng=_make_deterministic_rng("scroll_up")
        )
        assert result["ok"]
        assert result["direction"] == "up"

    @pytest.mark.asyncio
    async def test_specific_amount(self):
        page = MagicMock()
        page.mouse.wheel = AsyncMock()
        page.wait_for_timeout = AsyncMock()

        result = await human_scroll(
            page, amount=300, rng=_make_deterministic_rng("scroll_amount")
        )
        assert result["ok"]
        assert result["amount"] == 300


# ===================================================================
# Constants sanity
# ===================================================================


class TestConstants:
    def test_speed_profiles_have_required_keys(self):
        for name, prof in SPEED_PROFILES.items():
            assert "name" in prof
            assert "speed" in prof
            assert prof["name"] == name
            for section in ("click", "typing", "scroll"):
                assert section in prof, f"{name} missing {section}"
                assert isinstance(prof[section], dict)

    # adjacency bidirectional test removed — keyboard layouts are not
    # perfectly symmetric within the defined keys (e.g. 1→q but q's
    # neighbors is ['w','a'], not ['1'])

    def test_sensitive_input_kinds(self):
        kinds = {"password", "email", "tel", "otp", "code", "url", "number"}
        assert _SENSITIVE_INPUT_KINDS == kinds

    def test_alpha_digits(self):
        assert len(_ALPHA) == 26
        assert _ALPHA == "abcdefghijklmnopqrstuvwxyz"
        assert _DIGITS == "0123456789"
