# Hermes Agent Capability Recon — 2026-04-09

## Test Results Summary

| Test | Result | Time | API Calls | Notes |
|------|--------|------|-----------|-------|
| Basic Q&A (no tools) | ✅ Pass | 15.0s | 1 | Coherent, accurate self-report |
| Terminal (`ls ~/Projects`) | ✅ Pass | 13.9s | 2 | Correct output, 28 items listed |
| File read (`read_file`) | ✅ Pass | 17.5s | 2 | Accurate summary of CLAUDE.md |
| GitHub MCP (list issues) | ✅ Pass | 10.2s | 2 | Found issue #1 correctly |
| Multi-step (read README → create issue) | ✅ Pass | 10.8s | 3 | Created issue #2 with relevant improvements |
| Skills listing | ✅ Pass | 68.9s | 2 | 19,276 chars — triggered compaction |
| Post-compaction memory | ⚠️ Partial | 53.2s | 4 | Remembered first question, got issue # wrong |
| Web search (Google) | ❌ Fail | 10.2s | 2 | CAPTCHA blocked headless browser |
| Context awareness | ❌ Fail | — | — | Cannot self-report token usage |

## Key Findings

### What Works Well
- **Tool calling**: Gemma 4 26B handles tool-calling prompts reliably — terminal, file, and MCP tools all work first-try
- **Multi-step chains**: Successfully chained read → analyze → create in a single turn (3 API calls, 10.8s)
- **Response quality**: Summaries are accurate and well-structured
- **Speed**: Simple tool tasks complete in 10-18 seconds

### Critical Limitations

1. **Context window is severely constrained**
   - LM Studio caps at 65K tokens (model supports 262K)
   - Session compaction triggered after just 6 exchanges
   - The skills listing alone (19K chars) consumed a massive chunk
   - Post-compaction: 85% to next compaction immediately
   - **Recommendation**: Increase LM Studio context to 131072 or 196608 if RAM allows

2. **Post-compaction accuracy degrades**
   - Confused issue #2 (created in session) with issue #1 (pre-existing)
   - Used 3 session_search calls trying to recall — expensive
   - For Phase 4 (repo scanning), context loss mid-task could cause duplicate work or missed items

3. **Web search is non-functional**
   - Google blocks headless browser with CAPTCHA
   - Needs SearXNG integration or a search API key (Brave, Serper, etc.)
   - Web tool works for direct URL navigation, just not search engines

4. **Bot-to-bot communication requires config**
   - `DISCORD_ALLOW_BOTS=mentions` must be set for bot-to-bot messaging
   - `DISCORD_ALLOWED_USERS` must include the sending bot's user ID
   - @mention required in threads — Hermes ignores non-mention thread messages

5. **Skills dump is a context bomb**
   - 100+ skills registered, listing them produces 19K chars
   - Any prompt that triggers full skill enumeration will eat the context budget
   - Consider lazy-loading or categorized skill summaries for Discord

## Config Changes Made During Recon

1. `~/.hermes/.env`: Added `DISCORD_ALLOW_BOTS=mentions`
2. `~/.hermes/.env`: Added Claude Code bot ID (`1491945715893796934`) to `DISCORD_ALLOWED_USERS`

## Phase 4 Readiness Assessment

**Not ready yet.** Key blockers:
- Context window too small for scanning repos (file contents + analysis will compact fast)
- No web search for researching issues/PRs
- Need to increase LM Studio context length significantly
- Consider adding `max_tool_output` config to truncate large tool results
- May need a model with native 128K+ context that doesn't require capping

## Recommendations

1. **Increase context in LM Studio**: 65K → 131K minimum for autonomous workflows
2. **Add search API**: Configure Brave Search or SearXNG for web tool
3. **Tune compression**: Increase `compression.threshold` from 50% to reduce compaction frequency
4. **Reduce skill noise**: Disable unused skill categories (red-teaming, ML training, etc.) for Discord gateway
5. **Consider model upgrade**: Qwen 3.5 27B or a larger model with better context handling for Phase 4
6. **Add tool output limits**: Cap MCP/terminal output to prevent context bombs
