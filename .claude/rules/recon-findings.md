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

## Phase 2 Results — 262K Context Retest (2026-04-10)

LM Studio context length bumped from 65,000 → 262,144 in the GUI; gateway restarted clean. Same 7-test stress sequence run in a fresh #sandbox thread, plus 1 additional large-file/chained-ops test.

### Test Results — 65K vs 262K side-by-side

| Test | 65K (Phase 1) | 262K (Phase 2) | Notes |
|------|---------------|----------------|-------|
| Baseline tools listing | 15.0s, 1 call | 14.4s, 1 call | identical |
| Terminal `ls ~/Projects` | 13.9s, 2 calls | 12.0s, 2 calls | 28 entries both runs |
| File read CLAUDE.md | 17.5s, 2 calls | 9.7s, 2 calls | 262K is **44% faster** |
| GitHub list issues | 10.2s, 2 calls | 10.6s, 2 calls | identical |
| Multi-step (read README + create issue) | 10.8s, 3 calls | 10.2s, 3 calls | identical, both succeeded |
| **Skills bomb** (full catalog) | 68.9s, 2 calls, 19,276 chars → triggered compaction | 39.7s, 2 calls, 10,099 chars → **no immediate compaction** | self-truncated this run |
| Memory check (post-bomb) | 53.2s, 4 calls → confused issue # | 69.8s, 1 call → **exact verbatim recall + correct issue #** | compaction triggered HERE at 262K, but recall is now lossless |
| **Large file read** (`discord.py` 2864 lines) | not tested at 65K | 203.6s, 12 calls, paginated → 1 compaction mid-task | quality preserved: correct class, method count, summary |
| Chained GitHub ops (list + get + comment) | not tested at 65K | 78.4s, 3 calls → 1 more compaction | quality preserved: correct issue body, comment added, count correct |

**Total compactions in Phase 2 run**: 3 (after memory check, during large file read, during chained ops)
**Total compactions in Phase 1 run**: 1 (after skills bomb / memory check)

### Key Findings

1. **The real bottleneck is `compression.threshold: 0.5`, not LM Studio context size.**
   Hermes self-reported it: `⚠️ Context: 100% to compaction — threshold: 50% of window`. The 4× context bump from 65K → 262K linearly quadruples the working budget (32.5K → 131K) but the trigger pattern is identical. Heavy turns (large file read, full skills dump) still hit the threshold.

2. **Post-compaction recall is now lossless.** Phase 1 confused issue numbers post-split. Phase 2 recalled the user's first message *verbatim* (including the "262K" detail) AND the correct issue number AND the full body of an issue created earlier in the thread. Either the larger summary budget (52K target vs 13K) or the deeper context preserves more detail through compression.

3. **Context-awareness is now working.** Phase 1 said "context awareness FAIL — cannot self-report token usage". Phase 2: Hermes proactively prints `⚠️ Context: ▰...▰ N% to compaction` bars before tool-heavy responses. This is new and useful for debugging.

4. **Speed is comparable or better.** No 262K-related slowdown observed despite the larger KV cache. CLAUDE.md read was 44% faster. Simple tool tasks unchanged.

5. **Large tool outputs cause compaction storms.** The 2864-line file read paginated into 12 sub-calls and triggered TWO consecutive compression cycles (06:07, 06:08) before completing. Each chained tool result accumulates against the 50% threshold with no per-call cap.

6. **Skills bomb was 47% smaller this time** (10,099 vs 19,276 chars). Hermes self-truncated, possibly due to clearer prompt phrasing. Still substantial — and on top of accumulated context, still contributed to compaction.

## Phase 4 Readiness Assessment (Updated 2026-04-10)

**Closer, but still has 2 blockers.** What changed:
- ✅ Context at 262K provides 4× the working budget (32.5K → 131K before compaction)
- ✅ Post-compaction memory is lossless — autonomous tasks won't lose work
- ✅ Context-awareness self-reporting works — easier to debug long runs
- ✅ Multi-step chains and chained GitHub ops still succeed under compression pressure

Remaining blockers:
1. **Compression frequency under heavy tool use.** Reading a 2864-line file triggered 2 compactions in 200 seconds. Phase 4 (autonomous repo scanning) will read MANY large files. The fix is `compression.threshold: 0.7-0.8` AND/OR `max_tool_output` truncation.
2. **Web search still broken** (Google CAPTCHA). Phase 4 issue triage may need to look up upstream context. Needs SearXNG or Brave Search API.

Non-blockers but worth doing:
- 17K system prompt audit — reducing this would buy back working budget below the threshold
- Skill registry trimming — disable unused categories to reduce skills-list size

## Recommendations (Updated)

1. ✅ ~~Retest at 262K context~~ — done. 262K works, KV cache fits comfortably (M3 Ultra, ~31 GiB total vs 233 GiB available).
2. **TUNE COMPRESSION FIRST**: Edit `~/.hermes/config.yaml` → `compression.threshold: 0.75` (from 0.5). With 262K, this gives ~196K of working budget before compaction — large enough for full repo scans without storms. Also consider `target_ratio: 0.3` to preserve more state per compression.
3. **Add `max_tool_output`**: Cap individual tool results to ~4000 tokens to prevent any single read from blowing the budget. Especially important for `read_file` on large source files.
4. **Add search API**: Configure Brave Search or SearXNG before Phase 4. Web search blocker hasn't moved.
5. **Audit/trim system prompt**: 17K is 6.5% of 262K — not catastrophic, but could be 5K with skill category pruning. Lower-value win compared to the threshold fix.
6. **Consider model upgrade later**: Qwen 3.5 27B is in the lineup (`qwen3.5-27b-unsloth-mlx` is loaded in LM Studio) — worth A/B testing once compression is tuned. Don't switch models AND tune compression in the same change.
