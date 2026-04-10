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

## LM Studio Configuration (as of 2026-04-09)

**Server settings:**
- Port: 1234
- Serve on Local Network: OFF
- Allow per-request MCPs: ON
- Enable CORS: ON
- Just-in-Time Model Loading: ON
- Auto unload unused JIT models: ON (60 min idle TTL)
- Only Keep Last JIT Loaded Model: ON

**Model load settings (Gemma 4 26B A4B, Q8_0, 25.00 GiB):**
- Context Length: 65,000 tokens (model native: 262,144) — tested at 65K, manually reloaded to 262K after testing
- GPU Offload: 30 layers (all on GPU, 25.6 GiB GPU + 748 MiB CPU spillover)
- CPU Thread Pool Size: 24
- Evaluation Batch Size: 512
- Max Concurrency: 4 (experimental)
- Unified KV Cache: ON
- Offload KV Cache to GPU Memory: ON
- Keep Model in Memory: ON
- Flash Attention: ON (auto-detected)
- Number of Experts: 8 (of 128 total — MoE architecture)
- RoPE Frequency Base/Scale: Auto

**Hardware (from logs):**
- GPU: Apple M3 Ultra, MTLGPUFamilyApple9, Metal 4
- Unified memory: YES, BFloat16: YES
- Recommended max working set: ~233 GiB

**Inference performance (observed at 65K context):**
- Prompt processing: 640 tokens/sec (prefill)
- Token generation: 74 tokens/sec
- System prompt (n_keep): 17,007 tokens — 26% of 65K context consumed before any conversation
- 28 messages = 28,803 total tokens (11,796 tokens of actual conversation)

**Architecture details (from GGUF metadata):**
- 30 layers, 128 experts (8 active per token), 25.23B total params
- Sliding window attention: 1024 tokens, every 6th layer is global (non-SWA)
- Vision encoder: gemma4v projector loaded (1,139 MiB) — multimodal capable
- `<|tool_response>` is an EOG token — model natively supports tool calling format
- Cache reuse and KV cache shifting both NOT supported for gemma4 architecture

## Key Findings

### What Works Well
- **Tool calling**: Gemma 4 26B handles tool-calling prompts reliably — terminal, file, and MCP tools all work first-try
- **Multi-step chains**: Successfully chained read → analyze → create in a single turn (3 API calls, 10.8s)
- **Response quality**: Summaries are accurate and well-structured
- **Speed**: Simple tool tasks complete in 10-18 seconds

### Critical Limitations

1. **Context window was severely constrained at 65K**
   - Tested at 65K context (model supports 262K, manually reloaded to 262K after testing)
   - System prompt alone is 17,007 tokens (26% of 65K budget)
   - Session compaction triggered after just 6 exchanges
   - The skills listing alone (19K chars) consumed a massive chunk
   - Post-compaction: 85% to next compaction immediately
   - **Status**: Model reloaded to 262K — needs retesting to confirm improvement

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
- Context at 65K was too small — now reloaded to 262K, needs retesting
- No web search for researching issues/PRs
- Consider adding `max_tool_output` config to truncate large tool results
- 17K system prompt needs auditing — can it be trimmed?

## Recommendations

1. **Retest at 262K context**: Model reloaded — verify compaction behavior improves and KV cache fits in RAM
2. **Add search API**: Configure Brave Search or SearXNG for web tool
3. **Tune compression**: Increase `compression.threshold` from 50% to reduce compaction frequency
4. **Reduce skill noise**: Disable unused skill categories (red-teaming, ML training, etc.) for Discord gateway
5. **Consider model upgrade**: Qwen 3.5 27B or a larger model with better context handling for Phase 4
6. **Add tool output limits**: Cap MCP/terminal output to prevent context bombs
