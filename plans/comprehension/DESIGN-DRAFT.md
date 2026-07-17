# Draft Design: Operator Comprehension Lane
(Designer round 1 output — input to red team. See LANDSCAPE.md for seams.)

## 1. Approach options (one choice per lane)

### Lane 1 — Attention log + comprehension-debt fog overlay
Alt A — HeatTree extension: second per-file score (debt) on buildHeatTree/HeatTree.tsx, overlay toggle.
Alt B — omp-graph bands adapter (FLEET PULSE timeline tracks).
Pick: A. Fog is a per-file snapshot (heat x recency-of-view), keyed like hotAreasFromReceipts' `${repo}\0${file}` map. HeatTree owns that keyspace/UI slot. Bands are time-series-shaped, poor fit. A future adapter plotting raw attention events on the timeline is legitimate, not built now.

Sub-decision — identity given file-mode ceiling: AttentionEvent.viewerId optional.
A1 — aggregate across all viewers when viewerId absent (fog = "has any human seen this").
A2 — no fog without identity.
Pick: A1. File mode is the common deployment; aggregate fog still honest ("nobody looked at this hot file"). UI must disclose tier-collapse ("team last looked", never per-person).

### Lane 2 — Weekly episode
Alt A — new loop class (WeeklyEpisodeLoop, same new X({deps,log,record}); x.start(intervalMs) shape).
Alt B — piggyback on digest.ts run-end trigger.
Pick: A. buildDigest is run-triggered + zero-token; episode is calendar-triggered, reads across many runs/decisions/fog snapshots. Cadence mismatch.

### Lane 3 — Symptom→where-to-look index
Alt A — DoctorCheck group rows in runDoctor().
Alt B — separate lookup store + `glance symptom <query>` command, fronted by ONE doctor summary row.
Pick: B. DoctorCheck = small curated recomputed-every-run health probes. Symptom index = open-ended append-only searchable corpus. Doctor gets one row: symptom-index count + remedy `glance symptom <query>`.

### Lane 4 — Mental-model-delta
Alt A — FeatureDecision with source:"model-delta" (new discriminator), riding PersistedFeature.decisions / recordAgentDecision / fabric "decision" pipe.
Alt B — sibling store (ModelDeltaEntry JSON-per-record + own fabric kind).
Pick: A. A delta bullet IS a decision-shaped fact; inherits dedup-by-normalized-text, atomic write, fabric flattening free. Cost: audit exhaustive switches on FeatureDecision.source for the new case (concern 06 audit step).

