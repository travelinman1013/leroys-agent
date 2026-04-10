"""Tests for the file tools module (schema, handler wiring, error paths).

Tests verify tool schemas, handler dispatch, validation logic, and error
handling without requiring a running terminal environment.
"""

import json
import logging
from unittest.mock import MagicMock, patch

from tools.file_tools import (
    FILE_TOOLS,
    READ_FILE_SCHEMA,
    WRITE_FILE_SCHEMA,
    PATCH_SCHEMA,
    SEARCH_FILES_SCHEMA,
)


class TestFileToolsList:
    def test_has_expected_entries(self):
        names = {t["name"] for t in FILE_TOOLS}
        assert names == {"read_file", "write_file", "patch", "search_files"}

    def test_each_entry_has_callable_function(self):
        for tool in FILE_TOOLS:
            assert callable(tool["function"]), f"{tool['name']} missing callable"

    def test_schemas_have_required_fields(self):
        """All schemas must have name, description, and parameters with properties."""
        for schema in [READ_FILE_SCHEMA, WRITE_FILE_SCHEMA, PATCH_SCHEMA, SEARCH_FILES_SCHEMA]:
            assert "name" in schema
            assert "description" in schema
            assert "properties" in schema["parameters"]


class TestReadFileHandler:
    @patch("tools.file_tools._get_file_ops")
    def test_returns_file_content(self, mock_get):
        mock_ops = MagicMock()
        result_obj = MagicMock()
        result_obj.content = "line1\nline2"
        result_obj.to_dict.return_value = {"content": "line1\nline2", "total_lines": 2}
        mock_ops.read_file.return_value = result_obj
        mock_get.return_value = mock_ops

        from tools.file_tools import read_file_tool
        result = json.loads(read_file_tool("/tmp/test.txt"))
        assert result["content"] == "line1\nline2"
        assert result["total_lines"] == 2
        mock_ops.read_file.assert_called_once_with("/tmp/test.txt", 1, 500)

    @patch("tools.file_tools._get_file_ops")
    def test_custom_offset_and_limit(self, mock_get):
        mock_ops = MagicMock()
        result_obj = MagicMock()
        result_obj.content = "line10"
        result_obj.to_dict.return_value = {"content": "line10", "total_lines": 50}
        mock_ops.read_file.return_value = result_obj
        mock_get.return_value = mock_ops

        from tools.file_tools import read_file_tool
        read_file_tool("/tmp/big.txt", offset=10, limit=20)
        mock_ops.read_file.assert_called_once_with("/tmp/big.txt", 10, 20)

    @patch("tools.file_tools._get_file_ops")
    def test_exception_returns_error_json(self, mock_get):
        mock_get.side_effect = RuntimeError("terminal not available")

        from tools.file_tools import read_file_tool
        result = json.loads(read_file_tool("/tmp/test.txt"))
        assert "error" in result
        assert "terminal not available" in result["error"]


class TestWriteFileHandler:
    @patch("tools.file_tools._get_file_ops")
    def test_writes_content(self, mock_get):
        mock_ops = MagicMock()
        result_obj = MagicMock()
        result_obj.to_dict.return_value = {"status": "ok", "path": "/tmp/out.txt", "bytes": 13}
        mock_ops.write_file.return_value = result_obj
        mock_get.return_value = mock_ops

        from tools.file_tools import write_file_tool
        result = json.loads(write_file_tool("/tmp/out.txt", "hello world!\n"))
        assert result["status"] == "ok"
        mock_ops.write_file.assert_called_once_with("/tmp/out.txt", "hello world!\n")

    @patch("tools.file_tools._get_file_ops")
    def test_permission_error_returns_error_json_without_error_log(self, mock_get, caplog):
        mock_get.side_effect = PermissionError("read-only filesystem")

        from tools.file_tools import write_file_tool
        with caplog.at_level(logging.DEBUG, logger="tools.file_tools"):
            result = json.loads(write_file_tool("/tmp/out.txt", "data"))
        assert "error" in result
        assert "read-only" in result["error"]
        assert any("write_file expected denial" in r.getMessage() for r in caplog.records)
        assert not any(r.levelno >= logging.ERROR for r in caplog.records)

    @patch("tools.file_tools._get_file_ops")
    def test_unexpected_exception_still_logs_error(self, mock_get, caplog):
        mock_get.side_effect = RuntimeError("boom")

        from tools.file_tools import write_file_tool
        with caplog.at_level(logging.ERROR, logger="tools.file_tools"):
            result = json.loads(write_file_tool("/tmp/out.txt", "data"))
        assert result["error"] == "boom"
        assert any("write_file error" in r.getMessage() for r in caplog.records)


