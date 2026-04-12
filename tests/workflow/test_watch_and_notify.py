"""Tests for Harness B: watch-and-notify workflow."""

import pytest
from unittest.mock import patch

from hermes_state import SessionDB
from workflow.engine import run_workflow
from workflow.harnesses.watch_and_notify import (
    WORKFLOW,
    detect_change,
    classify_change,
    act_on_change,
)


@pytest.fixture()
def db(tmp_path):
    db_path = tmp_path / "test_state.db"
    sdb = SessionDB(db_path=db_path)
    yield sdb
    sdb.close()


# ---------------------------------------------------------------------------
# Step 1: detect_change
# ---------------------------------------------------------------------------

class TestDetectChange:
    def test_extracts_metadata(self):
        ctx = {"trigger_meta": {"path": "/home/user/brain/00_Inbox/note.md", "event_type": "created"}}
        result = detect_change(ctx)
        assert result["path"] == "/home/user/brain/00_Inbox/note.md"
        assert result["event_type"] == "created"
        assert result["filename"] == "note.md"
        assert result["extension"] == ".md"

    def test_no_path_raises(self):
        with pytest.raises(ValueError, match="No path"):
            detect_change({"trigger_meta": {}})

    def test_python_file(self):
        ctx = {"trigger_meta": {"path": "/home/user/Projects/app/main.py", "event_type": "modified"}}
        result = detect_change(ctx)
        assert result["extension"] == ".py"


# ---------------------------------------------------------------------------
# Step 2: classify_change
# ---------------------------------------------------------------------------

class TestClassifyChange:
    def test_new_note_in_inbox(self):
        ctx = {"detect_change": {
            "path": "/home/user/brain/00_Inbox/idea.md",
            "event_type": "created",
            "extension": ".md",
            "filename": "idea.md",
        }}
        result = classify_change(ctx)
        assert result["classification"] == "new_note"
        assert result["priority"] == "medium"

    def test_note_deleted_from_inbox(self):
        ctx = {"detect_change": {
            "path": "/home/user/brain/00_Inbox/old.md",
            "event_type": "deleted",
            "extension": ".md",
            "filename": "old.md",
        }}
        result = classify_change(ctx)
        assert result["classification"] == "note_deleted"
        assert result["priority"] == "low"

    def test_note_modified_in_inbox(self):
        ctx = {"detect_change": {
            "path": "/home/user/brain/00_Inbox/draft.md",
            "event_type": "modified",
            "extension": ".md",
            "filename": "draft.md",
        }}
        result = classify_change(ctx)
        assert result["classification"] == "note_modified"

    def test_project_note(self):
        ctx = {"detect_change": {
            "path": "/home/user/brain/01_Projects/hermes.md",
            "event_type": "created",
            "extension": ".md",
            "filename": "hermes.md",
        }}
        result = classify_change(ctx)
        assert result["classification"] == "project_note"
        assert result["priority"] == "medium"

    def test_python_code_change(self):
        ctx = {"detect_change": {
            "path": "/home/user/Projects/app/main.py",
            "event_type": "modified",
            "extension": ".py",
            "filename": "main.py",
        }}
        result = classify_change(ctx)
        assert result["classification"] == "code_change"
        assert result["priority"] == "low"

    def test_typescript_code_change(self):
        ctx = {"detect_change": {
            "path": "/home/user/Projects/app/App.tsx",
            "event_type": "modified",
            "extension": ".tsx",
            "filename": "App.tsx",
        }}
        result = classify_change(ctx)
        assert result["classification"] == "code_change"

    def test_file_deleted_in_projects(self):
        ctx = {"detect_change": {
            "path": "/home/user/Projects/app/old.txt",
            "event_type": "deleted",
            "extension": ".txt",
            "filename": "old.txt",
        }}
        result = classify_change(ctx)
        assert result["classification"] == "file_deleted"

    def test_unknown_file_gets_default(self):
        ctx = {"detect_change": {
            "path": "/home/user/random/file.xyz",
            "event_type": "modified",
            "extension": ".xyz",
            "filename": "file.xyz",
        }}
        result = classify_change(ctx)
        assert result["classification"] == "file_change"
        assert result["priority"] == "low"


# ---------------------------------------------------------------------------
# Step 3: act_on_change
# ---------------------------------------------------------------------------