### Lane 5 — glance ask → fabric + stale resurfacing
Alt A — new FabricAnswerFact kind, read from <stateDir>/answers/*.json (digestAgentIds-style listing), repo-attributed via AnswerRecord.repo (answers.ts L47).
Alt B — fold into FabricDecisionFact.
Pick: A. Answers are Q&A pairs; staleness = when-asked vs referenced-files-last-changed, not text dedup.
NOTE FOUND: listAnswers compares a.repo !== opts.repo RAW (L103), not normalizeRepoPath — same bug class as the fabric L225–241 leak incident. Concern 09 must fix before adding the fact kind.

## 2. Key decisions table
| Decision | Choice | Rationale |
|---|---|---|
| Attention substrate | JsonlLog<AttentionEvent> at <stateDir>/operator-attention.jsonl | append-heavy, tail-read, capped; matches transitionLog precedent |
| Fog UI | HeatTree extension | snapshot metric, same file-keyed join |
| File-mode identity | aggregate when viewerId absent | degraded-but-useful beats absent |
| Weekly trigger | new loop class | calendar cadence ≠ run-end cadence |
| Symptom index | separate store + glance symptom cmd | open corpus vs fixed checklist |
| Delta storage | FeatureDecision source:"model-delta" | reuses dedup/fabric/atomic plumbing |
| ask→fabric | new FabricAnswerFact kind | different dedup/staleness semantics |
| PR-body anchor | HTML comment markers (<!-- omp-squad:model-delta:v1 -->, <!-- omp-squad:symptom:v1 -->) | survives human heading edits; gh stores verbatim |
| Symptom authorship | parsed from PR body Symptom section at same reconciler tick | one parse point; squad_record_symptom MCP tool deferred |
| Attention POST tier | viewer (explicit override of mutation=operator default) | recording one's own read isn't operational; operator-gating blinds fog to non-operator viewers |
| Voice dependency | episode ships as markdown+fabric doc now; spoken delivery separate #186-gated concern | isolates every voice/* touch |
| Raw events in fabric | NEVER — only derived aggregates | churn + privacy |

## 3. Data contracts

```ts
// src/attention.ts
export type AttentionKind = "diff-viewed" | "answer-read" | "debrief-heard" | "pr-reviewed";
export interface AttentionEvent {
  kind: AttentionKind;
  repo: string;            // normalizeRepoPath-normalized — join key, always present
  file?: string;           // diff-viewed
  agentId?: string;        // diff-viewed, pr-reviewed
  prNumber?: number;       // pr-reviewed
  answerId?: string;       // answer-read
  viewerId?: string;       // DB-mode session.user.id; undefined file mode
  at: number;
}
// new JsonlLog<AttentionEvent>({ path: join(stateDir,"operator-attention.jsonl"), max: 2000 })
// module-level/manager singleton at boot (like transitionLog), never per-request.
```

```ts
// src/comprehension-fog.ts (pure, tested)
export interface FileFogEntry {
  repo: string; file: string;
  fleetScore: number;       // raw hotAreasFromReceipts score
  lastSeenAt?: number;      // max(at) over diff-viewed|pr-reviewed joined on (repo,file)
  debt: number;             // 0..1 = normalizedFleetScore * (1 - viewRecencyFactor)
  coldStart: boolean;       // repo has < MIN_SIGNAL_EVENTS attention events
}
// viewRecencyFactor = lastSeenAt ? 1/(1 + (now-lastSeenAt)/FOG_VIEW_HALFLIFE_MS) : 0
// FOG_VIEW_HALFLIFE_MS = 14d (deliberately NOT HOT_WINDOW_MS 7d)
// join key `${repo}\0${file}`; filter BOTH sides through repoAdmitter BEFORE joining.
```

```ts
// src/symptoms.ts
export interface SymptomEntry {
  id: string;                 // stable hash of normalized symptom text (dedup)
  symptom: string;
  whereToLook: string[];      // remedy-shaped paths/commands
  repo?: string;
  fixedBy: { prUrl?: string; prNumber?: number; agentId?: string; runId?: string };
  landedAt: number;
}
// <stateDir>/symptoms/<id>.json JSON-per-record (answers.ts pattern)
```

```ts
// src/pr-body.ts — both sections optional; parser never throws; first match wins; comment-anchored.
// ## Mental model delta
// <!-- omp-squad:model-delta:v1 -->
// - bullet (cap 3, extras dropped)
// ## Symptom (if this fixed a bug)
// <!-- omp-squad:symptom:v1 -->
// Symptom: <one line>
// Where to look: <path>, <path>
export function parseModelDeltaSection(body: string): string[];
export function parseSymptomSection(body: string): { symptom: string; whereToLook: string[] } | undefined;
```

```ts
// src/weekly-episode.ts
export interface WeeklyEpisode {
  id: string;                  // ISO week + repo hash; one per repo
  repo: string; windowStart: number; windowEnd: number;
  markdown: string;
  sourceDigestIds: string[]; sourceDecisionIds: string[];
  fogSummary: { topDebtFiles: { file: string; debt: number }[] };
  staleAnswerIds: string[];
  generatedAt: number;
}
// <stateDir>/episodes/<repoHash>/<id>.md + readdir index (digestAgentIds pattern)
```

```ts
// fabric additions: FabricAnswerFact {question, answer, answeredAt, possiblyStale},
// FabricSymptomFact {symptom, whereToLook, landedAt},
// FabricEpisodeFact {id, excerpt (first para + topDebtFiles ONLY — full md via GET /api/episodes/:id), windowStart, windowEnd}
// KbDocTypes: "answer" | "symptom" | "episode" (+ PRIMER_LABEL + TYPE_LABELS).
// ALL through repoAdmitter/normalizeRepoPath. possiblyStale = any referenced file's latest receipt.endedAt > answeredAt.
```

## 4. Risks (designer's mitigations)
- Concurrency: JsonlLog append serialized in-process; singleton at boot, never per-request (hydrate race).
- Tenant leaks: filter both join sides through repoAdmitter BEFORE joining; fix answers.ts L103 raw equality first.
- Privacy: raw per-viewerId lists never exposed except self or admin tier (NOT operator); fog UI shows "team last looked" only; file mode has no viewerId by construction; JsonlLog ring+rotation caps retention; raw events never in fabric/BM25.
- 4s-poll spam: client debounce (pure tested helper) — emit on mount + content-hash change, 5min floor; server coalesces repeat {repo,file,agentId,kind} within 30s into idempotent no-op 200.
- Cold start: coldStart computed in fog helper (repo < MIN_SIGNAL_EVENTS), UI renders "no view history yet" hatch, not debt-red.
- PR-body parse: comment-anchored not heading-anchored; missing → []/undefined never throw; parse strictly AFTER assertMerged in own try/catch; v1 marker allows format evolution.
- #186 isolation: lanes 1/3/4 + substrate never import webapp/src/lib/voice/* or sessionStore debrief code; episode text artifact voice-free; only concern 10 (spoken delivery) is BLOCKED_BY external #186.

## 5. Non-goals
No dwell-time/scroll telemetry; no merge-blocking enforcement; no raw events in fabric; no cross-repo comprehension score; no forced surprise-modal; no GitHub review-timestamp backfill; no squad_record_symptom MCP tool this pass; no per-org retention/purge admin UI (flagged as privacy follow-up).

## 6. Concern slicing (10)
| # | Concern | TOUCHES | Deps |
|---|---|---|---|
| 01 | Attention log substrate: JsonlLog, POST/GET /api/attention, viewer tier, client helper + pure debounce | src/attention.ts(new), src/schema/http-body.ts, src/authz.ts, src/server.ts, webapp/src/lib/attention.ts(new), webapp/src/lib/api.ts | — |
| 02 | diff-viewed emission from IntervenceView (mount + content-hash, 5min floor) | webapp/src/components/IntervenceView.tsx, webapp/src/lib/attention.ts | 01 |
| 03 | answer-read + debrief-heard server-side hooks in GET handlers (per-(actor,id)-per-process dedupe) | src/server.ts, src/answers.ts | 01 |
| 04 | Fog computation: src/comprehension-fog.ts pure helper + GET /api/fog | src/comprehension-fog.ts(new), src/server.ts | 01 |
| 05 | Fog overlay UI: heatmap.ts + HeatTree.tsx debt toggle + cold-start state | webapp/src/lib/heatmap.ts, webapp/src/components/ui/HeatTree.tsx | 04 |
| 06 | PR template+parser: src/pr-body.ts, thread body through ensurePr callers, source:"model-delta", reconciler hook after assertMerged | src/pr-body.ts(new), src/land-pr.ts, src/squad-manager.ts, src/types.ts | — |
| 07 | Symptom index: src/symptoms.ts store, fed by parseSymptomSection at reconciler, glance symptom CLI, one DoctorCheck row | src/symptoms.ts(new), src/squad-manager.ts, src/index.ts, src/doctor.ts | 06 |
| 08 | Weekly episode loop: WeeklyEpisodeLoop, markdown artifact, episode fabric fact, GET /api/episodes/:id | src/weekly-episode.ts(new), src/squad-manager.ts, src/fabric.ts, src/fabric-search.ts, src/server.ts | 04, 06 (soft — stub to []) |
| 09 | ask→fabric: FabricAnswerFact (fix answers.ts L103 first), stale flag helper, episode callout | src/fabric.ts, src/fabric-search.ts, src/answers.ts, src/weekly-episode.ts | 08 soft; fact kind independent |
| 10 | Voice narration of episode (EXTERNAL-GATED #186) | webapp/src/lib/voice/*, sessionStore | 08 + BLOCKED_BY PR #186 |

Sequencing: 01 → {02,03} → 04 → 05, parallel with 06 → 07; both feed 08 → 09; 10 last behind #186.
