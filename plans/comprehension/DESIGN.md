# Design: Operator Comprehension Lane

Make the operator's understanding of the agent-built codebase a first-class, tracked artifact. Glance models agent state exhaustively and operator state nowhere; this lane adds the missing half and pushes understanding at moments of motivation instead of building more unread dashboards.

Process provenance: designer draft (sonnet) → two independent fable red teams (32 findings: 8 critical, 16 significant, 8 minor) → arbitration. Both red teams independently found the same top defect (no content producer) and the same fix (record-then-render). The /research pass on ndrstnd (see `plans/research-ndrstnd/BRIEF.md`) supplied four anti-slop patterns folded in below. Arbitration was performed by the orchestrating session (fable), not a fourth agent — noted for review honesty.

## Approach

Five lanes, one architecture rule, one honesty rule.

- **Architecture rule — record-then-render.** Teaching content (mental-model deltas, symptoms) is recorded by the implementing unit *during the run* through MCP tools, stored daemon-side, and *projected* into PR bodies, Intervene view, fabric, and episodes. Nothing is parsed back out of PR bodies. This collapses the draft design's four worst defects (no producer; create-only PR bodies; reconciler featureId gap; repo-keyspace mismatch at parse-back).
- **Honesty rule — a signal is named by what it measures.** "Seen" means the file entered the viewport of a visible tab, not "tab existed". Debt is monotone until viewed — it never self-clears through fleet heat decay. Test claims in any summary carry observed-only provenance. Every summary enumerates what it omitted. Cold-start and rename limitations are disclosed in UI copy, not hidden.

