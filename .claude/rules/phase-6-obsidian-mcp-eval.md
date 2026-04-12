# Phase 6 R3 — Obsidian MCP Evaluation

## Decision gate (2026-04-11)

### Evaluation criteria

| Criterion | Required? |
|---|---|
| No Obsidian.app dependency (pure FS) | **MUST** |
| Read-only capable | **MUST** |
| Active maintenance | **MUST** |
| Sandbox-compatible (no HTTP/browser) | **MUST** |
| MIT or compatible license | **MUST** |
| At least ONE vault-native capability over generic Filesystem MCP | **MUST** (Amendment E) |

### Candidates evaluated

| # | Package | FS-only? | Active? | Vault-native? | License | Verdict |
|---|---------|----------|---------|---------------|---------|---------|
| 1 | `mcp-obsidian` (MarkusPfundstein) | No — needs Obsidian REST API plugin | Stale (1 version) | N/A | MIT | **REJECTED** |
| 2 | `obsidian-mcp-server` (cyanheads) | No — needs Obsidian REST API plugin | Moderate | N/A | Apache-2.0 | **REJECTED** |
| 3 | `obsidian-mcp` (StevenStavrakis) | Yes | Dormant since Jan 2025 | Yes: tags, frontmatter, canvas | MIT | Runner-up |
| 4 | **`@bitbonsai/mcpvault`** | **Yes** | **v0.11.0, published 2 weeks ago** | **Yes: frontmatter, tags with counts, BM25 search** | **MIT** | **SELECTED** |
| 5 | Custom wrapper (`@modelcontextprotocol/server-filesystem`) | Yes | Upstream active | No vault-native capability | MIT | Fallback only |

### Pick: `@bitbonsai/mcpvault`

**Rationale:** Only candidate meeting all 6 criteria. Pure filesystem access (no
Obsidian.app), actively maintained (4 versions, most recent 2 weeks old), MIT
licensed, 2 dependencies (`@modelcontextprotocol/sdk`, `gray-matter`), and provides
vault-native capabilities absent from the generic Filesystem MCP:

- Frontmatter-aware YAML extraction on read/write
- Tag enumeration with occurrence counts (`list_all_tags`)
- Per-note tag add/remove
- YAML frontmatter protection on writes (won't corrupt frontmatter blocks)
- BM25 relevance search (vs. generic FS which has no search)

14 tools total: `read_note`, `write_note`, `patch_note`, `delete_note`, `move_note`,
`move_file`, `search`, `list_all_tags`, `add_tag`, `remove_tag`, `list_dir`,
`vault_stats`, plus frontmatter extraction integrated into read operations.

**Amendment E check (passed):** At least 3 vault-native capabilities that Filesystem
MCP lacks: frontmatter query, tag enumeration, BM25 search. Obsidian MCP is NOT
redundant.

### Install

```yaml
mcp_servers:
  obsidian:
    command: npx
    args:
      - -y
      - '@bitbonsai/mcpvault@latest'
      - /Users/maxwell/brain
    disabled: false
```

### Sandbox compatibility

The MCP subprocess inherits the parent gateway Seatbelt profile. 6R1 already added
`~/brain` and `~/LETSGO/MaxVault` to the file-read and file-write allow lists.
No additional sandbox rules needed — `@bitbonsai/mcpvault` uses pure filesystem
operations (no HTTP server, no browser, no network egress beyond npm install).

### Smoke test results

Deferred until gateway config is deployed and restarted. Manual smoke tests:
1. `hermes mcp list` → shows `obsidian` as enabled
2. `hermes chat` → "list files in my vault" → uses obsidian:list_dir
3. `hermes chat` → "read ~/brain/00_Inbox/foo.md" → uses obsidian:read_note
4. `hermes chat` → "search the vault for 'Phase 6'" → uses obsidian:search
5. Negative: path traversal via obsidian MCP → blocked by path jail + Seatbelt

---

## Filesystem MCP post-script (6R4)

`@modelcontextprotocol/server-filesystem` installed alongside the Obsidian MCP.
Scoped to `~/Projects` and `~/brain`. Provides raw file CRUD for non-vault paths
(Projects). The Obsidian MCP handles vault-specific operations; Filesystem MCP
handles generic project file access.

Smoke tests: same pattern as above, targeting `~/Projects` paths.
