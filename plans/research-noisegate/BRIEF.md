# Research brief: noisegate — deterministic tool-output compaction

- **Date**: 2026-07-15
- **Source**: https://github.com/Tosko4/noisegate (MIT, 8 stars, created 2026-07-05)
- **Commit scouted**: `00d565b9f6f0dad6db46333b73a046b74d538c04` (2026-07-15T16:02:37Z)
- **Key docs read**: README.md, docs/product-contract.md, engine.py structure (10,092 lines), file tree
- **Target project**: omp-squad / glance (this repo). Application points below verified against live source by an Explore pass on 2026-07-15.

## What it is

Noisegate is a deterministic (no-LLM) compaction layer for the Hermes Agent harness: it sits between noisy tool output (test runs, package installs, Docker builds, log tails) and the model's context window, keeping failure lines/tracebacks/resolver conflicts visible while eliding repetitive spam — and refusing to touch anything that must stay exact (file reads, diffs, code-search output, retrieved memory/MCP/web content, unknown tools).

## How it works (scout findings)

- **Command classification** (`engine.py classify_command`, ~line 943): the producing command string + output shape → a `command_class` (pytest, pip/uv/apt, npm/pnpm/yarn, docker build vs docker logs, git status/log, generic).
- **Per-class reducers with preservation patterns**: tables of regexes per class — `TEST_PATTERNS`, `CRITICAL_PATTERNS`, `PACKAGE_PATTERNS`, `DOCKER_LOG_PATTERNS`, `HIGH_SIGNAL_PRIORITY_PATTERNS`, `DIAGNOSTIC_LOCATION_PATTERNS` (engine.py ~1331–1600). Lines are ranked (`_failure_detail_rank`), a line/char budget is filled priority-first (`_line_budgeted_important_excerpt`), the rest becomes explicit `[noisegate: omitted N lines]` markers. Fallback when no class matches: deterministic head/tail split.
- **Dual failure polarity** (the sharpest design idea):
  - **Fail open on compaction**: any reducer exception, a no-gain result (output not strictly smaller), or a budget that can't fit marker + preserved content → return the ORIGINAL unchanged. A compactor must never make output worse.
  - **Fail closed on identity**: unknown tool name, ambiguous wrapper, missing wrapped-tool identity → don't touch it. Compactability is allowlisted (`terminal`, `process`, `read_terminal`, `browser_console`); protection is the default for everything else, including unknown *future* tools.
- **Protected surfaces**: file reads, diffs/patches, `rg`/`grep`/`ag`/`ack` output, skills, memory/LCM/Hindsight/MCP/web-extraction results, `execute_code` stdout (stdout can be source), simple file-display commands (`cat`, `sed -n`, `head`, `git show REV:path`). One narrow exception: allowlisted diagnostic string fields (lint/typecheck/eslint output) inside write/patch tool results may compact field-level, inline-only.
- **Artifacts = recovery, not archive**: raw output storage is OFF by default; when enabled it's a private content-addressed store (`ng_<sha256-prefix>`), 0700/0600 permissions, size-capped, path-contained, and it **scans the full payload and refuses secret-looking content** (API keys, auth headers, cookies, including spaced labels like `API Key:`) before writing. Compacted output carries a recovery ID. The pre-redaction terminal hook never stores raw artifacts.
- **In-band + env bypass**: `NOISEGATE_BYPASS=1` / `[noisegate:bypass]` marker when exact bytes matter; `NOISEGATE_DISABLE=1` global off.
- **Decision diagnostics**: `--metadata` emits one JSON object on stderr per decision — `command_class`, reducer chosen, unchanged-reason code, chars/lines saved — so every compaction (or refusal) is explainable without changing stdout.
- **Product contract** (`docs/product-contract.md`): a maintainer checklist gating every change — "context value over byte-count wins", "exact context stays exact", "fail-open is real", "artifacts are recovery, not an archive", "docs match behavior". Changes that can't satisfy the checklist stay out.
- Distribution: Python package + `install-hermes` self-installer that fail-closed-validates the host venv; a thin npm wrapper. CLI surfaces (`reduce`, `reduce-json`, `wrap -- cmd`, `doctor`, `cat ng_<id>`) work outside the harness too.