class TestPatchHandler:
    @patch("tools.file_tools._get_file_ops")
    def test_replace_mode_calls_patch_replace(self, mock_get):
        mock_ops = MagicMock()
        result_obj = MagicMock()
        result_obj.to_dict.return_value = {"status": "ok", "replacements": 1}
        mock_ops.patch_replace.return_value = result_obj
        mock_get.return_value = mock_ops

        from tools.file_tools import patch_tool
        result = json.loads(patch_tool(
            mode="replace", path="/tmp/f.py",
            old_string="foo", new_string="bar"
        ))
        assert result["status"] == "ok"
        mock_ops.patch_replace.assert_called_once_with("/tmp/f.py", "foo", "bar", False)

    @patch("tools.file_tools._get_file_ops")
    def test_replace_mode_replace_all_flag(self, mock_get):
        mock_ops = MagicMock()
        result_obj = MagicMock()
        result_obj.to_dict.return_value = {"status": "ok", "replacements": 5}
        mock_ops.patch_replace.return_value = result_obj
        mock_get.return_value = mock_ops

        from tools.file_tools import patch_tool
        patch_tool(mode="replace", path="/tmp/f.py",
                   old_string="x", new_string="y", replace_all=True)
        mock_ops.patch_replace.assert_called_once_with("/tmp/f.py", "x", "y", True)

    @patch("tools.file_tools._get_file_ops")
    def test_replace_mode_missing_path_errors(self, mock_get):
        from tools.file_tools import patch_tool
        result = json.loads(patch_tool(mode="replace", path=None, old_string="a", new_string="b"))
        assert "error" in result

    @patch("tools.file_tools._get_file_ops")
    def test_replace_mode_missing_strings_errors(self, mock_get):
        from tools.file_tools import patch_tool
        result = json.loads(patch_tool(mode="replace", path="/tmp/f.py", old_string=None, new_string="b"))
        assert "error" in result

    @patch("tools.file_tools._get_file_ops")
    def test_patch_mode_calls_patch_v4a(self, mock_get):
        mock_ops = MagicMock()
        result_obj = MagicMock()
        result_obj.to_dict.return_value = {"status": "ok", "operations": 1}
        mock_ops.patch_v4a.return_value = result_obj
        mock_get.return_value = mock_ops

        from tools.file_tools import patch_tool
        result = json.loads(patch_tool(mode="patch", patch="*** Begin Patch\n..."))
        assert result["status"] == "ok"
        mock_ops.patch_v4a.assert_called_once()

    @patch("tools.file_tools._get_file_ops")
    def test_patch_mode_missing_content_errors(self, mock_get):
        from tools.file_tools import patch_tool
        result = json.loads(patch_tool(mode="patch", patch=None))
        assert "error" in result

    @patch("tools.file_tools._get_file_ops")
    def test_unknown_mode_errors(self, mock_get):
        from tools.file_tools import patch_tool
        result = json.loads(patch_tool(mode="invalid_mode"))
        assert "error" in result
        assert "Unknown mode" in result["error"]


