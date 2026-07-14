# Research brief: terax-ai (crynta/terax-ai)

## Provenance

- **Date researched**: 2026-07-14
- **Source**: https://github.com/crynta/terax-ai
- **Commit inspected**: `a2c8329662ade6fef8c1e11f7353a7231256937d` (main, 2026-07-13)
- **Latest release**: v0.8.5 (2026-07-10) · 8,478 stars · Apache-2.0 · very active (dozens of merges in the week before inspection), single dominant maintainer (`crynta`, 386 commits)
- **Method**: read-only via `gh api` (README, full file tree, ~20 key source files, TERAX.md architecture doc, releases). Nothing cloned, installed, or executed.
- **Question asked**: *what do we think about integrating glance into terax-ai?*
- **Target project**: glance (omp-squad) — multi-tenant agent-fleet daemon + React webapp; harness-agnostic `AgentDriver` seam (`src/agent-driver.ts`, `src/acp-agent-driver.ts`, `src/harness-registry.ts` — claude-code, codex, grok verified via ACP); worktree-isolated units with a proven merge/land pipeline; attention/escalation via webapp + dependency-free Web Push (`src/push.ts`).

## Scout brief (facts)

**What it is.** A 7–8 MB cross-platform desktop app (Tauri 2 + Rust + React 19) combining a GPU-accelerated terminal, code editor (CodeMirror 6 + LSP), git client, and a BYOK in-app AI coding agent — no Electron, no account, no telemetry.

**Architecture.** Strict two-process model: Rust (`src-tauri/`) owns all OS access (PTY via `portable-pty`, fs, git, LSP hosting, an SSRF-guarded HTTP proxy for provider calls, OS-keychain secrets via `keyring`); the React webview reaches the OS only through Tauri `invoke()`. **No HTTP server, no daemon/headless mode, no websocket/RPC surface, no MCP, no ACP anywhere in the tree** (verified by grep over the full 681-path tree and by reading the plugin registration in `src-tauri/src/lib.rs`). Single window, single active workspace root at a time ("Spaces" switch the root; a `workspace_authorize` registry gates fs/git/AI tools to it). No worktree concept, no parallel-agent model.

**AI integration — two disjoint mechanisms.**

1. **In-app agent**: Vercel AI SDK v6 `streamText` loop (`src/modules/ai/lib/agent.ts`) over 13 BYOK providers (`ProviderId` union incl. `openai-compatible` for any OpenAI-shaped endpoint). Tools (`fs`, `edit`, `search`, `shell`, `subagent`, `terminal`, `todo`, `managedAgent`) are built locally and execute locally; mutating tools pause on an in-UI approval card. Small in-process subagent registry (explore / code-review / security / general), read-only-restricted, no recursion.
2. **External CLI agents in its own PTYs** — the notable part:
   - **Detection (observe-only)**: `src-tauri/src/modules/pty/agent_detect.rs` is a byte-level state machine that infers agent status (`Started/Working/Attention/Finished/Exited`) for Claude Code, Codex, and Gemini CLI **purely from OSC escape sequences** (OSC 133 prompt boundaries + a custom OSC 777 marker) — deliberately never from raw text, "so a repainting TUI never flaps." `agent_enable_hooks(agent)` writes hooks into each CLI's own config (`~/.claude/settings.json` UserPromptSubmit/Notification/Stop via the `terminalSequence` hook-response field; `~/.codex/hooks.json`; `~/.gemini/settings.json`) so the agents self-emit the markers — Codex/Gemini hooks print the OSC marker straight to `/dev/tty` (Windows: an `AttachConsole` helper writing to `CONOUT$`). Surfaces as toasts/OS notifications via a notification bell.
   - **Driving (blind write)**: tools `spawn_coding_agent` / `send_to_agent` / `read_agent_output` type text into the PTY and scrape scrollback back. No protocol, no structured turn-taking; a hardcoded 90 ms delay separates text from the Enter keypress because "Claude Code's TUI treats a trailing CR in the same write chunk as a literal newline, not a submit." One managed agent per chat session, maximum.

**Extension points.** No plugin API. Realistic third-party seams: (a) the `openai-compatible` provider slot (point the chat panel at any OpenAI-shaped endpoint — but tool execution stays local to terax), (b) the OSC marker convention (any CLI that emits it gets status surfaced), (c) upstream PRs (provider list is deliberately gatekept for bundle size).

