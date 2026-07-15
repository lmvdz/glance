# Landscape: operator comprehension lane

Working input for the design phase. Two explore passes, condensed. Repo: omp-squad (glance) — daemon (`src/`) + React webapp (`webapp/`) + CLI (`src/index.ts`).

## The goal

The fleet compounds code faster than the operator's mental model compounds. Plan & review keep the human in the *decision* loop, not the *understanding* loop. Glance models agent state exhaustively (receipts, digests, ledgers, hot-areas) and operator state nowhere — confirmed: no seen-marker, read-receipt, or review-coverage signal exists anywhere in the repo. Five lanes, from the design assessment:

1. **Operator-attention log** (seen-markers: diff-viewed, answer-read, debrief-heard, pr-reviewed) + **comprehension-debt fog-of-war overlay** joining fleet file-heat against last-seen-by-human.
2. **Debrief lane: status → teaching** (architecture-story clause per completion; weekly spoken state-of-the-codebase episode from digests + fabric decisions + fog map).
3. **Symptom→where-to-look triage index** appended by every landed fix, fronted by `glance doctor`.
4. **Mental-model-delta section** (≤3 bullets) in every fleet PR, accumulated into a derived living architecture doc, surfaced in Intervene view, with one-tap "did this surprise you?" feedback feeding the fog map.
5. **`glance ask` answers indexed into fabric** with stale-answer resurfacing in debriefs.

Sequencing intent: attention-log + fog overlay first, PR mental-model-delta same pass, then symptom index, then weekly episode.

## Existing comprehension surfaces (what to build on, not duplicate)