class TestSearchHandler:
    @patch("tools.file_tools._get_file_ops")
    def test_search_calls_file_ops(self, mock_get):
        mock_ops = MagicMock()
        result_obj = MagicMock()
        result_obj.to_dict.return_value = {"matches": ["file1.py:3:match"]}
        mock_ops.search.return_value = result_obj
        mock_get.return_value = mock_ops

        from tools.file_tools import search_tool
        result = json.loads(search_tool(pattern="TODO", target="content", path="."))
        assert "matches" in result
        mock_ops.search.assert_called_once()

    @patch("tools.file_tools._get_file_ops")
    def test_search_passes_all_params(self, mock_get):
        mock_ops = MagicMock()
        result_obj = MagicMock()
        result_obj.to_dict.return_value = {"matches": []}
        mock_ops.search.return_value = result_obj
        mock_get.return_value = mock_ops

        from tools.file_tools import search_tool
        search_tool(pattern="class", target="files", path="/src",
                    file_glob="*.py", limit=10, offset=5, output_mode="count", context=2)
        mock_ops.search.assert_called_once_with(
            pattern="class", path="/src", target="files", file_glob="*.py",
            limit=10, offset=5, output_mode="count", context=2,
        )

    @patch("tools.file_tools._get_file_ops")
    def test_search_exception_returns_error(self, mock_get):
        mock_get.side_effect = RuntimeError("no terminal")

        from tools.file_tools import search_tool
        result = json.loads(search_tool(pattern="x"))
        assert "error" in result


# ---------------------------------------------------------------------------
# Tool result hint tests (#722)
# ---------------------------------------------------------------------------

class TestPatchHints:
    """Patch tool should hint when old_string is not found."""

    @patch("tools.file_tools._get_file_ops")
    def test_no_match_includes_hint(self, mock_get):
        mock_ops = MagicMock()
        result_obj = MagicMock()
        result_obj.to_dict.return_value = {
            "error": "Could not find match for old_string in foo.py"
        }
        mock_ops.patch_replace.return_value = result_obj
        mock_get.return_value = mock_ops

        from tools.file_tools import patch_tool
        raw = patch_tool(mode="replace", path="foo.py", old_string="x", new_string="y")
        assert "[Hint:" in raw
        assert "read_file" in raw

    @patch("tools.file_tools._get_file_ops")
    def test_success_no_hint(self, mock_get):
        mock_ops = MagicMock()
        result_obj = MagicMock()
        result_obj.to_dict.return_value = {"success": True, "diff": "--- a\n+++ b"}
        mock_ops.patch_replace.return_value = result_obj
        mock_get.return_value = mock_ops

        from tools.file_tools import patch_tool
        raw = patch_tool(mode="replace", path="foo.py", old_string="x", new_string="y")
        assert "[Hint:" not in raw


class TestSearchHints:
    """Search tool should hint when results are truncated."""

    def setup_method(self):
        """Clear read/search tracker between tests to avoid cross-test state."""
        from tools.file_tools import clear_read_tracker
        clear_read_tracker()

    @patch("tools.file_tools._get_file_ops")
    def test_truncated_results_hint(self, mock_get):
        mock_ops = MagicMock()
        result_obj = MagicMock()
        result_obj.to_dict.return_value = {
            "total_count": 100,
            "matches": [{"path": "a.py", "line": 1, "content": "x"}] * 50,
            "truncated": True,
        }
        mock_ops.search.return_value = result_obj
        mock_get.return_value = mock_ops

        from tools.file_tools import search_tool
        raw = search_tool(pattern="foo", offset=0, limit=50)
        assert "[Hint:" in raw
        assert "offset=50" in raw

    @patch("tools.file_tools._get_file_ops")
    def test_non_truncated_no_hint(self, mock_get):
        mock_ops = MagicMock()
        result_obj = MagicMock()
        result_obj.to_dict.return_value = {
            "total_count": 3,
            "matches": [{"path": "a.py", "line": 1, "content": "x"}] * 3,
        }
        mock_ops.search.return_value = result_obj
        mock_get.return_value = mock_ops

        from tools.file_tools import search_tool
        raw = search_tool(pattern="foo")
        assert "[Hint:" not in raw

    @patch("tools.file_tools._get_file_ops")
    def test_truncated_hint_with_nonzero_offset(self, mock_get):
        mock_ops = MagicMock()
        result_obj = MagicMock()
        result_obj.to_dict.return_value = {
            "total_count": 150,
            "matches": [{"path": "a.py", "line": 1, "content": "x"}] * 50,
            "truncated": True,
        }
        mock_ops.search.return_value = result_obj
        mock_get.return_value = mock_ops

        from tools.file_tools import search_tool
        raw = search_tool(pattern="foo", offset=50, limit=50)
        assert "[Hint:" in raw
        assert "offset=100" in raw