The operator-attention substrate is two stores: an append-only `JsonlLog` raw event feed (bounded telemetry) plus a **compacted last-seen map** (whole-file record map, `${repo}\0${file}` → max seen ts, per-viewer in DB mode). Fog reads only the map — rotation of the raw feed is harmless, floods can't erase history, and retention matches the metric by construction.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Teaching-content flow | Record-then-render (MCP tools → store → projected PR body/UI) | Template PR body + reconciler parse-back | Parse-back had no producer, no adopt-path update, no featureId at reconcile time; both red teams independently demanded the inversion |
| Delta storage | `FeatureDecision` `source:"model-delta"` + `featureId` persisted into `PendingPr` at float | Sibling store | Reuses dedup/fabric plumbing; featureId gap closed at float time; no-feature units get a declared "no delta recorded" body line |
| Delta quality floor | Evidence anchors required: each bullet carries `evidence: [file[:lines]]`, validated against the unit's receipts `filesTouched` at record time; anchorless bullets rejected with reason | Free-form bullets, cap 3 | ndrstnd pattern 1; the only mechanical anti-slop pressure available without a human gate |
| Symptom producer | New `squad_record_symptom` MCP tool at fix time, `whereToLook` entries must be existing repo paths (stat-checked) or known commands | Parse from PR body Symptom section | Producer-first; "Where to look: src/" slop rejected mechanically at record time |
| Attention substrate | JsonlLog raw feed **+ compacted last-seen map** (fog reads map only) | JsonlLog alone | Verified: rotation clobbers `.1`, hydrateAll reads live file only — ring-based lastSeenAt resurrects debt on reviewed files and a 4MB flood erases team history |
| Debt formula | Monotone change-mass: count of receipt touches per file with `endedAt > lastSeenAt`; reset only on view; absolute log-bucket normalization | `fleetScore × (1 − viewRecency)` with 7d-half-life heat | Draft formula self-cleared debt via heat decay and zeroed on tab-flick — measured neither comprehension nor debt |
| Seen semantics | Per-file IntersectionObserver + `document.visibilityState` gate, 5-min floor; mount alone emits nothing | Emit-on-mount per diff | A 40-file diff must not be "seen" by a 2-second tab flick; binary viewport entry is within the no-dwell-telemetry non-goal's spirit |
| Fog UI | HeatTree overlay, tri-state (never-seen hatch / seen clear / stale ramp), top-10 debt shortlist as headline, disclosure line | Full-tree red ramp; omp-graph bands | An actionable shortlist is the contract; a red wall trains "toggle is noise"; bands are time-series-shaped |
| heatPayload fixes in-scope | Repo-normalize (`normalizeRepoPath`) + repo-keyed `byFile` | Leave as-is | Verified: raw `r.repo === repo` compare + bare-path keying — same bug class as the fabric leak incident, in the exact endpoint the overlay extends |
| Tenant scoping | POST validates `repo` against actor-visible set (fail closed); GETs derive repos from actor like `buildFabricSnapshot`; `redactAttentionForActor` pure+tested (self-or-admin raw reads); schema field-length caps | Prose-only mitigation | Fail-open privacy prose is the defect class this repo's blind-review history keeps catching; the filter must be a tested deliverable with an acceptance test |
| File-mode identity | Aggregate when `viewerId` absent; UI says "team last looked", never per-person | No fog without identity | File mode is the common deployment; degraded-but-useful beats absent |
| Privacy posture | Disclosure line where fog renders; `GLANCE_ATTENTION=0` kill-switch; n=2 deanonymization stated, not papered over; admin raw-read allowed and disclosed | Silent tracking | Attention data is surveillance-adjacent; consent story is one line + one flag, not a follow-up |
| answer-read / debrief-heard | Client-side explicit acks only (webapp render/expand; CLI display path). `debrief-heard` reserved, emitted only in the #186-gated concern post-narration | Server-side GET hooks | `cmdAsk` polls GET every 2s — served ≠ read; GET hooks mark answers read for curl scripts |
| pr-reviewed | Emitted on webapp click-through to the PR, files from the last known agent diff set | GitHub webhook / no emitter | Honest ("clicked through"), cheap, joins fog; webhook is out of scope |
| Weekly episode trigger | Hourly tick + durable idempotency (generate iff previous complete ISO week's artifact absent) | `start(WEEK_MS)` | Daemon restarts more often than weekly; a 7-day in-memory timer never fires |
| Episode composition | Deterministic assembly of agent-authored narrative atoms (delta bullets, symptoms, fog top-N, observed-only tests from receipts, explained-omission fields, schema-versioned) | LLM composition step | Zero-token, honest, and the narrative atoms are already agent-authored; LLM composition is a declared follow-up |
| Push at motivation | Doctor check FAILS → BM25-match symptom index into that check's `remedy`; episode-ready push ping (no content on lock screen) | Pull-only surfaces | The design was chartered against unread dashboards; doctor-failure is the moment of maximum motivation |
| Intervene teaching | Delta bullets above the diff spine + one-tap "surprised" chip (attention event; surprise boosts that file's debt) + deterministic diff reading order (def-before-use topo, pure helper, cycle fallback) | PR-body-only surfacing | Restores the lane-4 goals the draft silently amputated; Intervene is where quality pressure on bullets comes from |
| ask→fabric | New `FabricAnswerFact` kind + `possiblyStale` (referenced files' receipts newer than answer); fix `answers.ts` raw repo compare with `normalizeRepoPath` in the substrate batch | Fold into decisions | Different staleness semantics; the compare bug is live cross-tenant-class and lands first |
| Voice delivery | Isolated final concern, `BLOCKED_BY` external PR #186; nothing else imports `webapp/src/lib/voice/*` or sessionStore debrief code | Build inline | #186 is unmerged; isolation enforced by TOUCHES discipline |

## Risks

- **Signal gaming / vanity drift**: viewport-entry is still weaker than comprehension. Mitigated by naming (UI copy says what it measures), surprise-tap counter-signal, and sampling delta/symptom quality in the existing blind-review cadence. Accepted residual.
- **Viewer-tier POST abuse**: rate limit per actor, schema caps, seen-map compaction (floods can't erase history), repo validation fail-closed. Accepted residual: a hostile *authorized* viewer can still mark files seen — same trust boundary as every other viewer write.
- **Renames break the (repo,file) join**: disclosed in fog UI copy; not chased with `--follow`. Accepted.
- **No-feature units record no deltas**: declared in PR body ("no delta recorded"); revisit if the miss rate is material.
- **Episode noise**: bounded by explained-omission + top-N caps; push ping is weekly max.

## Red Team Concerns Addressed

| Concern (RT#-finding) | Severity | Resolution |
|---|---|---|
| No content producer (RT1-1, RT2-1) | critical | Record-then-render inversion; producers are concern 05, PR body is a projection (06); nothing lands consumption before a producer demonstrably writes one real entry |
| Create-only PR body / adopt path (RT1-2) | critical | Body rendered at float; `gh pr edit --body` on adopt when markers absent, idempotent |
| JsonlLog rotation destroys view memory (RT1-3, RT2-11) | critical | Compacted last-seen map is fog's only source; JSONL demoted to bounded telemetry |
| Tenant scoping unspecified (RT1-4) | critical | POST repo validation fail-closed; actor-derived repo sets on GETs; acceptance tests in concern 01 |
| Debt self-clears via heat decay (RT2-2) | critical | Monotone change-mass-since-lastSeen formula; heat used for display ranking only |
| Tab-flick zeroes 40 files (RT2-3, RT1-8) | critical | IntersectionObserver + visibility gate + 5-min floor; mount emits nothing |
| Privacy filter was prose (RT2-4) | critical | `redactAttentionForActor` pure+tested deliverable with acceptance test; GET tier registered explicitly |
| featureId absent at reconcile (RT1-5) | significant | featureId persisted into PendingPr at float; render-time lookup, no reconcile-time resolution |
| debrief-heard not on main (RT1-6, RT2-9) | significant | Moved to #186-gated concern, emitted post-narration client-side |
| GET-as-read-receipt false positives (RT1-7, RT2-13) | significant | Client-side explicit acks only |
| heatPayload raw compare / bare keys / top-50 cap (RT1-9) | significant | heatPayload fixes in concern 04's scope; fog computes change-mass from receipts directly, uncapped per-repo |
| Weekly interval never fires (RT1-10) | significant | Hourly tick + durable ISO-week idempotency |
| Symptom repo keyspace mismatch (RT1-11) | significant | Symptoms recorded at run time with the unit's repo *path*; identity mapping not needed (no reconcile-time recording) |
| Viewer POST poisoning/flood (RT1-12) | significant | Rate limit, schema caps, seen-map compaction, repo validation |
| Consent/deanonymization (RT2-5) | significant | Disclosure line, kill-switch flag, n=2 limitation stated, admin read disclosed |
| All-pull consumption (RT2-6) | significant | Doctor-failure symptom match (acceptance test), Intervene bullets, episode push ping |
| Lane-4 amputation undeclared (RT2-7) | significant | Intervene bullets + surprise tap restored (08); living architecture doc = episode's cumulative delta section (declared) |
| Zero quality enforcement (RT2-8) | significant | Evidence anchors validated against receipts; whereToLook stat-checked; blind-review sampling cadence |
| Dead AttentionKind values (RT2-10) | significant | pr-reviewed gets a real emitter; debrief-heard gated; answer-read client-side |
| Cold-start red wall (RT2-12) | significant | Per-file tri-state; repo-level "no history yet" until events span ≥1 day; top-10 shortlist |
| Episode authorship quality (RT1-13) | minor | Declared deterministic projection of agent-authored atoms; LLM composition deferred explicitly |
| Normalization undefined (RT1-14) | minor | Absolute log-bucket change-mass scale |
| GET /api/attention tier (RT1-15) | minor | Registered explicitly; self-or-admin redaction |
| Renames (RT1-16) | minor | Disclosed, not chased |
| Symptom dedup collisions (RT2-14) | minor | id = hash(symptom + agentId + landedAt-week); query-time grouping newest-first; render-time stat check flags dead paths |
| Thinner v1 (RT2-15) | minor | Batch order proves the loop first (substrate → producers → fog/doctor); episode/ask/voice sequenced last, not cut — user authorized the full lane |
| Doctor-tier discovery (RT2-16) | minor | Symptom facts + `glance symptom` are viewer-tier via ⌘K/fabric; doctor row is additive |

## Open Questions

None blocking. Deferred (declared, not fog): LLM episode composition; `git log --follow` rename tracking; per-org retention/purge UI; GitHub webhook pr-reviewed source.
