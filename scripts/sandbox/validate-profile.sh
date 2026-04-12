#!/usr/bin/env bash
#
# validate-profile.sh — Pre-flight check for ~/.hermes/hermes.sb (Phase 4 R4).
#
# Runs two checks:
#   1. Symlink audit on the deny-list paths. If any of the paths the
#      profile names is itself a symlink to a different location, the
#      kernel resolves through the link before applying the rule, and
#      the deny may not bite where you expect (CVE-2025-43257 class).
#   2. Syntax probe — sandbox-exec returns non-zero on bad SBPL.
#
# Usage:
#   scripts/sandbox/validate-profile.sh [profile_path]
#   # Default: ~/.hermes/hermes.sb

set -euo pipefail

PROFILE="${1:-$HOME/.hermes/hermes.sb}"

if [[ ! -f "$PROFILE" ]]; then
    echo "error: profile not found at $PROFILE" >&2
    echo "       deploy first: cp scripts/sandbox/hermes.sb $PROFILE" >&2
    exit 1
fi

echo "Validating $PROFILE"
echo

# 1. Symlink audit. The deny-list paths must resolve to themselves.
echo "Symlink audit:"
status=0
for path in \
    "$HOME/.ssh" \
    "$HOME/.hermes/.env" \
    "$HOME/.hermes" \
    "$HOME/Projects" \
    "$HOME/brain" \
    "$HOME/os-apps/hermes/venv"; do
    if [[ -e "$path" ]]; then
        real=$(realpath -q "$path" 2>/dev/null || echo "$path")
        if [[ "$real" != "$path" ]]; then
            echo "  WARN: $path  →  $real"
            echo "        symlink jail target may not match — update profile if needed"
            status=1
        else
            echo "  ok:   $path"
        fi
    else
        echo "  skip: $path  (does not exist)"
    fi
done

if [[ $status -ne 0 ]]; then
    echo
    echo "WARNING: one or more deny-list paths are symlinks. Decide whether"
    echo "         the profile should deny the link OR the resolved target,"
    echo "         and update accordingly."
    echo
fi

# 2. Syntax probe. sandbox-exec exits non-zero on bad SBPL.
echo
echo "Syntax probe (sandbox-exec -f $PROFILE /bin/echo ok):"
if sandbox-exec -f "$PROFILE" /bin/echo ok; then
    echo "  ok: profile parses and a hello-world command runs"
else
    echo "  FAIL: profile failed to parse or execute. See errors above."
    exit 2
fi

# 3. Negative check: confirm denied paths actually deny.
echo
echo "Negative check (deny-list bites):"
neg_status=0
for denied in \
    "$HOME/.ssh/config" \
    "$HOME/.hermes/.env"; do
    if [[ -e "$denied" ]]; then
        if sandbox-exec -f "$PROFILE" /bin/cat "$denied" >/dev/null 2>&1; then
            echo "  FAIL: $denied was readable inside sandbox (should be denied)"
            neg_status=1
        else
            echo "  ok:   $denied  (denied as expected)"
        fi
    else
        echo "  skip: $denied  (does not exist)"
    fi
done

if [[ $neg_status -ne 0 ]]; then
    echo
    echo "FAIL: one or more deny rules did not bite. Profile is unsafe."
    exit 3
fi

echo
echo "Profile validated. Safe to wrap launchd plist."