**Design tensions observed.** Blind keystroke injection is fragile by construction and the code says so; detection trades coverage for false-positive safety (OSC-only); BYOK-only means single-operator, single-keychain, single-workspace by design.

## Concept extraction (comparator table)

| Concept | How terax implemented it | Transferable to glance? | Why / why not |
|---------|--------------------------|-------------------------|----------------|
| Terminal-native agent status via OSC markers | OSC 133 + custom OSC 777, byte-level state machine, never trusts raw text | **Yes — emit side** | glance has webapp + web-push attention lanes; a TTY lane is free and reaches any OSC-aware terminal host |
| Hooks installed into foreign harness configs for self-reporting | Writes into `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/settings.json` | **Yes** | glance already installs omp extensions (`src/install-hooks.ts`) and ingests per-harness costs; same trick closes gaps for non-ACP sessions |
| Blind PTY keystroke injection to drive agents | `send_to_agent` + 90 ms CR-separation hack | **No — anti-pattern confirmation** | validates glance's ACP-first bet; adopt hooks+OSC observation, never keystroke driving, as any fallback |
| OpenAI-compatible endpoint as the universal backend seam | `createOpenAICompatible` provider slot | Marginal | glance could expose `glance ask` as an OpenAI-shaped endpoint, but terax's tools still execute locally — capability mismatch |
| Approval cards on mutating tools | `needsApproval: true` pauses the SDK loop | Already have | glance's permission gate / intervene lane covers this |
| SSRF-guarded HTTP proxy, keychain secrets, mounted-but-hidden tabs | Rust proxy, `keyring`, tab persistence | Already have / desktop-specific | glance has `src/ssrf.ts`; keychain is a desktop concern |

## Strategist: ranked transferable concepts

**1. Concept: Terminal-native attention lane (OSC status markers)**
**Pattern**: An orchestrator broadcasts agent/unit state transitions as OSC escape sequences (prompt-boundary OSC 133 + a payload-bearing private OSC like 777) written to the controlling TTY. Any OSC-aware host (WezTerm, Kitty, iTerm2, tmux plugins, terax, future terminals) parses them with a byte-level state machine and surfaces native notifications — without ever trusting raw text output.
**Mechanism**: On unit transitions that already trigger web-push (needs-input, error, landed), the glance TUI/CLI also writes `ESC ] 777 ; notify ; <title> ; <body> BEL` (and OSC 133 markers around interactive prompts) to stdout when attached to a TTY.
**Value for glance**: A third attention lane beside the webapp and `src/push.ts` web-push — zero dependencies, works over SSH, and makes `glance` TUI sessions first-class citizens inside any modern terminal, terax included.
**Where it applies**: `src/tui.ts` and the CLI entry; hook it to the same state transitions that drive `sendPush`.
**Build vs Buy**: Build — it is a few escape-byte writes; nothing to adopt.

**2. Concept: Hook-based self-reporting installed into foreign harness configs**
**Pattern**: Instead of scraping or driving a foreign agent CLI, write into *its own* hook system so it self-reports lifecycle events to your collector.
**Mechanism**: `glance doctor`-style installer writes Stop/Notification/UserPromptSubmit hooks into `~/.claude/settings.json` (and codex/gemini equivalents) that POST to the glance daemon's API — attributing cost/activity for ad-hoc human sessions and any harness running outside the ACP seam.
**Value for glance**: Closes the known harness-attribution gap (omp one-shots, raw `claude` sessions in fleet repos never reach the ingesters). glance already owns this shape for omp extensions in `src/install-hooks.ts`; terax proves the same trick works across all three major CLIs, including the `terminalSequence` response field and `/dev/tty` fallbacks.
**Where it applies**: `src/install-hooks.ts` (generalize beyond omp), `src/ingest/`, `glance doctor` (verify hooks installed).
**Build vs Buy**: Build.

**3. Concept (negative result): blind PTY driving is the wrong seam — ACP validated**
terax's `send_to_agent` needs a 90 ms sleep between text and Enter to avoid a TUI paste ambiguity, reads state back by scraping scrollback, and caps at one managed agent per session. This is the strongest external confirmation yet that glance's ACP-first harness registry is the right architecture. Standing rule extracted: if a harness has no ACP support, fall back to **hooks + OSC observation** (patterns 1–2), never keystroke injection.