class TestPathJailValidate:
    """Phase 4 R3: validate_path_operation must clamp paths to safe_roots
    and respect the denied_paths override.
    """

    def test_no_safe_roots_means_no_jail(self):
        from tools.file_tools import validate_path_operation
        ok, reason = validate_path_operation("/etc/passwd", "read", [], [])
        assert ok is True
        assert reason == ""

    def test_path_inside_safe_root_allowed(self, tmp_path):
        from tools.file_tools import validate_path_operation
        target = tmp_path / "subdir" / "file.txt"
        target.parent.mkdir()
        target.write_text("hello")
        ok, _ = validate_path_operation(str(target), "read", [str(tmp_path)], [])
        assert ok is True

    def test_path_outside_safe_root_denied(self, tmp_path):
        from tools.file_tools import validate_path_operation
        ok, reason = validate_path_operation(
            "/etc/passwd", "read", [str(tmp_path)], [],
        )
        assert ok is False
        assert "safe_roots" in reason

    def test_denied_path_overrides_allow(self, tmp_path):
        from tools.file_tools import validate_path_operation
        env_file = tmp_path / ".env"
        env_file.write_text("SECRET=1")
        ok, reason = validate_path_operation(
            str(env_file), "read", [str(tmp_path)], [str(env_file)],
        )
        assert ok is False
        assert "denied" in reason

    def test_subpath_of_denied_root_denied(self, tmp_path):
        from tools.file_tools import validate_path_operation
        ssh_dir = tmp_path / "secrets"
        ssh_dir.mkdir()
        nested = ssh_dir / "id_rsa"
        nested.write_text("KEY")
        ok, _ = validate_path_operation(
            str(nested), "read", [str(tmp_path)], [str(ssh_dir)],
        )
        assert ok is False

    def test_write_to_nonexistent_file_in_safe_root_allowed(self, tmp_path):
        """write-before-create: parent exists and is in safe roots → allow."""
        from tools.file_tools import validate_path_operation
        target = tmp_path / "newfile.txt"  # does not exist yet
        ok, _ = validate_path_operation(str(target), "write", [str(tmp_path)], [])
        assert ok is True

    def test_write_to_deeply_nonexistent_walks_up(self, tmp_path):
        """nonexistent ancestors: walk up to nearest existing dir."""
        from tools.file_tools import validate_path_operation
        target = tmp_path / "a" / "b" / "c" / "newfile.txt"
        ok, _ = validate_path_operation(str(target), "write", [str(tmp_path)], [])
        assert ok is True

    def test_dot_dot_traversal_resolved(self, tmp_path):
        """`..` segments must be resolved before checking the safe root."""
        from tools.file_tools import validate_path_operation
        inside = tmp_path / "sub"
        inside.mkdir()
        # Path that traverses out: tmp_path/sub/../../etc/passwd
        traversal = str(inside / ".." / ".." / "etc" / "passwd")
        ok, _ = validate_path_operation(traversal, "read", [str(tmp_path)], [])
        assert ok is False, f"traversal {traversal} should escape safe root"

    def test_symlink_pointing_outside_safe_root_denied(self, tmp_path, monkeypatch):
        """A symlink under safe_roots that points OUTSIDE must be denied
        because canonicalization resolves through the link."""
        from tools.file_tools import validate_path_operation
        outside = tmp_path / "outside"
        outside.mkdir()
        outside_target = outside / "secret.txt"
        outside_target.write_text("nope")

        inside = tmp_path / "inside"
        inside.mkdir()
        link = inside / "link_to_secret"
        link.symlink_to(outside_target)

        # Safe root is `inside` only — but the symlink resolves to `outside`.
        ok, _ = validate_path_operation(str(link), "read", [str(inside)], [])
        assert ok is False, "symlink pivot from inside→outside must be denied"


