"""Tests for the secret/PII redaction helper.

This module guards `tools/redaction.py` — the function applied at the
dashboard API boundary (and to event-bus emit previews) to keep
transcripts, tool args, and memory entries from leaking secrets when
they're surfaced in the brain visualization.

Patterns matter in two ways:
1. Positive: real secrets get marked as `[REDACTED:<KIND>]`.
2. Negative: ordinary prose passes through unchanged.

If a new secret class is added to `_REDACTION_PATTERNS`, add positive +
negative cases here.
"""

from tools.redaction import redact_text


class TestGitHubPATs:
    def test_ghp_token(self):
        s = "my token is ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        out = redact_text(s)
        assert "ghp_" not in out
        assert "[REDACTED:GH_PAT]" in out

    def test_github_pat_v2(self):
        token = "github_pat_" + "A" * 82
        s = f"export GH={token}"
        out = redact_text(s)
        assert token not in out
        assert "[REDACTED:GH_PAT]" in out

    def test_ghp_in_quoted_string(self):
        s = '"GITHUB_TOKEN": "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'
        out = redact_text(s)
        assert "ghp_" not in out


class TestOpenAIKeys:
    def test_legacy_sk_key(self):
        s = "OPENAI_API_KEY=sk-abc123abc123abc123abc123abc123ab"
        out = redact_text(s)
        assert "sk-abc123" not in out
        # The env-var pattern fires first → ENV_VAR; either is acceptable
        assert "[REDACTED:" in out

    def test_project_scoped_key(self):
        s = "key: sk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGH"
        out = redact_text(s)
        assert "sk-proj-" not in out


class TestAnthropicKeys:
    def test_anthropic_key(self):
        s = "ANTHROPIC=sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"
        out = redact_text(s)
        assert "sk-ant-" not in out


class TestDiscordWebhook:
    def test_webhook_url(self):
        s = "POST https://discord.com/api/webhooks/123456789/abcDEF-ghi_jkl"
        out = redact_text(s)
        assert "discord.com/api/webhooks" not in out
        assert "[REDACTED:DISCORD_WEBHOOK]" in out

    def test_discordapp_legacy_url(self):
        s = "https://discordapp.com/api/webhooks/999/zzz-yyy"
        out = redact_text(s)
        assert "[REDACTED:DISCORD_WEBHOOK]" in out


class TestTelegramToken:
    def test_bot_token(self):
        s = "TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789"
        out = redact_text(s)
        # Either env-var or telegram pattern wins; the key thing is it's gone
        assert "ABCdefGHI" not in out


class TestSlackToken:
    def test_xoxb_token(self):
        s = "slack: xoxb-1234567890-abcdefghijklmnopqrst"
        out = redact_text(s)
        assert "xoxb-" not in out
        assert "[REDACTED:SLACK_TOKEN]" in out


class TestAWSKey:
    def test_aws_access_key_id(self):
        s = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"
        out = redact_text(s)
        assert "AKIAIOSFODNN7EXAMPLE" not in out


class TestJWT:
    def test_jwt(self):
        s = (
            "Authorization: eyJhbGciOiJIUzI1NiJ9."
            "eyJzdWIiOiIxMjM0NTY3ODkwIn0."
            "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        )
        out = redact_text(s)
        assert "eyJ" not in out
        # Either JWT or BEARER fires
        assert "[REDACTED:" in out


class TestPEMBlock:
    def test_rsa_private_key(self):
        block = (
            "-----BEGIN RSA PRIVATE KEY-----\n"
            "MIIEpAIBAAKCAQEA1234567890\n"
            "abcdefghijklmnopqrstuvwxyz\n"
            "-----END RSA PRIVATE KEY-----"
        )
        s = f"key:\n{block}\nend"
        out = redact_text(s)
        assert "BEGIN RSA PRIVATE KEY" not in out
        assert "[REDACTED:PEM_BLOCK]" in out

    def test_openssh_private_key(self):
        block = (
            "-----BEGIN OPENSSH PRIVATE KEY-----\n"
            "b3BlbnNzaC1rZXktdjEAAAAA\n"
            "-----END OPENSSH PRIVATE KEY-----"
        )
        out = redact_text(block)
        assert "[REDACTED:PEM_BLOCK]" in out
        assert "BEGIN OPENSSH" not in out


class TestEmail:
    def test_basic_email(self):
        s = "contact me at maxwell@example.com please"
        out = redact_text(s)
        assert "maxwell@example.com" not in out
        assert "[REDACTED:EMAIL]" in out

    def test_email_with_plus(self):
        s = "alias: foo+tag@bar.co.uk"
        out = redact_text(s)
        assert "@" not in out


class TestPhone:
    def test_basic_phone(self):
        s = "call me at 415-555-1234 anytime"
        out = redact_text(s)
        assert "415-555-1234" not in out
        assert "[REDACTED:PHONE]" in out

    def test_parenthesized_phone(self):
        s = "(415) 555 1234 is my number"
        out = redact_text(s)
        assert "555 1234" not in out


class TestEnvVarShape:
    def test_env_var_secret(self):
        s = "MY_SECRET_TOKEN=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
        out = redact_text(s)
        assert "AbCdEfGhIj" not in out
        assert "[REDACTED:" in out


class TestNegativePassthrough:
    """These plain texts must NOT be redacted."""

    def test_plain_text(self):
        s = "This is a normal sentence with no secrets."
        assert redact_text(s) == s

    def test_short_alphanum(self):
        s = "user_id_abc123"
        assert redact_text(s) == s

    def test_session_id_shape(self):
        s = "20260411_abc12345"
        assert redact_text(s) == s

    def test_short_env_var_below_threshold(self):
        # Env-var pattern requires {20,} value chars; shorter is fine
        s = "DEBUG=true"
        assert redact_text(s) == s

    def test_function_call(self):
        s = "calling MemoryStore.load_from_disk()"
        assert redact_text(s) == s


class TestLengthCap:
    def test_truncates_long_input(self):
        # 20K chars of safe content
        s = "x" * 20000
        out = redact_text(s, max_chars=16384)
        assert len(out) < 20000
        assert out.endswith("…[truncated]")

    def test_preserves_short_input(self):
        s = "short"
        assert redact_text(s) == "short"

    def test_custom_cap(self):
        s = "y" * 100
        out = redact_text(s, max_chars=10)
        assert out.startswith("y" * 10)
        assert out.endswith("…[truncated]")


class TestEdgeCases:
    def test_empty_string(self):
        assert redact_text("") == ""

    def test_none_returns_empty(self):
        assert redact_text(None) == ""  # type: ignore[arg-type]

    def test_non_string_coerced(self):
        assert redact_text(12345) == "12345"  # type: ignore[arg-type]

    def test_multiple_secrets_in_one_string(self):
        s = (
            "GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "
            "and email maxwell@example.com"
        )
        out = redact_text(s)
        assert "ghp_" not in out
        assert "@example.com" not in out