**4. Concept (outward, optional): upstream visibility in terax**
Cheap Apache-2.0 PR adding a glance marker spec to `agent_detect.rs` (or simply emitting their existing OSC 777 convention — pattern 1 gets this for free, no upstream PR needed for the notification bell to light up if we match their format). A bigger, speculative play: pitch ACP client support upstream — terax driving agents over ACP instead of keystrokes would make glance's verified-harness registry directly relevant to their 8.5k-star user base. Worth doing only if Lars actually uses terax day-to-day.

## Integration verdict

**Direct integration of glance into terax-ai is a shape mismatch — recommend against.** terax is a single-user, single-window, single-workspace desktop client with no server, no headless mode, and no agent protocol; glance is a multi-tenant daemon with its own web UI, worktree isolation, and merge pipeline. There is no surface for terax to host, drive, or display the fleet, and terax is not a drivable harness glance could adopt (it's a GUI, not a CLI/ACP agent). The realistic touchpoints are shallow: run the `glance` TUI in a terax terminal tab and emit OSC 777 markers (pattern 1) so terax's notification bell surfaces fleet attention — that's visibility, not integration, and it comes free with pattern 1.

**The real payoff of this research is patterns 1 and 2** (a zero-dependency terminal attention lane; hook-based self-reporting to close the attribution gap) **plus the architectural validation in 3.**

---

## 2026-07-14 (later): suite reframe — "terax + glance as one product"

Lars reframed the question: not "plug glance into terax's extension points" but **one suite — manage the fleet AND dig into the nitty gritty** — and explicitly put **forking terax into our own desktop app** on the table. A second scout pass verified the three facts that decide the economics (same commit `a2c8329`), and adjudicated one contradiction.

### Verified seams (second scout, source-quoted)

1. **Preview tab renders arbitrary URLs — the glance webapp embeds in terax TODAY, zero code.** `PreviewTab.url` is a free string; `PreviewPane.tsx` is a plain sandboxed iframe; `tauri.conf.json` CSP has `frame-src 'self' http: https:` (wide open). A localhost SPA framed at `http://localhost:<port>` runs its own SSE/websocket traffic under its own origin, unconstrained by the shell CSP. User opens via command palette → "New web preview" → types the daemon URL. (Iframe sandbox omits `allow-top-navigation*` to protect Tauri IPC — fine for us.)
2. **`terax <directory>` opens that directory as the active workspace on all three platforms** — plain argv parsing in `src-tauri/src/lib.rs` (`parse_launch_target`: first dir arg becomes workspace root, authorized in `WorkspaceRegistry`). No `terax://` URL scheme exists (no deep-link plugin). macOS Finder "Open With" is file-only, but direct CLI invocation with a dir works everywhere. → "open this unit's worktree in terax" = the glance daemon/CLI spawning `terax <worktree-path>`.
3. **Spaces are plain unvalidated JSON** (`terax-spaces.json` via tauri-plugin-store; `SpaceMeta {id,name,root,env,color,...}` + `state:<id>` with serialized tabs incl. `{kind:"preview",url}`). An external tool could pre-register a Space per glance worktree — including a pre-seeded preview tab pointing at the daemon — by writing the file while terax is closed. LOW-CONFIDENCE only on the exact per-OS data-dir path.
4. **CSP `connect-src` already allows `http://localhost:*` and `http://127.0.0.1:*`** — a native (forked) fleet module in terax's webview can fetch/SSE the glance daemon directly, no proxy needed.

### Adjudication: terax has NO ACP (first scout confirmed)

Second scout claimed ACP shipped via PRs #193/#684. Checked against source: GitHub code search for `acp` in the repo returns **0 hits**, and both #193 ("external coding agents over ACP") and #684 ("universal agent registry — 22 coding CLIs") are **CLOSED, unmerged**. Issue #121 (add ACP) remains open. Reading: contributors tried twice to bring protocol-grade agent integration upstream and it didn't land — the maintainer gatekeeps hard (consistent with the documented provider-list gatekeeping). **An upstream fleet-module PR would likely meet the same fate; the fork is the realistic route to native integration.** Meanwhile open issue #549 (native multi-agent orchestration) and the MCP requests (#1002/#378/#388, all unaddressed) show upstream demand drifting toward glance's territory.

### Suite architecture (revised verdict)

The original verdict ("don't integrate") stands only against terax's *extension points*. The suite is a different shape: **glance daemon = fleet brain, terax = local cockpit, joined at the worktree.** The complementarity is exact — glance's webapp is weakest where terax is strongest (dropping into a worktree with a real terminal, LSP editor, git surface) and terax has no multi-agent model at all.

**v0 — zero fork, assembled from verified seams (glance-side work only):**
- `glance open <unit>` (CLI + daemon endpoint + webapp button) → spawns `terax <worktree-path>`. Terminal, editor, git in the unit's worktree, one action from the fleet view.
- Glance webapp embedded in a terax preview tab (daemon URL). Optionally pre-seed a "Fleet" Space via `terax-spaces.json`.
- OSC 777 attention markers from glance TUI/CLI (pattern 1 above) → terax's notification bell surfaces fleet attention. Note: terax's detector self-arms on their OSC 777 marker convention, so matching their format lights the bell without any terax-side change.

**v1 — thin fork = the glance desktop app:**
- Fork terax (Apache-2.0, clean), add an additive `src/modules/fleet/` module — native client of the daemon's existing REST/SSE API (CSP already permits it). Roster, attention lane, intervene view, land controls; bell deep-links to fleet panes.
- Add a `glance://`-style deep-link plugin and dir-open polish (the fork closes terax's own gaps where useful).
- **Rebase economics**: upstream merges dozens of PRs/week under one maintainer — a hard fork diverges fast. Mitigation: terax's `src/modules/<area>/` barrel-export convention is designed for additive modules; keep the fork additive-only (new module + minimal registration touches + name/icon rebrand), rebase on a cadence. Defer deep rebrand — it multiplies conflict surface.
- Risk: upstream builds its own orchestration (issue #549 demand exists) and collides with our module; counter-position is that the daemon, worktree isolation, and merge pipeline are years of moat they'd be rebuilding from zero.

**Recommendation**: ship v0 now (it's small and reversible, and living with it tells us if the suite thesis holds in practice), decide the fork after. Patterns 1–2 from the original analysis are prerequisites of v0 anyway.

### End state (2026-07-14, on Lars's "what is the end state?")

**One desktop app that is the developer's entire interface to a software factory — fleet-first where VS Code is file-first — with zero-friction drop-down from supervising N units to hands-on-keyboard in one worktree.**

- **Two altitudes, one window.** Fleet altitude = glance webapp content gone native (roster, attention queue, merge train, cost/outcome ledgers). Ground altitude = terax's substance (terminal, LSP editor, git). The seam disappears: a failing gate in the fleet pane opens that unit's worktree as a Space, editor on the failing test, terminal on the gate logs. The worktree is the join everywhere.
- **Intervention = shared workspace, not a form.** Intervening opens the unit's Space; human and agent are peers in the same worktree — file edits visible to the agent (lease/presence hooks), conversation over ACP instead of keystroke injection, unit handed back to the pipeline when done. This is the interaction terax's blind `send_to_agent` gestures at and cannot deliver without a protocol; glance has the protocol.
- **Chat and units are the same thing at different sizes.** The BYOK chat panel becomes a glance-backed session: a conversation that outgrows chat escalates into a worktree-isolated, gated, landable unit without changing windows (the reverse of intervene). Terax's in-app agent becomes another harness behind the daemon; every agent CLI anywhere (in-app, over SSH) is detected/attributed/adoptable via the v0 OSC+hooks lane.
- **Multi-machine.** terax's merged SSH lane + headless daemons → cockpit connects to N daemons, fleet spans hosts; web + push stay the away-from-desk surface. Product identity: **glance = daemon (factory) + desktop (cockpit, née terax fork) + web (remote/mobile)** — the IDE for supervising software that writes itself.
- **Permanent boundaries.** The two-process split never merges (terax Rust core ↔ glance Bun daemon; the VS Code/language-server shape). The fork eventually hard-diverges: v0–v1 stay additive/rebaseable, but once the fleet module is the primary surface, upstream terax becomes vendored substrate.
- **Ladder**: v0 bridge → v1 thin fork (native fleet module) → v2 intervene-as-shared-workspace + chat→unit escalation → v3 multi-daemon + own identity. Each rung independently useful; each tests the thesis before the next is funded.