class TestPathJailExtractor:
    """Verify extract_tool_call_paths produces the right (path, op) pairs
    for each LLM-callable tool the path-jail should clamp.
    """

    def test_read_file_extracts_path(self):
        from tools.file_tools import extract_tool_call_paths
        out = extract_tool_call_paths("read_file", {"path": "/foo/bar"})
        assert ("/foo/bar", "read") in out

    def test_write_file_extracts_path(self):
        from tools.file_tools import extract_tool_call_paths
        out = extract_tool_call_paths("write_file", {"path": "/foo/bar", "content": "x"})
        assert ("/foo/bar", "write") in out

    def test_patch_extracts_path(self):
        from tools.file_tools import extract_tool_call_paths
        out = extract_tool_call_paths(
            "patch",
            {"path": "/foo/bar", "old_string": "a", "new_string": "b"},
        )
        assert ("/foo/bar", "write") in out

    def test_search_files_extracts_path_default_dot(self):
        from tools.file_tools import extract_tool_call_paths
        out = extract_tool_call_paths("search_files", {"pattern": "foo"})
        assert (".", "read") in out

    def test_terminal_extracts_workdir_and_command_paths(self):
        from tools.file_tools import extract_tool_call_paths
        out = extract_tool_call_paths(
            "terminal",
            {"command": "cat /etc/passwd && ls /usr/bin", "workdir": "/tmp"},
        )
        ops = {(p, op) for p, op in out}
        assert ("/tmp", "exec") in ops
        assert ("/etc/passwd", "read") in ops
        assert ("/usr/bin", "read") in ops

    def test_terminal_extracts_tilde_path(self):
        from tools.file_tools import extract_tool_call_paths
        out = extract_tool_call_paths(
            "terminal",
            {"command": "cat ~/.ssh/config"},
        )
        paths = [p for p, _ in out]
        assert "~/.ssh/config" in paths

    def test_terminal_extracts_bare_root_slash(self):
        """Regression: `ls /` (or `cd /`, `find /`) must extract `/` so the
        path-jail can deny it. Verified live in the Phase 4 R3 deployment
        Discord probe — `ls /` slipped through entirely because the original
        regex required at least one character after `/`.
        """
        from tools.file_tools import extract_tool_call_paths
        for cmd in ("ls /", "cd /", "find / -name foo", "ls -la /"):
            out = extract_tool_call_paths("terminal", {"command": cmd})
            paths = [p for p, _ in out]
            assert "/" in paths, (
                f"command {cmd!r} did not extract bare root — extractor "
                f"returned {out}"
            )

    def test_terminal_extracts_bare_tilde_slash(self):
        """`cd ~/` and similar bare-tilde forms must also extract."""
        from tools.file_tools import extract_tool_call_paths
        out = extract_tool_call_paths("terminal", {"command": "ls ~/"})
        paths = [p for p, _ in out]
        assert "~/" in paths or any(p.startswith("~/") for p in paths)

    def test_bare_slash_denied_by_jail(self, tmp_path):
        """End-to-end: `terminal ls /` must be denied because `/` is not
        under any safe_root."""
        from tools.file_tools import (
            extract_tool_call_paths,
            validate_path_operation,
        )
        safe_roots = [str(tmp_path)]
        out = extract_tool_call_paths("terminal", {"command": "ls /"})
        # At least one extracted path should fail the safe-root check.
        any_denied = False
        for path, op in out:
            ok, _ = validate_path_operation(path, op, safe_roots, [])
            if not ok:
                any_denied = True
                break
        assert any_denied, (
            f"`ls /` did not produce any denied paths under safe_roots="
            f"{safe_roots}; extractor returned {out}"
        )

    def test_unknown_tool_returns_empty(self):
        from tools.file_tools import extract_tool_call_paths
        assert extract_tool_call_paths("vision_analyze", {"image": "foo.png"}) == []

    def test_non_dict_args_returns_empty(self):
        from tools.file_tools import extract_tool_call_paths
        assert extract_tool_call_paths("read_file", None) == []


