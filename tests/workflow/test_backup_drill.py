"""Tests for the backup-drill workflow harness."""

import os
import shutil
import sqlite3
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
import yaml


class TestCreateBackup:
    """Tests for the create_backup step."""

    def test_creates_backup_zip(self, tmp_path):
        """Verify the step produces a zip file."""
        from workflow.harnesses.backup_drill import create_backup

        # Create a fake hermes home
        hermes_home = tmp_path / ".hermes"
        hermes_home.mkdir()
        (hermes_home / "config.yaml").write_text("model:\n  provider: custom\n")
        (hermes_home / "skills").mkdir()
        (hermes_home / "memories").mkdir()

        # Create a small state.db
        db_path = hermes_home / "state.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE test (id INTEGER PRIMARY KEY)")
        conn.execute("INSERT INTO test VALUES (1)")
        conn.commit()
        conn.close()

        with patch("hermes_constants.get_default_hermes_root", return_value=hermes_home):
            # Mock run_backup to create a real zip
            def fake_run_backup(args):
                out = Path(args.output)
                with zipfile.ZipFile(out, "w") as zf:
                    for f in hermes_home.rglob("*"):
                        if f.is_file():
                            zf.write(f, arcname=str(f.relative_to(hermes_home)))

            with patch("hermes_cli.backup.run_backup", side_effect=fake_run_backup):
                result = create_backup({})

        assert "backup_path" in result
        assert result["file_count"] > 0
        assert result["size_mb"] >= 0
        assert Path(result["backup_path"]).exists()

        # Cleanup
        shutil.rmtree(result["tmp_dir"], ignore_errors=True)


class TestRestoreAndValidate:
    """Tests for the restore_and_validate step."""

    def _make_backup_zip(self, tmp_path, corrupt_db=False, skip_config=False, skip_skills=False):
        """Create a test backup zip with known contents."""
        zip_path = tmp_path / "test-backup.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            # config.yaml
            if not skip_config:
                zf.writestr("config.yaml", "model:\n  provider: custom\n")

            # state.db
            db_tmp = tmp_path / "state.db"
            conn = sqlite3.connect(str(db_tmp))
            conn.execute("CREATE TABLE test (id INTEGER PRIMARY KEY)")
            conn.execute("INSERT INTO test VALUES (1)")
            conn.commit()
            conn.close()
            if corrupt_db:
                # Corrupt the DB file
                with open(db_tmp, "r+b") as f:
                    f.seek(0)
                    f.write(b"CORRUPTED" * 10)
            zf.write(db_tmp, arcname="state.db")

            # Directories (zip needs at least one file per dir)
            if not skip_skills:
                zf.writestr("skills/.gitkeep", "")
            zf.writestr("memories/.gitkeep", "")

        return str(zip_path)

    def test_valid_backup_passes(self, tmp_path):
        from workflow.harnesses.backup_drill import restore_and_validate

        zip_path = self._make_backup_zip(tmp_path)
        ctx = {"create_backup": {"backup_path": zip_path}}
        result = restore_and_validate(ctx)

        assert result["valid"] is True
        assert len(result["errors"]) == 0
        assert any(c["name"] == "config_parseable" and c["passed"] for c in result["checks"])

    def test_missing_config_fails(self, tmp_path):
        from workflow.harnesses.backup_drill import restore_and_validate

        zip_path = self._make_backup_zip(tmp_path, skip_config=True)
        ctx = {"create_backup": {"backup_path": zip_path}}
        result = restore_and_validate(ctx)

        assert result["valid"] is False
        assert any("config.yaml" in e for e in result["errors"])

    def test_corrupt_db_fails(self, tmp_path):
        from workflow.harnesses.backup_drill import restore_and_validate

        zip_path = self._make_backup_zip(tmp_path, corrupt_db=True)
        ctx = {"create_backup": {"backup_path": zip_path}}
        result = restore_and_validate(ctx)

        assert result["valid"] is False
        assert any("integrity" in e.lower() or "state.db" in e for e in result["errors"])

    def test_missing_skills_dir_fails(self, tmp_path):
        from workflow.harnesses.backup_drill import restore_and_validate

        zip_path = self._make_backup_zip(tmp_path, skip_skills=True)
        ctx = {"create_backup": {"backup_path": zip_path}}
        result = restore_and_validate(ctx)

        assert result["valid"] is False
        assert any("skills" in e for e in result["errors"])

    def test_missing_backup_file_raises(self):
        from workflow.harnesses.backup_drill import restore_and_validate

        ctx = {"create_backup": {"backup_path": "/nonexistent/backup.zip"}}
        with pytest.raises(RuntimeError, match="not found"):
            restore_and_validate(ctx)


class TestReport:
    """Tests for the report step."""

    def test_passing_report(self):
        from workflow.harnesses.backup_drill import report

        ctx = {
            "create_backup": {"size_mb": 1.5, "file_count": 42, "tmp_dir": None},
            "restore_and_validate": {
                "valid": True,
                "checks": [{"name": "config_parseable", "passed": True}],
                "errors": [],
            },
        }
        result = report(ctx)
        assert result["passed"] is True
        assert "PASS" in result["summary"]
        assert result["error_count"] == 0

    def test_failing_report(self):
        from workflow.harnesses.backup_drill import report

        ctx = {
            "create_backup": {"size_mb": 1.5, "file_count": 42, "tmp_dir": None},
            "restore_and_validate": {
                "valid": False,
                "checks": [{"name": "state_db_integrity", "passed": False, "error": "corruption"}],
                "errors": ["state.db corruption"],
            },
        }
        result = report(ctx)
        assert result["passed"] is False
        assert "FAIL" in result["summary"]
        assert result["error_count"] == 1


class TestWorkflowDefinition:
    """Tests for the workflow definition."""

    def test_workflow_registered(self):
        from workflow.harnesses import get_harness
        wf = get_harness("backup-drill")
        assert wf.id == "backup-drill"
        assert wf.name == "Backup/Restore Drill"
        assert len(wf.steps) == 3

    def test_step_names(self):
        from workflow.harnesses import get_harness
        wf = get_harness("backup-drill")
        names = [s.name for s in wf.steps]
        assert names == ["create_backup", "restore_and_validate", "report"]