- **`glance ask`** (`src/index.ts` cmdAsk ~L918, `src/answers.ts`): spawns a landing-forbidden observer unit; answer = final message verbatim; durable JSON-per-record at `<stateDir>/answers/<id>.json`; `GET/POST /api/answers`. CLI-only consumption; NOT in fabric today.
- **Fabric** (`src/fabric.ts` buildFabricSnapshot L242, `src/fabric-search.ts`): seven fact kinds (agent, digest, hot-area, scout, lease, decision, failure), each an independent assembly block → `KbDoc` BM25 index → `/api/fabric/search` (⌘K palette) + cold-start primer.
- **Hot-areas** (`fabric.ts` hotAreasFromReceipts L148): per-file recency-weighted score from `RunReceipt.filesTouched`, 7d half-life (`HOT_WINDOW_MS` L119), top-50, with touchedBy provenance. Receipts carry `endedAt` → per-file "fleet last changed at" exists.
- **Heat UI already exists**: `GET /api/heat` (server.ts ~L865 heatPayload) → `webapp/src/components/ui/HeatTree.tsx` ("Context Heat Graph", collapsible folder tree, magma ramp) via `webapp/src/lib/heatmap.ts` (buildHeatTree, HeatTreeNode with per-day counts). No treemap; fog overlay can extend this rather than net-new UI.
- **FLEET PULSE** (`src/omp-graph/`): plugin adapters — `SourceAdapter` (adapter.ts L41), registry `DEFAULT_ADAPTERS` in omp-graph/index.ts; new band = new adapter emitting `type:"bands"` tracks, zero compose/schema edits.
- **Intervene view** (`webapp/src/components/IntervenceView.tsx`): loadDiff L156 via `apiJson('/api/agents/<id>/diff')`, 4s poll while working; steers over WS. Natural hooks for (a) diff-viewed attention events (debounced — once per agent-open, not per poll) and (b) delta bullets above the diff spine.
- **Digests** (`src/digest.ts` buildDigest L96): pure, zero-token, run-end triggered from SquadManager; `<stateDir>/digests/<id>.md`; feed fabric.
- **Decisions**: NOT a standalone store — `FeatureDecision` (`src/types.ts` L459: id/text/source:"plan"|"human"|"agent"/sourceRef) on `PersistedFeature.decisions`; captured via `squad_record_decision` MCP tool → `recordAgentDecision` (squad-manager.ts L2528, dedup-by-normalized-text, atomic write); flattened into fabric as "decision" docs.
- **Doctor** (`src/doctor.ts`): `DoctorCheck {id,title,status,detail,remedy?}` rows, check-group fns wrapped in `attempt()` (never throws), `runDoctor(probe)` L290, `renderDoctor` L356, `GET /api/doctor`. `remedy` is already a where-to-look primitive.
- **Automation loops** (`SquadManager.start()` squad-manager.ts L1000): uniform pattern — `new X({deps, log, record: this.automation.for("<loop>", repo)}); x.start(intervalMs)`; tick emits AutomationEvent; `stop()` clears timers. Weekly job = new loop class in this shape.
- **PR authorship**: `floatPrOnLandReady` (squad-manager.ts L3332 + backstop ~L6507) → `ensurePr` (`src/land-pr.ts` L288) — `body?` is threaded end-to-end but **callers pass no body; every fleet PR ships empty-bodied today**. Post-merge hook point: always-on `prReconcileTimer` → `prReconcileTick()` walks `listPendingPrs()`, confirms via `assertMerged` (land-pr.ts L395); would need `gh pr view --json body` to read the body back.
- **Voice lane** (branch `voice-loop`, PR #186 OPEN, NOT on main): connect-time context brief, `fleet_status` tool, `buildVoiceDebrief` "while you were away" (ts-cursor two-phase commit in sessionStore), completion narration, push `voiceDonePayload`. Anything touching `webapp/src/lib/voice/*` or sessionStore debrief code depends on #186.
- **Push** (`src/push.ts`): escalation + voice-done payloads only, status-transition-derived, no transcript content on lock screens.
- **Digest/summary gaps confirmed**: no daily/weekly rollup, no PR digest, no standup output. Nearest is automationDigest (cost/activity, not narrative).

## Persistence & plumbing conventions (mandatory)

- All state-dir writes go through `getStorageBackend()` (`src/dal/storage.ts`): writeDurable (atomic temp+rename+fsync), readText, readdir. Never raw fs.
- Three store idioms: JSON-per-record dir (answers), **`JsonlLog<T>`** (`src/jsonl-log.ts` — capped ring + serialized append + torn-line-skipping hydrate + rotation; live consumer: `transitionLog` in squad-manager), whole-file record map (failure-memory). Attention log should be a `JsonlLog<AttentionEvent>` at `<stateDir>/operator-attention.jsonl`. JsonlLog contract: ring authoritative for tail, file best-effort (fine for telemetry, not durable-or-fail).
- HTTP: no router — one if-chain in `SquadServer.handle()` (server.ts ~L1126–2850). POST bodies: Effect `Schema.Struct` in `src/schema/http-body.ts`, `decodeBody(...)` → 400 on failure (excess keys stripped). New route tier must be registered in `src/authz.ts` restActionTier (default GET=viewer, mutation=operator).
- Webapp writes: `apiJson(path, jsonInit('POST', body))` from `webapp/src/lib/api.ts`; live agent ops ride WS ClientCommand instead.
- Fabric new-fact recipe: FabricXFact + snapshot field + assembly block (fabric.ts), KbDocType + flatten loop + PRIMER_LABEL (fabric-search.ts), optional TYPE_LABELS entry (webapp commandPalette.ts). **Every fact MUST filter through the computed repoSet** — omitting it leaked cross-tenant data once already (fabric.ts L225–241 documents the incident).
- Identity ceiling: file mode has NO per-human id — Actor.id is `web:<role>` (auth.ts actorForRole L109). DB mode has `session.user.id`. AttentionEvent.viewerId must be optional; file-mode fleets collapse humans per tier.
- Testing convention: pure logic in helpers with tests; imperative shells (context wiring, server handlers) stay thin. `bun test` needs node_modules/.bin on PATH (omp). Webapp gate: `cd webapp && bun test && bunx tsc --noEmit`.

## Constraints from the field

- 315 plans already have open work — this plan must be tightly scoped, each concern independently landable.
- Voice-loop (PR #186) not on main: voice-consuming concerns must be BLOCKED_BY-external or stack carefully. Weekly episode can ship as a durable markdown artifact + fabric doc first; spoken delivery is a thin follow-up after #186.
- Fleet PR bodies are empty today — the mental-model-delta section defines the first PR body template; keep it parseable (fenced/heading-delimited) for the reconciler read-back.
- rtk mangles bash grep output — use Read/Grep tools or /usr/bin/grep in any verification steps.