class TestPathJailIntegration:
    """End-to-end through model_tools.handle_function_call: a denied path
    must NEVER reach the registered tool handler."""

    def test_read_file_to_denied_path_blocked(self, tmp_path, monkeypatch):
        """read_file targeting a denied path returns the jail error and
        does not invoke registry.dispatch."""
        from hermes_cli import config as cfg_mod
        cfg_mod.reset_path_jail_cache()
        monkeypatch.setattr(cfg_mod, "get_safe_roots", lambda: [str(tmp_path)])
        monkeypatch.setattr(cfg_mod, "get_denied_paths", lambda: ["/etc/passwd"])

        called = {}
        def fake_dispatch(*args, **kwargs):
            called["yes"] = True
            return json.dumps({"ok": True})

        import model_tools
        monkeypatch.setattr(model_tools.registry, "dispatch", fake_dispatch)

        result = model_tools.handle_function_call(
            "read_file",
            {"path": "/etc/passwd"},
            task_id="t1",
        )
        parsed = json.loads(result)
        assert "error" in parsed
        assert "Path jail denied" in parsed["error"]
        assert "yes" not in called, "dispatch was called even though jail denied"

    def test_read_file_inside_safe_root_passes(self, tmp_path, monkeypatch):
        from hermes_cli import config as cfg_mod
        cfg_mod.reset_path_jail_cache()
        monkeypatch.setattr(cfg_mod, "get_safe_roots", lambda: [str(tmp_path)])
        monkeypatch.setattr(cfg_mod, "get_denied_paths", lambda: [])

        target = tmp_path / "ok.txt"
        target.write_text("hello")

        def fake_dispatch(*args, **kwargs):
            return json.dumps({"content": "hello", "total_lines": 1})

        import model_tools
        monkeypatch.setattr(model_tools.registry, "dispatch", fake_dispatch)

        result = model_tools.handle_function_call(
            "read_file",
            {"path": str(target)},
            task_id="t1",
        )
        parsed = json.loads(result)
        assert parsed.get("content") == "hello"

    def test_terminal_workdir_outside_safe_root_blocked(self, tmp_path, monkeypatch):
        from hermes_cli import config as cfg_mod
        cfg_mod.reset_path_jail_cache()
        monkeypatch.setattr(cfg_mod, "get_safe_roots", lambda: [str(tmp_path)])
        monkeypatch.setattr(cfg_mod, "get_denied_paths", lambda: [])

        def fake_dispatch(*args, **kwargs):
            return json.dumps({"output": "should not run", "exit_code": 0})

        import model_tools
        monkeypatch.setattr(model_tools.registry, "dispatch", fake_dispatch)

        result = model_tools.handle_function_call(
            "terminal",
            {"command": "ls", "workdir": "/"},
            task_id="t1",
        )
        parsed = json.loads(result)
        assert "error" in parsed
        assert "Path jail" in parsed["error"]

    def test_jail_no_op_when_safe_roots_empty(self, tmp_path, monkeypatch):
        """Empty safe_roots = no jail; the tool dispatches normally."""
        from hermes_cli import config as cfg_mod
        cfg_mod.reset_path_jail_cache()
        monkeypatch.setattr(cfg_mod, "get_safe_roots", lambda: [])
        monkeypatch.setattr(cfg_mod, "get_denied_paths", lambda: [])

        def fake_dispatch(*args, **kwargs):
            return json.dumps({"content": "anything"})

        import model_tools
        monkeypatch.setattr(model_tools.registry, "dispatch", fake_dispatch)

        result = model_tools.handle_function_call(
            "read_file",
            {"path": "/etc/passwd"},
            task_id="t1",
        )
        parsed = json.loads(result)
        assert parsed.get("content") == "anything"


