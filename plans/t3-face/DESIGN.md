# Design: t3 face — t3code's look-and-feel on the glance cockpit

Lars's ask: t3code's look and feel × terax's Tauri body × glance as the brain that "elevates it 10x." The cockpit is glance-desktop (private terax fork); the daemon stays the only brain. t3code is MIT — we port artifacts and patterns, never its data layer.

## Approach

Hybrid transplant with one structural change. Port what is pure and cheap at full fidelity (the skin token set, the chip/glass/grain/skeleton artifacts, pierre diff rendering); adapt what is already integrated rather than replacing it (the textarea composer, ai-elements markdown/reasoning); and make one topology change that paint cannot deliver: an app-persistent **thread spine** — a t3-style sidebar of units and casual sessions, grouped by project/daemon with attention pills and roll-up headers, with detail always adjacent instead of the current tab-buried drill-down. Attention priority is **computed by the daemon** (this program is the committed cockpit consumer that daily-driver's needs-you-ladder charter was gated on); the cockpit renders it in t3's visual grammar and never owns a ranking.

## Key decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Skin delivery | Additive `t3face.css` carries palette/`.dark`/keyframes/scrollbars/grain/glass/markdown-typography as the stylesheet default; `globals.css` `@theme inline` gets the minimal edits it alone can do (font-sans swap, new token registration, radius-4xl); theme engine extended (3 files) so non-default themes still repaint | Theme-object-only; pure-additive stylesheet | Build-verified: `@theme` outside the root CSS graph is inert and fonts are baked literals — the "zero globals edits" claim was false. globals.css is already fork-diverged; extend the existing conflict surface, minimally. Stylesheet-default also kills the engine's first-paint flash |
| Topology | Persistent thread spine (units + casual/adoptable sessions, project/daemon groups, roll-up headers) with detail pane adjacent; fleet leaves its tab | Restyle the existing roster/drill-down | t3code's identity IS the always-visible thread list; a skinned drill-down still feels like a settings screen. This is the "glance content in t3 structure" half of the ask |
| Attention ladder | Daemon computes one priority state + lastVisited per unit (expands daily-driver charter H); cockpit/webapp/push all consume; spine v1 renders existing client states until the endpoint lands, then the client ranking is deleted | Port t3's `Sidebar.logic.ts` cascade client-side | Charter H locks "nothing computes its own ranking"; a cockpit-local port would be a third ranking with divergent seen-state. Consuming it lands the ladder on every surface at once — the actual 10x |
| Composer | One shared glass shell (frame, footer, send/stop, chip-tray-below, versioned draft persistence) over the existing textarea composers (ai chat + fleet steer); no Lexical | Full Lexical port | Lexical re-plumbs working voice/mentions/attachments for look, not capability. Chip-tray loses nothing at cockpit scale. Draft persistence is in scope — the steer composer loses typed text today (law-5 violation) |
| Timeline | Honest rewrite of fleet ConversationView on ai-elements (Streamdown, reasoning, tool cards) + t3's turn-fold/work-grouping/working-row rhythm; fold boundaries derived from `kind:"user"` entries; virtualization deferred | Port MessagesTimeline + @legendapp/list wholesale | Transcript is polled deltas, not a token stream; the wire shape already carries everything folding needs (verified). Anti-flicker fold guards become acceptance tests, not vibes |
| Transcript integrity | Fix the poll-cursor staleness first (hold cursor below the oldest still-running entry; daemon seq-reseed bug filed upstream) | Build on the current cursor | Daemon mutates streaming entries in place without re-sequencing — every "running" state currently freezes forever. Live bug; fatal to ladder/timeline/diffs if unfixed |
| Diffs | `@pierre/diffs` CodeView for fleet + plan review behind a measured size spike (lazy-load, shiki diet, worker wiring); editor CodeMirror-merge untouched; escape hatch = t3-restyle the existing renderer | Adopt everywhere; skip pierre | Package verified real and clean to import, but 7 MB unpacked + shiki vs a 1500 KB gzip size-limit gate — measure before committing |
| Icons | HugeIcons stays; lucide references remapped in ports | Introduce lucide | One icon family; ported logic is icon-free anyway |
| R3 scope | Gates/landing chips + lease overlay as glass card in; cost roll-ups deferred; attention roll-ups are NOT deferred (they ship with the spine) | Defer all aggregation | Attention aggregation is half the cascade's value; cost ledgers have no t3 analog and need original design |
| Acceptance | Per-surface protocol: zero-raw-palette grep gate, specified empty/loading/hover states, blind provenance test (reviewer can't tell cropped components apart), <100 ms prewarmed unit switch, video capture incl. Linux WebKitGTK + settings window, live `npx t3` reference for analog surfaces | Static side-by-side screenshots | Screenshots can't see hover choreography, pulse duty-cycles, switch latency, or fold flicker — and roster/intervene have no t3 analog to sit beside |

## Risks

1. WebKitGTK (Tauri Linux) may render glass/grain/unison-skeleton poorly — one-class kill switch ships with the skin; Linux is in the capture matrix.
2. `@pierre/diffs` may not fit the size budget — spike decides; escape hatch is pre-planned.
3. Full-app reskin makes future upstream UI additions land visually foreign — mitigated by a skin-coverage manifest + screenshot-diff step in the rebase runbook.
4. The fleet token re-key is a deliberate visual change, not a no-op (asymmetric gray pairs, alpha composites) — gated by both-modes screenshot diff, and status tokens land first so accent lines convert once.
5. Daemon-side ladder work couples two programs — spine ships against existing client states first, so the cockpit never blocks on the daemon concern.

## Red team concerns addressed

| Concern | Severity | Resolution |
|---|---|---|
| `@theme`/fonts inert in additive CSS (build-verified) | critical | Token/font registration moved into globals.css `@theme inline`; additivity claim dropped honestly |
| No thread spine — skin on wrong topology | critical | Spine promoted to program centerpiece (concern 05) |
| Client-side ladder violates charter H's single-ranking lock | critical | Ladder daemon-computed (concern 06); cockpit renders only; charter expansion declared |
| Poll cursor freezes streaming entries (live bug) | critical | Prerequisite concern 04; daemon reseed bug filed upstream |
| Engine can't carry new tokens; engine-default causes first-paint flash | significant | Stylesheet-default inversion; 3-file engine surgery, drift-tracked |
| Pierre size vs size-limit gate; missing worker source | significant | Measured spike first; DiffWorkerPoolProvider re-fetched; lazy-load |
| Settings webview would ship half-skinned | significant | Second entrypoint import + capture coverage in concern 01 |
| "Zero behavior change" re-key claim dishonest | significant | Reframed as visual re-key with screenshot gate |
| Steer draft destroyed on unit landing | significant | Draft persistence + survival in concern 08 |
| Timeline "layering" undersold; turnId dependency | significant | Rewrite framing; fold guards as acceptance tests; boundaries verified derivable |
| Missing feel carriers (palette rows, empty/skeleton, copy voice) | minor→scoped | Concerns 07 and 11 |
| Adoption-gate false-green risk | significant | Written pause rule in 00-overview Notes |

## Open questions

None blocking decompose. Two operator notes (not blockers) are recorded in 00-overview: the daily-driver charter-H expansion is triggered by this plan (Lars's merge of the plan PR is the nod), and a size-limit budget bump only happens with Lars's explicit OK if the pierre spike demands it.

## Provenance

Draft: sonnet designer. Red team: fable ×2 — one empirical (live Tailwind v4 build testcase, npm tarball inspection, transcript wire-shape verification across both repos), one product/program (against the t3code sources and the daily-driver plan). Arbitration: fable (this session). Both critiques materially changed the design: delivery mechanism inverted, spine added, ladder ownership flipped, transcript fix promoted to prerequisite.
