"""Helpers for loading Hermes .env files consistently across entrypoints."""

from __future__ import annotations

import logging
import os
from pathlib import Path

from dotenv import load_dotenv

logger = logging.getLogger(__name__)


def _load_dotenv_with_fallback(path: Path, *, override: bool) -> None:
    try:
        load_dotenv(dotenv_path=path, override=override, encoding="utf-8")
    except UnicodeDecodeError:
        try:
            load_dotenv(dotenv_path=path, override=override, encoding="latin-1")
        except PermissionError:
            # Phase 4 R4: ~/.hermes/.env may be denied at the kernel level
            # by ~/.hermes/hermes.sb. The wrapper at
            # scripts/sandbox/hermes-gateway-sandboxed pre-loads the file
            # OUTSIDE the sandbox and exports the values into os.environ
            # before exec'ing into the sandbox, so by the time we get
            # here the env vars are already populated. Treat the read
            # failure as expected and continue.
            logger.debug(
                "load_dotenv: %s denied by sandbox profile; "
                "relying on pre-loaded os.environ", path,
            )
    except PermissionError:
        logger.debug(
            "load_dotenv: %s denied by sandbox profile; "
            "relying on pre-loaded os.environ", path,
        )


def load_hermes_dotenv(
    *,
    hermes_home: str | os.PathLike | None = None,
    project_env: str | os.PathLike | None = None,
) -> list[Path]:
    """Load Hermes environment files with user config taking precedence.

    Behavior:
    - `~/.hermes/.env` overrides stale shell-exported values when present.
    - project `.env` acts as a dev fallback and only fills missing values when
      the user env exists.
    - if no user env exists, the project `.env` also overrides stale shell vars.
    """
    loaded: list[Path] = []

    home_path = Path(hermes_home or os.getenv("HERMES_HOME", Path.home() / ".hermes"))
    user_env = home_path / ".env"
    project_env_path = Path(project_env) if project_env else None

    if user_env.exists():
        _load_dotenv_with_fallback(user_env, override=True)
        loaded.append(user_env)

    if project_env_path and project_env_path.exists():
        _load_dotenv_with_fallback(project_env_path, override=not loaded)
        loaded.append(project_env_path)

    return loaded