class TestActOnChange:
    @patch("workflow.harnesses.watch_and_notify._event_publish")
    def test_low_priority_event_bus_only(self, mock_pub):
        ctx = {
            "detect_change": {"path": "/p/f.py", "event_type": "modified"},
            "classify_change": {"classification": "code_change", "priority": "low", "description": "test"},
        }
        result = act_on_change(ctx)
        assert result["channels"] == ["event_bus"]
        assert "discord" not in result["channels"]

    @patch("workflow.harnesses.watch_and_notify._event_publish")
    def test_medium_priority_includes_discord(self, mock_pub):
        ctx = {
            "detect_change": {"path": "/p/f.md", "event_type": "created"},
            "classify_change": {"classification": "new_note", "priority": "medium", "description": "test"},
        }
        result = act_on_change(ctx)
        assert "discord" in result["channels"]
        assert "event_bus" in result["channels"]


# ---------------------------------------------------------------------------
# Path safety (defense-in-depth)
# ---------------------------------------------------------------------------

class TestPathSafety:
    def test_denied_path_blocked(self):
        """Denied path returns blocked flag."""
        ctx = {"trigger_meta": {"path": "/secret/data.txt", "event_type": "modified"}}
        with (
            patch("hermes_cli.config.get_safe_roots", return_value=["/allowed"]),
            patch("hermes_cli.config.get_denied_paths", return_value=[]),
            patch("tools.file_tools.validate_path_operation", return_value=(False, "not under safe roots")),
        ):
            result = detect_change(ctx)
        assert result["blocked"] is True

    def test_allowed_path_passes(self):
        """Allowed path proceeds normally."""
        ctx = {"trigger_meta": {"path": "/home/user/brain/note.md", "event_type": "created"}}
        with (
            patch("hermes_cli.config.get_safe_roots", return_value=["/home/user"]),
            patch("hermes_cli.config.get_denied_paths", return_value=[]),
            patch("tools.file_tools.validate_path_operation", return_value=(True, "")),
        ):
            result = detect_change(ctx)
        assert result["blocked"] is False
        assert result["filename"] == "note.md"

    @patch("workflow.engine._publish")
    @patch("workflow.harnesses.watch_and_notify._event_publish")
    def test_blocked_skips_notification(self, mock_wn_pub, mock_engine_pub, db):
        """Full pipeline with blocked path skips Discord notification."""
        trigger_meta = {
            "path": "/secret/data.txt",
            "event_type": "modified",
            "timestamp": 1712880000.0,
        }
        with (
            patch("hermes_cli.config.get_safe_roots", return_value=["/allowed"]),
            patch("hermes_cli.config.get_denied_paths", return_value=[]),
            patch("tools.file_tools.validate_path_operation", return_value=(False, "denied")),
        ):
            result = run_workflow(WORKFLOW, trigger_meta=trigger_meta, db=db)

        assert result.status == "completed"
        act_output = result.steps[2].output
        assert act_output["action"] == "blocked"
        assert act_output["channels"] == []


# ---------------------------------------------------------------------------
# End-to-end
# ---------------------------------------------------------------------------

class TestEndToEnd:
    @patch("workflow.engine._publish")
    @patch("workflow.harnesses.watch_and_notify._event_publish")
    def test_full_pipeline(self, mock_wn_pub, mock_engine_pub, db):
        trigger_meta = {
            "path": "/home/user/brain/00_Inbox/new-idea.md",
            "event_type": "created",
            "timestamp": 1712880000.0,
        }
        result = run_workflow(WORKFLOW, trigger_meta=trigger_meta, db=db)

        assert result.status == "completed"
        assert len(result.steps) == 3
        assert all(s.status == "completed" for s in result.steps)

        # Check classification was correct
        classify_output = result.steps[1].output
        assert classify_output["classification"] == "new_note"
        assert classify_output["priority"] == "medium"

        # Check action routed to discord
        act_output = result.steps[2].output
        assert "discord" in act_output["channels"]

        # Check DB state
        run = db.get_workflow_run(result.run_id)
        assert run["status"] == "completed"
        assert len(run["checkpoints"]) == 3

    @patch("workflow.engine._publish")
    @patch("workflow.harnesses.watch_and_notify._event_publish")
    def test_low_priority_no_discord(self, mock_wn_pub, mock_engine_pub, db):
        trigger_meta = {
            "path": "/home/user/Projects/app/main.py",
            "event_type": "modified",
            "timestamp": 1712880000.0,
        }
        result = run_workflow(WORKFLOW, trigger_meta=trigger_meta, db=db)

        assert result.status == "completed"
        act_output = result.steps[2].output
        assert act_output["channels"] == ["event_bus"]