## Glance's current state (verified seams)

The de-facto compaction module is `src/gate-logs.ts` — `budgetedExcerpt` (line 214) with diff-aware whole-hunk packing (`packDiffToBudget`, 161), tail-preserving `headTail` (193), and durable full-text offload to `<stateDir>/gate-logs/` with a `[N bytes omitted — full: <path>]` pointer. It is applied on the **validator/land** paths only (`validator.ts:200,334`, `land.ts:229`, `land-pr.ts:87,755`).

Everything else is blind head-truncation or uncapped:

1. **Verify-loop steer path** (`src/workflow/executor.ts:105,321`): gate stdout+stderr → `combined.slice(0, 4000)` head-only → re-injected as `--- Recent command output ---` into the failing unit's next prompt (`executor.ts:197-199` via `ctx.vars.lastOutput`). Test-runner failure summaries live at the END of output, so the steer message systematically loses the signal. Same head-only pattern in `checkpoint-log.ts:85` (`MAX_FIELD_BYTES=4096`).
2. **Transcript tool results** (`src/squad-manager.ts upsertToolEntry:6132-6159`): rendered `*Text` fields capped at 2000 via `safeJson`, but the raw `args`/`partial`/`result` objects are stored **uncapped** on `TranscriptEntry.tool` — in memory, in `state.json`, and served whole by the transcript delta endpoint (`src/transcript-delta.ts`, no size cap) that the cockpit and voice debrief lanes poll. Only the entry *count* is bounded (`MAX_TRANSCRIPT=800`).
3. **No signal classifier anywhere**: nothing in the repo ranks failure lines vs spam; the closest classifiers (`gate-runner.ts gateRunUnrunnable/greenGateUnproven`) decide whether a gate *ran*, not what to keep.
4. **Gate-log offload has no secret refusal**: `writeGateLog` persists raw gate output to disk with no secret scan (contrast with the `delete process.env` lesson from voice DB-mode — raw logs can carry key material).
5. Four duplicated `truncate(s,n)` head-only helpers (`land.ts:214`, `validator.ts:42`, `squad-manager.ts:8550`, `flue-service-driver.ts:238`); voice lane has its own head-only `truncateForVoice` (`webapp/src/lib/voice/tools.ts:341`).

## Concept extraction

| Concept | How noisegate does it | Transferable? | Why |
|---------|----------------------|---------------|-----|
| Signal-ranked reduction, not truncation | per-command-class preservation regexes + priority-filled budget + omission markers | **Yes — highest value** | glance head-truncates exactly where failure tails matter |
| Dual failure polarity | compaction fails OPEN (return original), identity fails CLOSED (unknown = exact) | **Yes** | crisp articulation of glance's own fail-open-defense doctrine, applied to a new surface |
| Protected-surface allowlist | compactable tools allowlisted; diffs/search/retrieval/unknown always exact | **Yes** | glance must never compact fenced KB/spec/diff content when adding a reducer |
| Raw offload = recovery + secret refusal | content-addressed private store, scans payload, refuses secret-looking content | **Yes (increment)** | glance already offloads gate logs but with no secret scan |
| No-gain rule | accept transformed output only if strictly smaller | Yes (small) | prevents marker-bloat on short outputs |
| Decision diagnostics | one JSON object per decision: class, reducer, reason code, chars saved | **Yes** | fits automation-log honesty culture; makes compaction auditable |
| In-band bypass markers | `[noisegate:bypass]`, env flags | Marginal | glance controls both sides of its seams; env flag suffices |
| Product-contract checklist doc | maintainer checklist gating changes to the compaction layer | Yes (light) | one doc, cheap, matches blind-review/absence-invariant culture |
| Self-installing host plugin | `install-hermes` venv validation | No | glance owns its harness; no third-party install problem |

## Ranked patterns for glance

