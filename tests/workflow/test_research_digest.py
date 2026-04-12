"""Tests for the research-digest workflow harness."""

import json
import os
import pytest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch, MagicMock

from hermes_state import SessionDB
from workflow.engine import run_workflow
from workflow.harnesses.research_digest import (
    WORKFLOW,
    fetch_sources,
    compile_digest,
    deliver,
    _fetch_hn,
    _fetch_arxiv,
    _fetch_github_trending,
    _HN_MAX_CAP,
)

_CONFIG_PATCH = "hermes_cli.config.load_config"
_HTTPX_PATCH = "workflow.harnesses.research_digest.httpx.Client"
_HOME_PATCH = "pathlib.Path.home"
_SAFE_ROOTS_PATCH = "hermes_cli.config.get_safe_roots"
_DENIED_PATHS_PATCH = "hermes_cli.config.get_denied_paths"

# Sample arXiv XML response
_ARXIV_XML = """\
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2026.12345v1</id>
    <title>A Novel Approach to LLM Reasoning</title>
    <summary>We present a new method for improving reasoning in large language models using chain-of-thought prompting with verification steps.</summary>
    <author><name>Alice Smith</name></author>
    <author><name>Bob Jones</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2026.67890v1</id>
    <title>Scaling Laws for
    Multimodal Models</title>
    <summary>This paper explores scaling behavior across vision-language architectures.</summary>
    <author><name>Carol Lee</name></author>
  </entry>
</feed>
"""

# Sample arXiv XML with malicious XXE attempt
_ARXIV_XML_XXE = """\
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE feed [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2026.99999v1</id>
    <title>&xxe;</title>
    <summary>Malicious</summary>
    <author><name>Evil</name></author>
  </entry>
</feed>
"""


@pytest.fixture()
def db(tmp_path):
    db_path = tmp_path / "test_state.db"
    sdb = SessionDB(db_path=db_path)
    yield sdb
    sdb.close()


def _mock_httpx_client(responses_by_url=None):
    """Create a mock httpx.Client context manager."""
    responses_by_url = responses_by_url or {}

    def mock_get(url, **kwargs):
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.status_code = 200

        for pattern, data in responses_by_url.items():
            if pattern in url:
                if isinstance(data, str):
                    resp.text = data
                    resp.json.return_value = None
                else:
                    resp.json.return_value = data
                    resp.text = json.dumps(data)
                return resp

        resp.json.return_value = {}
        resp.text = ""
        return resp

    client = MagicMock()
    client.get = mock_get
    client.__enter__ = lambda s: client
    client.__exit__ = lambda s, *a: None
    return client


# ---------------------------------------------------------------------------
# Step 1: fetch_sources
# ---------------------------------------------------------------------------

class TestFetchHN:
    @patch(_HTTPX_PATCH)
    def test_fetches_top_n_stories(self, mock_client_cls):
        client = _mock_httpx_client({
            "topstories": [1, 2, 3, 4, 5],
            "item/1": {"id": 1, "title": "Story 1", "url": "https://example.com/1", "score": 100, "by": "user1"},
            "item/2": {"id": 2, "title": "Story 2", "url": "https://example.com/2", "score": 80, "by": "user2"},
            "item/3": {"id": 3, "title": "Story 3", "url": "https://example.com/3", "score": 60, "by": "user3"},
        })
        mock_client_cls.return_value = client

        stories = _fetch_hn(3)
        assert len(stories) == 3
        assert stories[0]["title"] == "Story 1"
        assert stories[0]["score"] == 100

    @patch(_HTTPX_PATCH)
    def test_handles_missing_url(self, mock_client_cls):
        client = _mock_httpx_client({
            "topstories": [42],
            "item/42": {"id": 42, "title": "No URL", "score": 10, "by": "anon"},
        })
        mock_client_cls.return_value = client

        stories = _fetch_hn(1)
        assert len(stories) == 1
        assert "news.ycombinator.com" in stories[0]["url"]


class TestFetchArxiv:
    @patch(_HTTPX_PATCH)
    def test_parses_xml(self, mock_client_cls):
        client = _mock_httpx_client({"export.arxiv.org": _ARXIV_XML})
        mock_client_cls.return_value = client

        papers = _fetch_arxiv(["cs.AI"], 10)
        assert len(papers) == 2
        assert papers[0]["title"] == "A Novel Approach to LLM Reasoning"
        assert "Alice Smith" in papers[0]["authors"]
        assert papers[0]["arxiv_id"] == "2026.12345v1"

    @patch(_HTTPX_PATCH)
    def test_multiline_title_cleaned(self, mock_client_cls):
        client = _mock_httpx_client({"export.arxiv.org": _ARXIV_XML})
        mock_client_cls.return_value = client

        papers = _fetch_arxiv(["cs.LG"], 10)
        # Second paper has a title with embedded newline
        assert "\n" not in papers[1]["title"]
        assert "Scaling Laws for" in papers[1]["title"]

    @patch(_HTTPX_PATCH)
    def test_xxe_blocked(self, mock_client_cls):
        """defusedxml should reject XXE entity declarations."""
        client = _mock_httpx_client({"export.arxiv.org": _ARXIV_XML_XXE})
        mock_client_cls.return_value = client

        with pytest.raises(Exception):
            _fetch_arxiv(["cs.AI"], 10)


