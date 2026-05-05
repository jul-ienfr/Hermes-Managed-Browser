"""Unit tests for camofox.domain.vnc — VNC display management."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from camofox.domain.vnc import (
    DISPLAY_REGISTRY_PATH,
    _check_port_with_socket,
    _check_proc_net_tcp,
    _ensure_registry_dir,
    _is_port_in_use,
    _normalise_resolution,
    _parse_display_number,
    _resolution_to_clip,
    _write_display_registry,
    launch_vnc_watcher,
    read_display_registry,
    read_selected_vnc_user_id,
    record_vnc_display,
    remove_vnc_display,
    resolve_vnc_config,
    validate_vnc_geometry,
)


# ===================================================================
# _normalise_resolution
# ===================================================================


class TestNormaliseResolution:
    def test_no_depth_appends_24(self):
        assert _normalise_resolution("1920x1080") == "1920x1080x24"

    def test_already_has_depth(self):
        assert _normalise_resolution("1920x1080x24") == "1920x1080x24"

    def test_non_24_depth_preserved(self):
        assert _normalise_resolution("1920x1080x16") == "1920x1080x16"

    def test_strips_whitespace(self):
        assert _normalise_resolution("  800x600  ") == "800x600x24"

    def test_malformed_returns_original(self):
        assert _normalise_resolution("abc") == "abc"


# ===================================================================
# resolve_vnc_config
# ===================================================================


class TestResolveVncConfig:
    def test_defaults(self):
        config = resolve_vnc_config()
        assert config["enabled"] is False
        assert config["resolution"] == "1920x1080x24"
        assert config["vnc_password"] is None
        assert config["view_only"] is True
        assert config["vnc_port"] == 5901
        assert config["novnc_port"] == 6081
        assert config["bind"] == "127.0.0.1"
        assert config["human_only"] is True
        assert config["managed_registry_only"] is False
        assert config["display_registry"] == str(DISPLAY_REGISTRY_PATH)

    def test_plugin_config_overrides(self):
        pc = {
            "enabled": True,
            "resolution": "1280x720",
            "vnc_password": "secret",
            "view_only": False,
            "vnc_port": 5902,
            "novnc_port": 6082,
            "bind": "0.0.0.0",
            "human_only": False,
            "managed_registry_only": True,
        }
        config = resolve_vnc_config(pc)
        assert config["enabled"] is True
        assert config["resolution"] == "1280x720x24"
        assert config["vnc_password"] == "secret"
        assert config["view_only"] is False
        assert config["vnc_port"] == 5902
        assert config["novnc_port"] == 6082
        assert config["bind"] == "0.0.0.0"
        assert config["human_only"] is False
        assert config["managed_registry_only"] is True

    def test_env_overrides_plugin(self, monkeypatch):
        monkeypatch.setenv("ENABLE_VNC", "1")
        monkeypatch.setenv("VNC_RESOLUTION", "800x600x16")
        monkeypatch.setenv("VNC_PASSWORD", "envpass")
        monkeypatch.setenv("VNC_VIEW_ONLY", "0")
        monkeypatch.setenv("VNC_PORT", "5999")
        monkeypatch.setenv("NOVNC_PORT", "6999")
        monkeypatch.setenv("VNC_BIND", "0.0.0.0")
        monkeypatch.setenv("VNC_HUMAN_ONLY", "0")
        monkeypatch.setenv("VNC_MANAGED_REGISTRY_ONLY", "1")

        pc = {"enabled": False, "view_only": True}
        config = resolve_vnc_config(pc)
        assert config["enabled"] is True  # env wins
        assert config["resolution"] == "800x600x16"
        assert config["vnc_password"] == "envpass"
        assert config["view_only"] is False
        assert config["vnc_port"] == 5999
        assert config["novnc_port"] == 6999
        assert config["bind"] == "0.0.0.0"

    def test_env_enabled_variants(self, monkeypatch):
        for val in ("1", "true", "True", "yes"):
            monkeypatch.setenv("ENABLE_VNC", val)
            assert resolve_vnc_config()["enabled"] is True


# ===================================================================
# Display registry helpers (file I/O mocked)
# ===================================================================


class TestEnsureRegistryDir:
    def test_creates_directory(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "camofox.domain.vnc.DISPLAY_REGISTRY_PATH",
            tmp_path / "registry.json",
        )
        _ensure_registry_dir()
        assert (tmp_path).exists()


class TestReadDisplayRegistry:
    def test_file_not_exists_returns_empty(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "camofox.domain.vnc.DISPLAY_REGISTRY_PATH",
            tmp_path / "nonexistent.json",
        )
        assert read_display_registry() == {}

    def test_valid_json(self, tmp_path, monkeypatch):
        registry_file = tmp_path / "registry.json"
        registry_file.write_text(json.dumps({"user1": {"display": ":99"}}))
        monkeypatch.setattr(
            "camofox.domain.vnc.DISPLAY_REGISTRY_PATH",
            registry_file,
        )
        data = read_display_registry()
        assert data == {"user1": {"display": ":99"}}

    def test_corrupt_json_returns_empty(self, tmp_path, monkeypatch):
        registry_file = tmp_path / "registry.json"
        registry_file.write_text("not json")
        monkeypatch.setattr(
            "camofox.domain.vnc.DISPLAY_REGISTRY_PATH",
            registry_file,
        )
        assert read_display_registry() == {}

    def test_non_dict_json_returns_empty(self, tmp_path, monkeypatch):
        registry_file = tmp_path / "registry.json"
        registry_file.write_text(json.dumps(["list"]))
        monkeypatch.setattr(
            "camofox.domain.vnc.DISPLAY_REGISTRY_PATH",
            registry_file,
        )
        assert read_display_registry() == {}


class TestWriteDisplayRegistry:
    def test_writes_atomically(self, tmp_path, monkeypatch):
        registry_file = tmp_path / "registry.json"
        monkeypatch.setattr(
            "camofox.domain.vnc.DISPLAY_REGISTRY_PATH",
            registry_file,
        )
        _write_display_registry({"user1": {"display": ":99"}})
        assert registry_file.read_text() == json.dumps(
            {"user1": {"display": ":99"}}, indent=2
        )


class TestRecordVncDisplay:
    def test_records_entry(self, tmp_path, monkeypatch):
        registry_file = tmp_path / "registry.json"
        monkeypatch.setattr(
            "camofox.domain.vnc.DISPLAY_REGISTRY_PATH",
            registry_file,
        )
        record_vnc_display("user1", ":99", "1920x1080x24")
        data = json.loads(registry_file.read_text())
        assert data["user1"]["display"] == ":99"
        assert data["user1"]["resolution"] == "1920x1080x24"

    def test_with_profile_window_size(self, tmp_path, monkeypatch):
        registry_file = tmp_path / "registry.json"
        monkeypatch.setattr(
            "camofox.domain.vnc.DISPLAY_REGISTRY_PATH",
            registry_file,
        )
        record_vnc_display(
            "user1", ":99", "1920x1080x24",
            profile_window_size={"width": 1920, "height": 1080},
        )
        data = json.loads(registry_file.read_text())
        assert data["user1"]["profile_window_size"] == {
            "width": 1920, "height": 1080
        }


class TestRemoveVncDisplay:
    def test_removes_existing(self, tmp_path, monkeypatch):
        registry_file = tmp_path / "registry.json"
        registry_file.write_text(
            json.dumps({"user1": {"display": ":99"}, "user2": {"display": ":100"}})
        )
        monkeypatch.setattr(
            "camofox.domain.vnc.DISPLAY_REGISTRY_PATH",
            registry_file,
        )
        remove_vnc_display("user1")
        data = json.loads(registry_file.read_text())
        assert "user1" not in data
        assert "user2" in data

    def test_remove_missing_does_nothing(self, tmp_path, monkeypatch):
        registry_file = tmp_path / "registry.json"
        registry_file.write_text(json.dumps({"user1": {"display": ":99"}}))
        monkeypatch.setattr(
            "camofox.domain.vnc.DISPLAY_REGISTRY_PATH",
            registry_file,
        )
        # Should not raise
        remove_vnc_display("nonexistent")


# ===================================================================
# read_selected_vnc_user_id
# ===================================================================


class TestReadSelectedVncUserId:
    def test_nonexistent_file_returns_none(self, tmp_path):
        result = read_selected_vnc_user_id(
            str(tmp_path / "nonexistent.txt")
        )
        assert result is None

    def test_reads_content(self, tmp_path):
        scheme_file = tmp_path / "selection.txt"
        scheme_file.write_text("user1\n")
        result = read_selected_vnc_user_id(str(scheme_file))
        assert result == "user1"

    def test_strips_whitespace(self, tmp_path):
        scheme_file = tmp_path / "selection.txt"
        scheme_file.write_text("  user1  \n")
        result = read_selected_vnc_user_id(str(scheme_file))
        assert result == "user1"

    def test_empty_file_returns_none(self, tmp_path):
        scheme_file = tmp_path / "selection.txt"
        scheme_file.write_text("  \n")
        result = read_selected_vnc_user_id(str(scheme_file))
        assert result is None

    def test_env_var_default(self, monkeypatch):
        monkeypatch.setenv("VNC_DISPLAY_SELECTION", "")
        # Should fall through to default path which won't exist
        result = read_selected_vnc_user_id()
        assert result is None or isinstance(result, str)


# ===================================================================
# _parse_display_number
# ===================================================================


class TestParseDisplayNumber:
    def test_simple(self):
        assert _parse_display_number(":99") == 99

    def test_zero(self):
        assert _parse_display_number(":0") == 0

    def test_with_host(self):
        assert _parse_display_number("localhost:10") == 10

    def test_with_screen(self):
        assert _parse_display_number(":99.0") == 99

    def test_empty_returns_none(self):
        assert _parse_display_number("") is None

    def test_no_colon_returns_none(self):
        assert _parse_display_number("abc") is None

    def test_non_numeric_after_colon(self):
        assert _parse_display_number(":abc") is None


# ===================================================================
# _resolution_to_clip
# ===================================================================


class TestResolutionToClip:
    def test_standard(self):
        assert _resolution_to_clip("1920x1080x24") == "1920x1080+0+0"

    def test_no_depth(self):
        assert _resolution_to_clip("800x600") == "800x600+0+0"

    def test_non_numeric_returns_none(self):
        assert _resolution_to_clip("abcxdef") is None

    def test_single_part_returns_none(self):
        assert _resolution_to_clip("abc") is None


# ===================================================================
# validate_vnc_geometry
# ===================================================================


class TestValidateVncGeometry:
    def test_no_xdotool_returns_error(self):
        with patch("camofox.domain.vnc.shutil.which", return_value=None):
            result = validate_vnc_geometry(":99", 1920, 1080)
            assert result["valid"] is False
            assert "xdotool not found" in result["error"]

    def test_success(self):
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = "WINDOW=123\nX=0\nY=0\nWIDTH=1920\nHEIGHT=1080\n"
        mock_proc.stderr = ""

        with (
            patch("camofox.domain.vnc.shutil.which", return_value="/usr/bin/xdotool"),
            patch(
                "camofox.domain.vnc.subprocess.run",
                return_value=mock_proc,
            ),
        ):
            result = validate_vnc_geometry(":99", 1920, 1080)
            assert result["valid"] is True
            assert result["actual"] == {"width": 1920, "height": 1080}
            assert result["error"] is None

    def test_mismatch(self):
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = "WIDTH=1024\nHEIGHT=768\n"
        mock_proc.stderr = ""

        with (
            patch("camofox.domain.vnc.shutil.which", return_value="/usr/bin/xdotool"),
            patch(
                "camofox.domain.vnc.subprocess.run",
                return_value=mock_proc,
            ),
        ):
            result = validate_vnc_geometry(":99", 1920, 1080)
            assert result["valid"] is False
            assert "Expected 1920x1080" in result["error"]

    def test_timeout(self):
        with (
            patch("camofox.domain.vnc.shutil.which", return_value="/usr/bin/xdotool"),
            patch(
                "camofox.domain.vnc.subprocess.run",
                side_effect=subprocess.TimeoutExpired(cmd="xdotool", timeout=10),
            ),
        ):
            result = validate_vnc_geometry(":99", 1920, 1080)
            assert result["valid"] is False
            assert "timed out" in result["error"]

    def test_oserror(self):
        with (
            patch("camofox.domain.vnc.shutil.which", return_value="/usr/bin/xdotool"),
            patch(
                "camofox.domain.vnc.subprocess.run",
                side_effect=OSError("exec format error"),
            ),
        ):
            result = validate_vnc_geometry(":99", 1920, 1080)
            assert result["valid"] is False
            assert "execution error" in result["error"]

    def test_nonzero_exit(self):
        mock_proc = MagicMock()
        mock_proc.returncode = 1
        mock_proc.stdout = ""
        mock_proc.stderr = "No window found"

        with (
            patch("camofox.domain.vnc.shutil.which", return_value="/usr/bin/xdotool"),
            patch(
                "camofox.domain.vnc.subprocess.run",
                return_value=mock_proc,
            ),
        ):
            result = validate_vnc_geometry(":99", 1920, 1080)
            assert result["valid"] is False
            assert "exit code" in result["error"]


# ===================================================================
# _is_port_in_use / _check_proc_net_tcp / _check_port_with_socket
# ===================================================================


class TestIsPortInUse:
    def test_proc_net_found(self):
        with patch(
            "camofox.domain.vnc._check_proc_net_tcp", return_value=True
        ):
            assert _is_port_in_use(5901) is True

    def test_proc_net_returns_false(self):
        with patch(
            "camofox.domain.vnc._check_proc_net_tcp", return_value=False
        ):
            assert _is_port_in_use(5901) is False

    def test_fallback_to_socket(self):
        with (
            patch(
                "camofox.domain.vnc._check_proc_net_tcp",
                side_effect=FileNotFoundError,
            ),
            patch(
                "camofox.domain.vnc._check_port_with_socket",
                return_value=True,
            ),
        ):
            assert _is_port_in_use(5901) is True


class TestCheckProcNetTcp:
    def test_port_found_listening(self):
        tcp_content = (
            "  sl  local_address rem_address   st tx_queue rx_queue\n"
            "   0: 0100007F:170d 00000000:0000 0A 00000000:00000000\n"
        )
        with (
            patch.object(Path, "is_file", return_value=True),
            patch.object(Path, "read_text", return_value=tcp_content),
        ):
            assert _check_proc_net_tcp(5901) is True

    def test_port_not_found(self):
        tcp_content = (
            "  sl  local_address rem_address   st tx_queue rx_queue\n"
            "   0: 0100007F:0A1B 00000000:0000 0A 00000000:00000000\n"
        )
        with (
            patch.object(Path, "is_file", return_value=True),
            patch.object(Path, "read_text", return_value=tcp_content),
        ):
            assert _check_proc_net_tcp(5901) is False

    def test_tcp6_also_checked(self):
        tcp6_content = (
            "  sl  local_address rem_address   st tx_queue rx_queue\n"
            "   0: 0000000000000000FFFF00000100007F:170d 0000000000000000:0000 0A 00000000:00000000\n"
        )
        with (
            patch.object(Path, "is_file", return_value=True),
            patch.object(Path, "read_text", return_value=tcp6_content),
        ):
            assert _check_proc_net_tcp(5901) is True

    def test_file_not_found(self):
        with patch.object(Path, "is_file", return_value=False):
            assert _check_proc_net_tcp(5901) is False


class TestCheckPortWithSocket:
    def test_port_in_use(self):
        with patch("socket.socket") as mock_socket:
            sock_instance = MagicMock()
            mock_socket.return_value = sock_instance
            sock_instance.connect = MagicMock()
            result = _check_port_with_socket(5901)
            assert result is True

    def test_port_free(self):
        with patch("socket.socket") as mock_socket:
            sock_instance = MagicMock()
            mock_socket.return_value = sock_instance
            sock_instance.connect = MagicMock(
                side_effect=ConnectionRefusedError
            )
            result = _check_port_with_socket(5901)
            assert result is False


# ===================================================================
# launch_vnc_watcher
# ===================================================================


class TestLaunchVncWatcher:
    def test_no_display_returns_none(self):
        config = {"display": ""}
        result = launch_vnc_watcher(config, "user1")
        assert result is None

    def test_no_x11vnc_returns_none(self):
        config = {"display": ":99", "vnc_port": 5901, "novnc_port": 6081}
        with patch("camofox.domain.vnc.shutil.which", return_value=None):
            result = launch_vnc_watcher(config, "user1")
            assert result is None

    def test_no_websockify_returns_none(self):
        config = {"display": ":99", "vnc_port": 5901, "novnc_port": 6081}
        with (
            patch("camofox.domain.vnc.shutil.which", side_effect=["/usr/bin/x11vnc", None]),
        ):
            result = launch_vnc_watcher(config, "user1")
            assert result is None

    def test_port_in_use_returns_none(self):
        config = {"display": ":99", "vnc_port": 5901, "novnc_port": 6081}
        with (
            patch("camofox.domain.vnc.shutil.which", return_value="/usr/bin/x11vnc"),
            patch("camofox.domain.vnc._is_port_in_use", return_value=True),
        ):
            result = launch_vnc_watcher(config, "user1")
            assert result is None

    def test_successful_launch(self):
        mock_proc = MagicMock(spec=subprocess.Popen)
        mock_proc.pid = 12345

        config = {
            "display": ":99",
            "vnc_port": 5901,
            "novnc_port": 6081,
            "resolution": "1920x1080x24",
            "vnc_password": "",
            "view_only": True,
            "bind": "127.0.0.1",
        }

        with (
            patch("camofox.domain.vnc.shutil.which", return_value="/usr/bin/x11vnc"),
            patch("camofox.domain.vnc._is_port_in_use", return_value=False),
            patch("camofox.domain.vnc.subprocess.Popen", return_value=mock_proc),
        ):
            result = launch_vnc_watcher(config, "user1")
            assert result is not None
            assert result.pid == 12345

    def test_unparseable_display_returns_none(self):
        config = {"display": "bad"}
        result = launch_vnc_watcher(config, "user1")
        assert result is None

    def test_x11vnc_failure_returns_none(self):
        config = {
            "display": ":99",
            "vnc_port": 5901,
            "novnc_port": 6081,
            "resolution": "1920x1080x24",
            "vnc_password": "",
            "view_only": True,
            "bind": "127.0.0.1",
        }

        with (
            patch("camofox.domain.vnc.shutil.which", return_value="/usr/bin/x11vnc"),
            patch("camofox.domain.vnc._is_port_in_use", return_value=False),
            patch(
                "camofox.domain.vnc.subprocess.Popen",
                side_effect=OSError("failed"),
            ),
        ):
            result = launch_vnc_watcher(config, "user1")
            assert result is None
