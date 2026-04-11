# Design System — Hermes (Operator's Desk)

> A maintenance hatch on a serious personal machine.
> Warm metal under low light, hairline labels, one indicator that matters,
> nothing blinking that doesn't need to.

This is the design specification for the Hermes Agent dashboard
(`http://127.0.0.1:8642/dashboard/`). It is the source of truth for
every visual and UI decision in `dashboard/`. Read this file before
making any styling, typography, color, or layout change.

The aesthetic is named **Operator's Desk**. It is the meeting point of
two converging proposals (Codex's "Control Room Modernism" and the
Claude subagent's "Service Manual / Bone & Iron Oxide"), reconciled
into one coherent system on 2026-04-11 via `/d-c`.

Preview file (kept as a visual reference): `/tmp/d-c-preview-1775912565.html`

---

## 1. Product Context

- **What this is:** A local-first orchestration & monitoring dashboard for
  the Hermes Agent (NousResearch fork) — single-user, served by the
  in-process aiohttp gateway, no external auth, no multi-tenant assumptions.
- **Who it's for:** Maxwell. One technical operator. M3 Ultra homelab.
  Reads this dashboard at all hours from desktop and occasionally phone.
- **Space / industry:** Personal AI agent infrastructure. Adjacent to
  observability (Langfuse, Phoenix, Helicone) and developer tools
  (Linear, Vercel, Railway, Tailscale admin), but **not a SaaS product**
  — should not pretend you might subscribe to it.
- **Project type:** Observability + control surface. Dense in places,
  generous in others. Not a marketing site, not a chat UI, not an
  enterprise dashboard.

## 2. Aesthetic Direction

- **Direction:** **Operator's Desk** — bonded paper on brushed steel.
- **Decoration level:** Intentional. Hairlines define structure;
  paper grain at 3% opacity gives surfaces a tactile quality;
  no shadows, no glassmorphism, no decorative chrome.
- **Mood:** Sovereign. Calm. Hand-built. Slightly anachronistic.
  The feeling of opening a Leica M6 service manual or a Braun T1000
  schematic — except the system is alive and you own it.
- **Reference points:** Braun service documentation, Tektronix
  oscilloscope panels, Whole Earth Catalog, Emigre magazine grids,
  the printed pages of mid-century technical manuals.
- **Anti-references:** Default shadcn dark theme, every "AI dashboard"
  built since 2023, glassmorphism, gradient hero blobs, rainbow event
  category coloring.
- **First-3-seconds emotional reaction:** *"Wait — is this a dashboard
  or a document? Oh. It's mine."*

## 3. Typography

The character of this design lives in the typefaces. Two faces do
the heavy lifting; one mono carries data; one serif is the page-stamp.

### Production stack (paid — single-user / single-machine self-hosted)

- **Display:** **Söhne Breit** (Klim Type Foundry) — page titles,
  the one big number, section heads. Wide compressed authority without
  startup-branding sludge. Use sparingly.
- **Body / UI:** **Söhne** (Klim Type Foundry) — body, transcripts,
  prose, labels, table cells. One face does the heavy lifting.
  Designed, not defaulted.
- **Data / mono:** **MD IO** (Mass-Driver) — variable-axis monospace
  for tables, timestamps, token counts, cron strings, code, log lines.
  Has personality. **Decisively not** JetBrains Mono / Berkeley Mono /
  Geist Mono — those are the new vibe-coded defaults.
- **Stamp:** **Instrument Serif** (free, Google Fonts) — used exactly
  once per route as the page title. Italic by default. The "letterpress
  landing on paper" moment.

### Free fallback stack (if paid licensing is deferred)

- **Display:** **Switzer Variable** (Indian Type Foundry, free) —
  Söhne-adjacent geometric humanist. Loaded from Bunny Fonts.
- **Body / UI:** **Switzer** (free).
- **Data / mono:** **JetBrains Mono** (free) as a temporary substitute,
  with a deliberate plan to upgrade to MD IO. Loaded from Google Fonts.
- **Stamp:** **Instrument Serif** (free) — same as production.

> Both stacks share Instrument Serif and the same scale. The free
> version reads ~85% of the full identity. The decisive upgrade is
> Söhne+MD IO, not Switzer+JetBrains.

### Loading

Self-host all paid faces from `dashboard/public/fonts/` once licensed.
Free faces load from Google Fonts and Bunny Fonts (cached, no
per-pageview cost on a local-only dashboard). All `@font-face`
declarations live in `dashboard/src/index.css`.

### Scale (rem-based, root = 16px)

- 9px (0.5625rem) — tiniest mono labels (RA/Dec chrome on Brain)
- 10px (0.625rem) — UPPERCASE section markers, chip badges
- 11px (0.6875rem) — pulse strip metrics, sub-labels
- 12px (0.75rem) — table rows, event rail, panel rows
- 13px (0.8125rem) — code, transcript metadata, mono body
- 15px (0.9375rem) — transcript prose, approval body
- 16px (1rem) — body default
- 28px (1.75rem) — approval card asks, nested stamp moments
- 36px (2.25rem) — section stamp on transcript heads
- 56px (3.5rem) — display heads, Home stamp day
- 64px (4rem) — typography specimen display
- 96px (6rem) — page-stamp h1
- 144px (9rem) — the one big number (`one-number .big`)

Letter spacing on UPPERCASE labels: **0.14em – 0.18em** (patch-bay).
Letter spacing on display: **-0.02em to -0.04em** (tight at large sizes).
Body line-height: **1.55–1.65**. Display line-height: **0.85–1.0**.

### Type behaviors

- **All-caps only when acting as panel markers**, not as decoration.
  Session titles, route labels, and tool names stay in normal case.
- **Tabular numerics everywhere data lives** —
  `font-variant-numeric: tabular-nums` is mandatory on every metric,
  count, timestamp, token figure, and table cell.
- **Italic Instrument Serif** is the only italic in the system. Söhne
  body should not use italic — italic prose belongs to the stamp moments.
- **Small-caps** appear for memory events (`font-variant: small-caps;
  letter-spacing: 0.04em`) — typographically distinct from tool events
  without resorting to color.

## 4. Color — "Bone & Iron Oxide"

Two modes ship as **separate instruments**, not as an accessibility
preference. Both share the oxide accent and the same type system.
Do **not** add a third theme. Do **not** introduce per-user theming.

### Dark mode (primary — `data-theme="dark"`)

```
--bg            #0E1110   smoked graphite (warm undertone, NOT pure black, NOT slate)
--bg-alt        #131716   second sheet
--surface       #171C1A   panels
--surface-2     #1D2321   elevated panels
--surface-3    #252C29   nested elevation
--rule          #2D3531   hairline divider (use everywhere structure is needed)
--rule-strong   #3B4540   structural separator (use sparingly)
--ink           #E7E2D8   primary text — warm bone, NOT pure white
--ink-2         #B6B0A3   secondary text
--ink-muted     #8D877B   metadata, timestamps
--ink-faint     #5E5A52   tertiary, gutter labels
--inverse       #0E1110

--oxide         #C96B2C   THE accent. The only warm color in the system.
--oxide-hover   #D97B38
--oxide-deep    #8E4B22   pressed / active state
--oxide-wash    rgba(201, 107, 44, 0.10)   selected row / wash background
--oxide-edge    rgba(201, 107, 44, 0.32)   1px ring on focused inputs

--steel         #4C6A7F   secondary signal (cold, used sparingly for "system" not "user")
--steel-wash    rgba(76, 106, 127, 0.12)

--success       #6E8F62   lichen (muted, never saturated)
--warning       #C79A3B   raw sienna
--danger        #B5523D   rust
--info          (does not exist; info uses --ink-2)
```

### Light mode (`data-theme="light"`)

```
--bg            #F2EFE6   warm bone
--bg-alt        #EAE6D9   second sheet
--surface       #ECE8DB
--surface-2     #E2DCC9
--surface-3     #D9D2BC
--rule          rgba(22, 21, 19, 0.10)
--rule-strong   rgba(22, 21, 19, 0.20)
--ink           #161513   near-black with brown undertone
--ink-2         #3B362E
--ink-muted     #6B665B
--ink-faint     #948D7C
--inverse       #F2EFE6

--oxide         #B0561C   slightly deeper for contrast on bone
--oxide-hover   #C2410C
--oxide-deep    #6E3411
--oxide-wash    rgba(176, 86, 28, 0.08)
--oxide-edge    rgba(176, 86, 28, 0.28)

--steel         #3D5868
--steel-wash    rgba(61, 88, 104, 0.08)

--success       #4A6B3A
--warning       #976B12
--danger        #8B2E1F
```

### Color rules

1. **One accent.** Iron oxide is the only warm color anywhere in the
   system that is not semantic. There is no "secondary brand color."
2. **Color = signal.** If a color appears, it must mean something.
   Decoration is achieved through typography, hairlines, and grain —
   never through chromatic variety.
3. **No event rainbow.** Event categories are differentiated
   **typographically** (italic for tool, small-caps for memory,
   UPPERCASE for approval, oxide for the user-facing pulse) — not by
   color. The current `evt-turn` / `evt-tool` / `evt-llm` / `evt-cron`
   etc. rainbow at `dashboard/src/index.css:82-89` is killed.
4. **Steel is reserved** for "machine talking to itself" signals
   (gateway internal, MCP, sandbox state) so the oxide can stay
   reserved for "Hermes wants your attention."
5. **Semantic colors are muted.** Success is lichen, not Tailwind
   green-500. Warning is raw sienna, not amber-400. Danger is rust,
   not red-500.

## 5. Spacing

- **Base unit:** 4px.
- **Scale:**
  ```
  2xs  2px       md   16px      2xl  48px
  xs   4px       lg   24px      3xl  64px
  sm   8px       xl   32px      4xl  88px (section gaps)
                                5xl  120px (page bottom)
  ```
- **Density follows function**, not user preference:
  - **Comfortable** — Home/Inbox, Sessions/$id transcript, the
    Brain detail page. Routes where you READ. Generous leading
    (1.6), wide gutters, one column of attention per viewport.
  - **Dense** — Cron, Tools, Skills, MCP, Health, Sessions list.
    Routes where you SCAN. Tight vertical rhythm, 12-13px mono
    cells, hairline rows, 12px row padding.

## 6. Layout

- **Approach:** Composition-first. Hairline-defined regions over
  cards. No card grids. No 3-up KPI tile rows. No "welcome back"
  hero spaces.
- **Container:** Full-width with route-specific padding. The dashboard
  is local-first and fills the viewport — no max content width clamp
  on the outer shell.
- **Grid:** 12-column baseline grid you can feel through every route.
  Asymmetric 60/40 split is the default for routes with a
  primary-and-rail composition (Home, Sessions/$id).
- **Border radius:** **0px** for structural elements (panels, table
  rows, mockup chrome). **2px** for inputs, buttons, badges.
  **Never** above 4px. The current `rounded-xl` / `rounded-lg` on
  `dashboard/src/components/ui/card.tsx` and `tabs.tsx` is killed.
- **Shadows:** None. Zero. The shadow on `card.tsx` is killed. Use
  inset tonal separation (background-shift between `--bg` and
  `--surface`) and hairlines (`border: 1px solid var(--rule)`) instead.
- **Background grain:** A 3% (dark) / 5% (light) opacity SVG noise
  texture is applied to `body::before` and never to individual surfaces.
  You won't see it; you'll feel it. SVG is inline in `index.css`.

### Route-by-route layout philosophy

| Route | Density | Composition |
|---|---|---|
| `/` (Home / Inbox) | Comfortable | Pulse strip · stamp left + ONE BIG NUMBER + event rail · right rail with brain inset, cron next, health |
| `/sessions` | Dense | Table list with editorial chrome — id, title, model, turns, dur, last activity. Mono throughout. |
| `/sessions/$id` | Comfortable | Editorial transcript: 100px gutter for timestamp + speaker, body in Söhne, tool calls as oxide-edged callouts inside the turn, tool output as left-bordered mono block |
| `/cron` | Dense | Mono table; cron strings in oxide; hover row uses `--oxide-wash`; refresh marker in pulse strip |
| `/tools` | Dense | List with state · enabled/disabled · description · last used. Hairline rows. |
| `/skills` | Dense | Same as tools. Skills are not given preferential treatment — they're a registry, not a marketing surface. |
| `/mcp` | Dense | Server status grid: name · transport · status dot · tool count · last error |
| `/health` | Comfortable | Instrument panel — a few real gauges (token budget, model load, sandbox state, event bus depth) in the style of an oscilloscope. Not 12 KPI tiles. |
| `/brain` | (graphite canvas) | Full-bleed star chart on `#131716`. Crosshair nodes in oxide, hairline edges at 16% opacity, faint coordinate grid, RA/Dec chrome labels in tiny mono. **Deterministic seeded layout** — no force-jitter. Read it like a Palomar plate. |

### The "ONE BIG NUMBER" principle

Every primary route resolves attention to **one answer per viewport**.
On Home/Inbox it's the number of pending approvals (or "ALL CLEAR")
in 144px Söhne Breit oxide. On Cron it's `NEXT 14:35`. On Brain it's
`153 NODES`. The user's eye should not have to search for the headline.

### Section markers

Use a hairline-rule motif for any in-page section heading:

```
─── SECTION NAME ─────────────────────────────────
```

In code: `<div class="marker"><span class="num">01</span> NAME <span class="rule"></span></div>`
where `.rule` is `flex: 1; height: 1px; background: var(--rule)`.

## 7. Motion

- **Approach:** Mechanical-functional. Slide and snap, not bounce.
  Things that move have a job; everything else holds still. **No
  hover lifts, no card scale, no shimmer skeleton loaders.**
- **Easing:** custom `cubic-bezier(0.16, 0.84, 0.24, 1)` — quick out,
  slow in. Feels like a film advance.
- **Duration tokens:**
  - **120ms** — state changes (button press, hover color shift, focus)
  - **180ms** — panel expand / collapse, popover
  - **240ms** — route transitions, drawer slide
  - **320ms** — graph camera drift / focus, theme switch
  - **600ms** — page-stamp typographic settle on route change (one-time)
- **What moves:**
  - The live event rail scrolls (auto-scroll while at bottom)
  - The oxide pulse dot breathes at 2.4s
  - Route transitions slide left 8px with the page-stamp settle
  - Graph nodes drift on hover-focus only (320ms, easing above)
- **What holds still:**
  - Cards (which don't exist anyway)
  - Hover lifts (none)
  - Skeletons (loading is a single oxide cursor blink in MD IO)
  - Background grain (static)
- **Loading state:** A single oxide block-cursor `▋` blinking at
  600ms in MD IO, in place of whatever value is loading. Replace the
  current `pulse-slow` keyframes.

## 8. Components — what to keep, what to kill

### Keep (re-skinned)

- `tailwind.config.js` color binding (HSL CSS variables) — keep the
  *mechanism*, replace the *values*.
- `tailwind.config.js fontFamily` — keep `font-sans` / `font-mono` as
  utility names; rebind to the new stack.
- The shadcn primitives (`button`, `badge`, `input`, `tabs`, `card`,
  `scroll-area`, `separator`) — keep the file structure; rewrite their
  Tailwind classes per the spec above.

### Kill (this is the migration delta)

- `dashboard/src/index.css:82-89` — the eight-color event rainbow
  (`evt-turn`, `evt-tool`, `evt-llm`, `evt-approval`, `evt-compaction`,
  `evt-cron`, `evt-session`, `evt-gateway`). Replace with the
  typographic differentiation system above.
- `dashboard/src/components/BrainGraph.tsx:27-33` — the rainbow
  `NODE_COLORS` map (memory/session/skill/tool/mcp/cron all hardcoded
  to Tailwind hexes). Replace with single oxide for active node, ink
  for the rest, with type encoded by node *shape* (filled / hollow /
  crosshair) not color.
- `dashboard/src/components/ui/card.tsx:11` — `rounded-xl … shadow`.
  Strip the radius and the shadow.
- `dashboard/src/components/ui/tabs.tsx:14` — `rounded-lg`. Strip.
- `tailwind.config.js:63-72` — `pulse-slow` keyframes. Replace with
  the oxide pulse described in §7 (or remove entirely).
- `dashboard/src/index.css:7-49` — the entire stock shadcn HSL
  variable block. Replace with the dark + light token sets in §4.
- `dashboard/src/index.css:74-79` — the `font-feature-settings`
  pinned to `cv11` / `ss01`. Söhne uses different OpenType features;
  rewrite per the type stack chosen.

### Add

- `dashboard/public/fonts/` — self-hosted Söhne, Söhne Breit, MD IO
  (after license). Add `@font-face` declarations.
- `dashboard/src/index.css` paper-grain SVG on `body::before`.
- A `data-theme` attribute toggle (dark default, persistent in
  `localStorage`) — implemented at `__root.tsx`. **Do not** infer
  from `prefers-color-scheme`; this is a deliberate switch.

## 9. Anti-Slop Pledge

Patterns this dashboard refuses to ship. If a future change introduces
any of these, it should be rejected:

- Purple / violet / indigo gradients. Any gradient.
- Glassmorphism, backdrop-blur, frosted cards.
- Six-color (or any-color) rainbow event categories.
- Rounded-2xl cards with drop shadows.
- A KPI tile grid on the home view.
- "Welcome back" / "Hi, Maxwell" header energy.
- Skeleton shimmer loaders.
- A dark-mode toggle in the header (toggle lives in settings, not chrome).
- Decorative Lucide icons used as space-filler or visual ornament.
- Inter, Roboto, Open Sans, Poppins, Montserrat, Geist Sans, Geist Mono,
  Berkeley Mono, JetBrains Mono (as the **production** mono — temporary
  fallback only), Helvetica.
- Hero numbers in neon gradient text.
- Sidebar with 8 icons and no labels.
- Chat-bubble transcripts.
- "Made with ❤" footer energy.

## 10. Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-11 | Initial design system created via `/d-c` | Three-voice synthesis (Codex + Claude subagent + primary). Both outside voices independently converged on burnt iron-oxide as the single accent (Codex `#C96B2C`, subagent `#C2410C`) — strongest signal in the exercise. |
| 2026-04-11 | Dark primary, real bone-light secondary | Both modes ship as separate instruments. User chose recommended option in `/d-c` Q. Light mode is not an accessibility toggle — it's a different surface for the same machine. |
| 2026-04-11 | Söhne + Söhne Breit + MD IO + Instrument Serif (paid stack) | Codex and subagent both reached for Söhne independently. Paid licensing acceptable because dashboard is single-user / single-machine self-hosted. Switzer + JetBrains Mono ship as the temporary free fallback until license is acquired. |
| 2026-04-11 | Density follows function | Comfortable on read-routes (Home, Sessions/$id), dense on scan-routes (Cron, Tools, Skills, MCP). Rejected both "uniformly dense" and "uniformly comfortable." |
| 2026-04-11 | Brain renders as star chart with deterministic seeded layout | Killed the d3-force "blob wiggle." Star chart is legible at 153+ nodes and earns the "what is THAT" reaction by itself. Cost: less drama on new-node-joined animation. |
| 2026-04-11 | Editorial transcripts, not chat bubbles or raw logs | Sessions/$id renders as a lab notebook with margin gutter timestamps + speaker, Söhne body, oxide-edged tool callouts. The Sessions route stops looking like every other LLM chat UI on earth. |
| 2026-04-11 | One big number per viewport | Subagent's idea. Every primary route resolves attention to one answer (pending approvals, next cron, node count). Adopted unanimously. |

## 11. Implementation order (suggested)

Not part of the spec — just a hint for the next session that picks this up:

1. **Tokens** — replace `dashboard/src/index.css:7-49` HSL block with the dark + light token sets from §4.
2. **Type stack** — add `@font-face` for the free fallback (Switzer, JetBrains Mono, Instrument Serif), rebind `tailwind.config.js fontFamily`, drop `font-feature-settings` overrides.
3. **Kill the rainbow** — `dashboard/src/index.css:82-89` and `BrainGraph.tsx:27-33`. Wire the typographic differentiation in `EventStream.tsx` (italic for tool, small-caps for memory, oxide for approval).
4. **Strip card chrome** — `card.tsx`, `tabs.tsx`. Remove rounded-* and shadow. Add `border: 1px solid hsl(var(--rule))` to card root.
5. **Header strip** — `StatusHeader.tsx` becomes the systems strip from §6 / Home mockup.
6. **Home / Inbox** — rewrite `routes/index.tsx` to the asymmetric stamp + ONE BIG NUMBER + event rail composition.
7. **Brain** — `BrainGraph.tsx` deterministic layout, oxide crosshair nodes, RA/Dec chrome.
8. **Editorial transcript** — `routes/sessions.$id.tsx` margin-gutter layout.
9. **Light mode** — `data-theme` toggle in `__root.tsx`, persist to localStorage.
10. **Self-host paid faces** — drop Söhne + MD IO into `public/fonts/`, swap font stacks.

The preview file `/tmp/d-c-preview-1775912565.html` is the visual
reference for every step above. Open it in two browser tabs (one
dark, one light) while implementing.
