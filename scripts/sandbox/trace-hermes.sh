#!/usr/bin/env bash
#
# trace-hermes.sh — Run hermes CLI under sandbox-exec with a trace-only
# profile to capture the real filesystem and network footprint. Use the
# resulting log to refine ~/.hermes/hermes.sb (Phase 4 R4).
#
# Usage:
#   scripts/sandbox/trace-hermes.sh [trace_log_path]
#   # Default trace path: /tmp/hermes-fs.log
#
# Inside the chat session, exercise the tools you want to discover the
# footprint for: terminal commands, file reads/writes, MCP calls, memory
# writes, skill listings, cron add/remove, etc. Type /exit when done.
#
# Then inspect the trace:
#   sort -u /tmp/hermes-fs.log | grep file-read | less
#   sort -u /tmp/hermes-fs.log | grep network    | less
#
# The (allow default) base profile means NOTHING is denied during the
# trace — every operation is logged. Once you have the footprint, write
# explicit allow rules in hermes.sb that cover the observed paths.

set -euo pipefail

TRACE_FILE="${1:-/tmp/hermes-fs.log}"

if ! command -v sandbox-exec >/dev/null 2>&1; then
    echo "error: sandbox-exec not found in PATH" >&2
    exit 1
fi

if ! command -v hermes >/dev/null 2>&1; then
    echo "error: hermes CLI not found in PATH" >&2
    echo "       activate the venv first: source venv/bin/activate" >&2
    exit 1
fi

rm -f "$TRACE_FILE"
echo "Tracing hermes filesystem + network footprint to $TRACE_FILE"
echo "Drive a chat session that exercises the tools you care about, then /exit."
echo

sandbox-exec \
    -p "(version 1)(trace \"$TRACE_FILE\")(allow default)" \
    "$(command -v hermes)" chat

echo
echo "Trace written to $TRACE_FILE"
echo
echo "Top file-read paths:"
grep -E 'file-read' "$TRACE_FILE" 2>/dev/null | sort -u | head -50 || true
echo
echo "Top network operations:"
grep -E 'network' "$TRACE_FILE" 2>/dev/null | sort -u | head -50 || true
echo
echo "Use these to update scripts/sandbox/hermes.sb allow rules."