**1. Tail-and-signal-preserving reduction on the verify-loop steer path** (impact: highest, effort: small)
- **Pattern**: when gate output exceeds budget, rank lines by failure-signal (test failure markers, tracebacks, error/denied/not-found, resolver conflicts), fill the budget priority-first, elide with explicit markers; minimum-viable form = head/tail split instead of head-only.
- **Where**: `src/workflow/executor.ts:321` (replace `combined.slice(0, MAX_CONTEXT_OUTPUT)` with `budgetedExcerpt(combined, 4000, {kind:"log"})` or a new signal-ranked reducer), `src/workflow/checkpoint-log.ts:85` same fix. `reflectionNote` (executor.ts:257) then reasons over signal instead of preamble for free.
- **Value**: the verify→codefix→fixup loop steers on the failure text; today the steer message can contain 4000 chars of collection spam and zero failure lines. Plausibly a live contributor to "verify-loop thrashes hard units" (known gotcha).

**2. Per-class signal reducer as a shared module** (impact: high, effort: medium)
- **Pattern**: `classifyCommand(command, text) → class`, per-class preservation-regex tables (bun test/vitest/pytest, bun/npm/pnpm install, tsc/eslint, docker logs, generic head/tail fallback), budget-filled excerpt, fail-open on any exception or no-gain.
- **Where**: extend `src/gate-logs.ts` (or sibling `src/output-reduce.ts`); consume from executor (1 above), `land.ts`/`validator.ts` log excerpts, and `safeJson`'s callers. Consolidate the four duplicated `truncate` helpers onto it.
- **Value**: every place gate/test/build text meets a model prompt keeps conclusions and diagnostics under the same budget it already spends.

**3. Cap + offload transcript tool-result payloads** (impact: high for memory/state size, effort: medium)
- **Pattern**: recovery-not-archive — store a budgeted rendering inline, offload the raw object to a size-capped content-addressed file with a pointer, never store what looks secret.
- **Where**: `src/squad-manager.ts upsertToolEntry:6143-6147` (raw `args`/`partial`/`result` currently unbounded → `state.json` bloat; served whole via `src/transcript-delta.ts` to cockpit/voice pollers).
- **Value**: bounds daemon memory and `state.json` growth per-entry (today only entry *count* is bounded), and shrinks transcript-delta payloads the voice lane polls.

**4. Secret refusal before gate-log persistence** (impact: medium, security-shaped, effort: small)
- **Pattern**: scan the full payload for credential-looking content (key/token/authorization/cookie labels incl. spaced forms) and refuse to persist raw, keeping only the compacted form.
- **Where**: `src/gate-logs.ts writeGateLog:41-48` (and the offload added in 3).
- **Value**: gate output routinely echoes env and curl headers; the voice DB-mode work already established that key material leaks through side channels.

**5. Compaction decision diagnostics into automation-log** (impact: medium, effort: small)
- **Pattern**: every reduce decision emits `{class, reducer, reason, charsSaved}` (or `unchanged` + reason code) to the structured log.
- **Where**: the module from 2 → `src/jsonl-log.ts` automation-log writers; surfaces in the existing automation panel.
- **Value**: absence-invariant compliance — a compactor that silently eats a failure line is a false-green machine; this makes every elision auditable.

**Deliberately not borrowed**: LLM summarization (noisegate's own contract forbids it; so should ours), the Hermes plugin/installer machinery, npm wrapper, in-band bypass markers.

## Build vs buy

**Build (borrow the patterns).** Noisegate is Python, 10 days old, 8 stars, single-maintainer, and structurally welded to Hermes hook semantics; glance is TypeScript/Bun and already owns the seed module (`gate-logs.ts` has offload + diff-aware packing + tail preservation). The transferable asset is the design discipline — dual failure polarity, protected surfaces, recovery-not-archive, no-gain rule, decision diagnostics — plus its preservation-pattern tables as a reference when writing ours (MIT, so lifting regex ideas is clean). Adopting the dependency would buy nothing glance can call.

## Status

- 2026-07-15: initial research pass (this document). Not yet chained into /plan.
