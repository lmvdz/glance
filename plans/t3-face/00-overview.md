# t3 face — t3code's look-and-feel on the glance cockpit

STATUS: open
PRIORITY: p0
REPOS: glance-desktop (primary), omp-squad (concern 06 + one filed daemon bug)

## Outcome

glance-desktop looks and feels like t3code — its token set, typography, motion, glass, and thread-centric structure — while every surface renders glance's fleet truth from the daemon. The cockpit gains the one thing paint can't deliver: an always-visible thread spine with daemon-computed attention pills, so supervising N units feels like t3code feels to Theo.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| [01 skin-substrate](01-skin-substrate.md) | the entire t3 skin as one additive stylesheet + the few edits only globals.css can carry | architectural | styles/t3face.css (new), globals.css, both main.tsx, components.json, UPSTREAM.md |
| [02 theme-engine-status-tokens](02-theme-engine-status-tokens.md) | status tokens must survive non-default themes; engine hard-rejects unknown keys today | mechanical | theme/types.ts, applyTheme.ts, validateTheme.ts, upstream-drift.sh |
| [03 fleet-token-rekey](03-fleet-token-rekey.md) | fleet is 100% off-token (244 raw palette classes); a skin that skips it ships a two-face app | mechanical (volume) | all src/modules/fleet/*.tsx |
| [04 transcript-cursor-integrity](04-transcript-cursor-integrity.md) | poll cursor never re-fetches entries mutated mid-stream — live bug, fatal to ladder/timeline | architectural | fleet/lib/fleetTranscript*, fleet types |
| [05 thread-spine](05-thread-spine.md) | t3code's identity is the always-visible thread list; fleet lives in a tab-buried drill-down | architectural | fleet/spine/* (new), App.tsx, WorkspaceSurface, commands.ts |
| [06 daemon-needs-you-ladder](06-daemon-needs-you-ladder.md) | one server-computed priority per unit (charter H); cockpit must consume, never rank | architectural | omp-squad: attention lane, API, types |
| [07 spine-server-ladder](07-spine-server-ladder.md) | swap spine to the server ladder, delete client ranking, palette rows get status clusters | architectural | fleet spine + fleetAttention.ts, command-palette entry |
| [08 composer-shell](08-composer-shell.md) | t3's glass composer geometry on both composers + drafts that survive (live data-loss bug) | architectural | fleet IntervenePane, ai composer components, new shared shell |
| [09 timeline-rewrite](09-timeline-rewrite.md) | ConversationView is whitespace-pre text; the reasoning-first turn-fold rhythm is the reading surface | architectural | fleet ConversationView + timeline logic (new) |
| [10 pierre-diffs](10-pierre-diffs.md) | one t3-grade diff renderer for fleet + plan review — behind a measured size spike | architectural | fleet diff blocks, ai PlanDiffReview, package.json, size budget |
| [11 chrome-polish](11-chrome-polish.md) | the feel carriers: empty/skeleton states, subheaders, hover choreography, copy voice | mechanical | fleet module surfaces |
| [12 r3-glance-surfaces](12-r3-glance-surfaces.md) | the 10x layer: gates/landing chips, lease overlay as glass card, in t3's vocabulary | architectural | fleet spine/detail surfaces |
| [13 acceptance-audit](13-acceptance-audit.md) | falsifiable "feels like t3code" — grep gate, provenance test, latency, video, Linux matrix | research | none (verification) |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 02, 04, 06 | disjoint TOUCHES (styles / theme engine / fleet lib / other repo); everything downstream needs them |
| 2 | 03 | needs 01+02 tokens; sole owner of all fleet files for the re-key |
| 3 | 05, 08, 10 | spine is new files; 08 then 10 sequential on IntervenePane (shared-file rule) |
| 4 | 07, 09, 11 | consume server ladder; timeline rewrite; polish over re-keyed surfaces |
| 5 | 12, 13 | R3 vocabulary extensions, then the full acceptance protocol |

Rung map: R1 = batches 1–2 (coherent skin, whole app). R2 = batches 3–4 (spine + signature patterns). R3 = batch 5.

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 03 | 01, 02 | `grep -c color-warning src/styles/globals.css` ≥ 1 and theme types compile |
| 05 | 03, 04 | fleet files show token classes, not `bg-gray-`; cursor fix merged (`grep -n runningFloor src/modules/fleet/lib/fleetTranscriptStore.ts`) |
| 07 | 05, 06 | spine renders; `curl daemon/api/attention` returns priority states |
| 08 | 01, 03 | glass classes exist in t3face.css; IntervenePane re-keyed |
| 09 | 01, 04 | cursor fix merged; ai-elements importable from fleet |
| 10 | 01, 08 | 08's IntervenePane changes merged (same file, ordered) |
| 11 | 03, 05 | spine + re-keyed surfaces exist to polish |
| 12 | 05, 07 | server ladder tiers available for gate/landing chip mapping |
| 13 | 07–12 | all prior merged |

## Not yet specified

- (none)

## Out of scope

- Cost roll-up ledgers and multi-daemon cost altitude — no t3 analog; needs original design once R1/R2 vocabulary exists (attention roll-ups are IN, concern 05/07)
- Lexical composer port — chip-tray compromise chosen; revisit only on friction evidence
- @legendapp/list timeline virtualization — polled cockpit transcripts don't need it yet; revisit at real scale
- Editor CodeMirror-merge diff tabs — upstream-owned interactive edit surface, different job
- Webapp/omp-squad UI reskin — this program is the cockpit; webapp visual parity is a future call
- `daemonTransport.ts` running-floor port — the daemon-backed AI chat transport (E01) has the same in-session streaming-freeze exposure concern 04 fixed for the fleet; different consumer (single-turn quiet-poll), deferred to a small follow-up so it gets its own verification rather than riding 04's fleet-scoped PR

## Decisions so far

- [06 daemon-needs-you-ladder](06-daemon-needs-you-ladder.md) — DONE, omp-squad draft PR #199. One server-computed ladder (charter H executed); cross-lineage reviewed (grok+codex) — both found real synthetic-fixture-hidden defects, all fixed with real-wiring tests. **Batch 1 complete.** Deferred lifecycle-hygiene follow-up to file in Plane (rate-limited).
- [03 fleet-token-rekey](03-fleet-token-rekey.md) — DONE, glance-desktop draft PR #30 (STACKED on #29). Fleet fully on-token; grep gate clean; three taste calls flagged for concern 13's live check.
- [01 skin-substrate](01-skin-substrate.md) + [02 theme-engine-status-tokens](02-theme-engine-status-tokens.md) — DONE, glance-desktop draft PR #29: full t3 skin as one additive file + `@theme` registration in globals; palette fidelity verified; 515/515 green; +88 bytes. Live visual acceptance owed to concern 13.
- [04 transcript-cursor-integrity](04-transcript-cursor-integrity.md) — DONE, glance-desktop draft PR #28: `runningFloor` cursor fixes the live streaming-freeze; daemon seq-reseed bug filed OMPSQ-449; daemonTransport.ts identical exposure deferred (below).
- **2026-07-17 (Lars)**: Charter H expansion APPROVED — this program is the committed cockpit consumer. Concern 06 executes daemon-side; cockpit/webapp/push all render one attention truth. Concern 06's `MODE: hitl` authorization is hereby satisfied.
- **2026-07-17 (Lars)**: Start NOW, in parallel with daily-driver-w15 + land-assessment (disjoint repos/TOUCHES). The adoption-gate pause rule (Notes) still binds: a KILL verdict pauses this program at end-of-batch.

## PR stack — R1 + R2-foundation MERGED to main 2026-07-18

R2 foundation (glance-desktop), merged base-first with `--merge`, children retargeted to main before merging (never merge a stacked child at its parent-branch base):
- #33 `t3face/05-thread-spine` ✅ MERGED
- #34 `t3face/08-composer` ✅ MERGED
- #35 `t3face/09-timeline` ✅ MERGED
- #37 `t3face/07-spine-server-ladder` (was stacked on #33) ✅ MERGED
- #38 `t3face/10-diff-restyle` (was stacked on #34; carries the Lars-approved 1500→1512 KB size bump) ✅ MERGED

Pristine composition gate on merged main (fresh worktree): types clean · lint 0 errors · **592/592 tests** · build OK · size 1.50/1.51 MB green.

Remaining: 11 chrome-polish (in flight on settled main) → 13 acceptance-audit (Lars's spine/timeline/composer reaction is the gate). 12 r3-glance-surfaces DEFERRED by Lars's 2026-07-18 sequencing call (foundation loved first); parked: gd #36 (grr/fabric palette primitives — rebase over merged main before merging, `commands.ts` conflict expected).

## PR stack — R1 MERGED to main 2026-07-18

glance-desktop (lmvdz/glance-desktop):
- #28 `t3face/04-transcript-cursor` → main ✅ MERGED
- #29 `t3face/01-02-skin-substrate` → main ✅ MERGED
- #31 `t3face/03-fleet-rekey` → main ✅ MERGED (was #30; GitHub closed #30 when #29's base branch was deleted — rebased onto main + reopened as #31)

omp-squad (lmvdz/glance):
- #199 `t3face/06-daemon-ladder` → main ✅ MERGED (cross-lineage reviewed+fixed); daemon bug OMPSQ-449

LESSON: `--delete-branch` on a stacked PR's base auto-CLOSES the child PR (can't reopen/retarget a closed PR w/ deleted base) — rebase child onto main + open a fresh PR. Merge base-first with `--merge` (not squash) to keep a stack's ancestry clean.

## Filed follow-ups

- OMPSQ-449 — daemon transcriptSeq not reseeded after restart (surfaced by concern 04).
- OMPSQ-450 — attention-store lifecycle hygiene: eviction/get lost-update race + unit-visit pruning + same-ms tie residual (concern 06 follow-up).

## Notes

- Phase 0 (headless, auto-approved): proceeded over the known open-plan pile — scanner run 2026-07-17; dominant entries are worktree-duplicated land-assessment/phase0 rows, both programs running in parallel by Lars's explicit earlier call; this plan was Lars's direct ask ("plan the t3 face").
- Design gates auto-approved headless; full adversarial round ran (see DESIGN.md provenance). Both red-team critiques materially changed the design.
- **Charter-H trigger**: concern 06 executes plans/daily-driver/01-charter-needs-you-ladder.md's expansion — its written trigger ("a committed cockpit consumer") is satisfied by this program. Lars merging this plan PR is the nod; if he disagrees, 06 downgrades and 07 renders existing client states permanently.
- **Adoption-gate rule**: if the daily-driver adoption gate reads KILL, this program pauses at the end of its current batch — same discipline as daily-driver epics E–G. A beautiful cockpit must not become the false-green pattern applied to taste.
- **MIT notices**: any file substantially copied from t3code carries `Copyright (c) 2026 T3 Tools Inc. (MIT)` in its header — applies at minimum to t3face.css sections and any ported logic/class-string modules.
- **Size budget**: `.size-limit.json` bumps only with Lars's explicit OK (concern 10's spike reports the number first).
- **Rebase discipline**: net-new pristine-upstream files gaining fork edits: applyTheme.ts, validateTheme.ts (concern 02) — both added to upstream-drift.sh REG_POINTS. The skin-coverage manifest + post-rebase screenshot-diff step lands in UPSTREAM.md via concern 01.
- Taste ≥ 7 lane (standing requirement): fable/opus authors or reviews every user-facing diff; webview work loads frontend-design-guidelines; copy is in the taste lane too.