class TestFetchGitHub:
    @patch(_HTTPX_PATCH)
    def test_fetches_trending(self, mock_client_cls):
        client = _mock_httpx_client({
            "search/repositories": {
                "items": [
                    {
                        "full_name": "cool/project",
                        "description": "A cool project",
                        "stargazers_count": 500,
                        "language": "Python",
                        "html_url": "https://github.com/cool/project",
                    }
                ]
            }
        })
        mock_client_cls.return_value = client

        repos = _fetch_github_trending()
        assert len(repos) == 1
        assert repos[0]["full_name"] == "cool/project"
        assert repos[0]["stars"] == 500


class TestFetchSources:
    @patch(_HTTPX_PATCH)
    def test_partial_source_failure(self, mock_client_cls):
        """One source erroring doesn't abort the others."""
        call_count = 0

        def mock_get(url, **kwargs):
            nonlocal call_count
            call_count += 1
            resp = MagicMock()
            resp.raise_for_status = MagicMock()

            if "hacker-news" in url:
                raise ConnectionError("HN down")
            elif "arxiv" in url:
                resp.text = _ARXIV_XML
                return resp
            elif "github.com" in url:
                resp.json.return_value = {"items": []}
                return resp

            resp.json.return_value = {}
            return resp

        client = MagicMock()
        client.get = mock_get
        client.__enter__ = lambda s: client
        client.__exit__ = lambda s, *a: None
        mock_client_cls.return_value = client

        with patch(_CONFIG_PATCH, return_value={"workflows": {"research_digest": {}}}):
            result = fetch_sources({})

        assert len(result["errors"]) >= 1
        assert "HN" in result["errors"][0]
        assert len(result["arxiv"]) == 2  # arXiv still worked

    @patch(_HTTPX_PATCH)
    def test_all_sources_fail_raises(self, mock_client_cls):
        """If every source errors, step raises RuntimeError."""
        def mock_get(url, **kwargs):
            raise ConnectionError("Everything is down")

        client = MagicMock()
        client.get = mock_get
        client.__enter__ = lambda s: client
        client.__exit__ = lambda s, *a: None
        mock_client_cls.return_value = client

        with patch(_CONFIG_PATCH, return_value={"workflows": {"research_digest": {}}}):
            with pytest.raises(RuntimeError, match="All sources failed"):
                fetch_sources({})

    def test_config_hn_top_n_capped(self):
        """hn_top_n respects hard cap."""
        config = {"workflows": {"research_digest": {"hn_top_n": 100}}}
        with (
            patch(_CONFIG_PATCH, return_value=config),
            patch("workflow.harnesses.research_digest._fetch_hn", return_value=[]) as mock_hn,
            patch("workflow.harnesses.research_digest._fetch_arxiv", return_value=[]),
            patch("workflow.harnesses.research_digest._fetch_github_trending", return_value=[]),
        ):
            fetch_sources({})
            mock_hn.assert_called_once_with(_HN_MAX_CAP)

    def test_source_disable_via_config(self):
        """Setting hn_top_n: 0, arxiv_categories: [], github_trending: false skips those."""
        config = {"workflows": {"research_digest": {
            "hn_top_n": 0,
            "arxiv_categories": [],
            "github_trending": False,
        }}}
        with patch(_CONFIG_PATCH, return_value=config):
            # All disabled, no errors — just empty
            result = fetch_sources({})
        assert result["hn"] == []
        assert result["arxiv"] == []
        assert result["github"] == []
        assert result["errors"] == []


# ---------------------------------------------------------------------------
# Step 2: compile_digest
# ---------------------------------------------------------------------------

