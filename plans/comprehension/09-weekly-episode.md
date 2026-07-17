# Weekly episode: state-of-the-codebase brief (durable artifact + fabric + push)
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 03, 05, 06
TOUCHES: src/weekly-episode.ts (new), src/squad-manager.ts, src/fabric.ts, src/fabric-search.ts, src/server.ts, src/push.ts

## Goal
Once a week, per repo: a durable, deterministic state-of-the-codebase brief assembled from agent-authored narrative atoms (model-delta decisions), symptoms, fog top-10, and observed-only test provenance — with explained omission, schema-versioned, fabric-indexed, and announced by one push ping.

## Approach
1. **`src/weekly-episode.ts`** (new): pure `buildEpisode(input: { repo; isoWeek; deltas: FeatureDecision[]; symptoms: SymptomEntry[]; fogTop: FileFogEntry[]; testExecutions; digestIds: string[]; omitted: {title; reason}[] })` → `{ id, markdown, meta }`. Sections: "What changed in the mental model" (delta bullets grouped by area, before/after framing), "New known symptoms", "Comprehension debt top-10" (file, debt, never/stale), "Verified this week" (observed-only), "Not covered" (explained omission — REQUIRED, never empty-silent: at minimum counts of digests/decisions not included). `EPISODE_SCHEMA_VERSION = 1` in meta; a version bump means old artifacts are re-renderable, not render-broken (ndrstnd cache pattern).
   - `id = "<isoWeek>"` per repo; storage `<stateDir>/episodes/<repoHash>/<isoWeek>.md` + sidecar `.json` meta via `getStorageBackend`; readdir index (digest idiom).
2. **Loop** (`src/squad-manager.ts start()`): `EpisodeLoop` following the uniform loop shape (`new EpisodeLoop({deps, log, record: this.automation.for("episode", repo)}); start(HOUR_MS)`), timer cleared in `stop()`. **Tick = durable idempotency, NOT a weekly timer**: for each repo, compute the previous COMPLETE ISO week; if its artifact file is absent, gather inputs and write it. Restart-safe by construction; emits one AutomationEvent per generation (and skip events with `skipReason:"exists"` stay ring-only).
3. **Fabric**: `FabricEpisodeFact { id, excerpt, windowStart, windowEnd }` — excerpt = first paragraph + top-3 debt files ONLY (full markdown NOT in the BM25 corpus); `KbDocType "episode"` + `PRIMER_LABEL` + webapp `TYPE_LABELS`. repoSet-filtered like every fact.
4. **API + push**: `GET /api/episodes?repo=` (list) and `GET /api/episodes/:id?repo=` (full markdown), viewer tier, registered in authz. On generation, one push via the existing `PushService` — payload like `voiceDonePayload`'s shape: title "weekly brief ready", NO content beyond that (lock screens aren't viewer-tier), deep link `/#/episodes/<id>`, its own `episode:` tag namespace so it can't debounce-eat a "needs you".
5. Stale-answer resurfacing hook: accept an optional `staleAnswers: {id; question}[]` input rendering a "Your questions whose answers may be stale" section — concern 10 populates it; this concern just renders when present (empty = section omitted, counted in Not covered).

## Cross-Repo Side Effects
None.

## Verify
`bun test` green: builder determinism (same inputs → identical markdown), explained-omission never absent, idempotency decision (exists → skip), ISO-week boundary math (year rollover), excerpt caps, fabric scoping. Manual (scratch-daemon): force a generation, GET the episode, receive the push, ⌘K finds the excerpt.

## Resolution
Shipped: b208d7c (merged 8a8e59d) — `buildEpisode`, hourly-tick/durable-ISO-week idempotency loop, fabric episode fact, `GET /api/episodes`, push ping deep-linking to `/#/episodes/<id>`.

Review verdict: PASS, one dead-alias fix applied in the batch-3 fixer round. `.env.example` documented `GLANCE_EPISODE` as the primary flag name (`OMP_SQUAD_EPISODE` its legacy alias), but `squad-manager.ts`'s episode-loop gate read only the OLD name — the documented-as-primary `GLANCE_EPISODE` silently did nothing, the mirror image of `src/attention.ts`'s kill switch (which read only its NEW name and ignored its documented legacy alias). Fixed with one shared helper, `envBoolAliased(primary, legacy, fallback)` (`src/config.ts`), reading `primary` when set and falling back to `legacy` otherwise; both sites now route through it (`GLANCE_EPISODE`/`OMP_SQUAD_EPISODE` here, `GLANCE_ATTENTION`/`OMP_SQUAD_ATTENTION` in `src/attention.ts`). Tests for both flags via both names in `tests/config.test.ts` and `tests/attention.test.ts`.