class TestCompileDigest:
    def test_formats_all_sections(self):
        ctx = {"fetch_sources": {
            "hn": [{"title": "Cool HN Story", "url": "https://hn.com/1", "score": 42, "by": "user1"}],
            "arxiv": [{"title": "A Paper", "authors": ["Alice"], "arxiv_id": "2026.1", "summary": "Abstract text", "url": "https://arxiv.org/abs/2026.1"}],
            "github": [{"full_name": "o/r", "description": "Desc", "stars": 100, "language": "Rust", "url": "https://github.com/o/r"}],
            "errors": [],
        }}
        result = compile_digest(ctx)
        md = result["digest_md"]

        assert "# Research Digest" in md
        assert "## Hacker News Top Stories" in md
        assert "Cool HN Story" in md
        assert "42 pts" in md
        assert "## arXiv Papers" in md
        assert "A Paper" in md
        assert "## GitHub Trending" in md
        assert "o/r" in md
        assert "100 stars" in md

    def test_frontmatter_present(self):
        ctx = {"fetch_sources": {"hn": [], "arxiv": [], "github": [], "errors": []}}
        result = compile_digest(ctx)
        assert result["digest_md"].startswith("---\ntags:")
        assert "research-digest" in result["digest_md"]
        assert "hermes-generated" in result["digest_md"]

    def test_empty_sources_still_valid(self):
        ctx = {"fetch_sources": {"hn": [], "arxiv": [], "github": [], "errors": []}}
        result = compile_digest(ctx)
        assert "# Research Digest" in result["digest_md"]
        assert result["source_counts"] == {"hn": 0, "arxiv": 0, "github": 0}

    def test_errors_section_shown(self):
        ctx = {"fetch_sources": {
            "hn": [], "arxiv": [], "github": [],
            "errors": ["HN: connection refused"],
        }}
        result = compile_digest(ctx)
        assert "## Source Errors" in result["digest_md"]
        assert "HN: connection refused" in result["digest_md"]


# ---------------------------------------------------------------------------
# Step 3: deliver
# ---------------------------------------------------------------------------

class TestDeliver:
    def test_writes_vault_note(self, tmp_path):
        ctx = {"compile_digest": {
            "digest_md": "# Test digest",
            "source_counts": {"hn": 1, "arxiv": 0, "github": 0},
        }}
        with patch(_HOME_PATCH, return_value=tmp_path):
            result = deliver(ctx)

        assert "vault" in result["delivered_to"]
        notes = list((tmp_path / "brain" / "00_Inbox").glob("research-digest-*.md"))
        assert len(notes) == 1
        assert notes[0].read_text() == "# Test digest"

    def test_path_jail_blocks(self):
        ctx = {"compile_digest": {
            "digest_md": "# Blocked",
            "source_counts": {"hn": 0, "arxiv": 0, "github": 0},
        }}
        with (
            patch(_SAFE_ROOTS_PATCH, return_value=["/allowed"]),
            patch(_DENIED_PATHS_PATCH, return_value=[]),
            patch("tools.file_tools.validate_path_operation", return_value=(False, "not under safe roots")),
        ):
            result = deliver(ctx)
        assert "vault" not in result["delivered_to"]

    def test_vault_dir_from_config(self, tmp_path):
        ctx = {"compile_digest": {
            "digest_md": "# Custom dir",
            "source_counts": {"hn": 0, "arxiv": 0, "github": 0},
        }}
        custom_dir = tmp_path / "custom_vault"
        with (
            patch(_HOME_PATCH, return_value=tmp_path),
            patch(_CONFIG_PATCH, return_value={
                "workflows": {"research_digest": {"vault_dir": str(custom_dir)}}
            }),
        ):
            result = deliver(ctx)

        assert "vault" in result["delivered_to"]
        notes = list(custom_dir.glob("research-digest-*.md"))
        assert len(notes) == 1


# ---------------------------------------------------------------------------
# Harness registration
# ---------------------------------------------------------------------------

class TestRegistration:
    def test_harness_registered(self):
        from workflow.harnesses import get_harness
        wf = get_harness("research-digest")
        assert wf.id == "research-digest"
        assert wf.name == "Research Digest"
        assert len(wf.steps) == 3


# ---------------------------------------------------------------------------
# End-to-end via workflow engine
# ---------------------------------------------------------------------------

class TestEndToEnd:
    @patch("workflow.engine._publish")
    @patch(_HTTPX_PATCH)
    @patch(_CONFIG_PATCH)
    @patch(_HOME_PATCH)
    def test_full_pipeline(self, mock_home, mock_config, mock_client_cls, mock_pub, db, tmp_path):
        mock_home.return_value = tmp_path
        mock_config.return_value = {"workflows": {"research_digest": {"hn_top_n": 2}}}

        client = _mock_httpx_client({
            "topstories": [1, 2],
            "item/1": {"id": 1, "title": "Story 1", "url": "https://ex.com/1", "score": 50, "by": "u1"},
            "item/2": {"id": 2, "title": "Story 2", "url": "https://ex.com/2", "score": 40, "by": "u2"},
            "export.arxiv.org": _ARXIV_XML,
            "search/repositories": {"items": []},
        })
        mock_client_cls.return_value = client

        result = run_workflow(WORKFLOW, trigger_meta={"cron_job_id": "test"}, db=db)

        assert result.status == "completed"
        assert len(result.steps) == 3
        assert all(s.status == "completed" for s in result.steps)

        # Check DB
        run = db.get_workflow_run(result.run_id)
        assert run["status"] == "completed"
        assert len(run["checkpoints"]) == 3

        # Check vault note
        notes = list((tmp_path / "brain" / "00_Inbox").glob("research-digest-*.md"))
        assert len(notes) == 1
        content = notes[0].read_text()
        assert "Story 1" in content
        assert "LLM Reasoning" in content
