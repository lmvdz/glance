# Observer log (Mastra observation store) — DROPPED
STATUS: cancelled
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: (none — decision record)

## Goal
Record why Mastra Code's headline pattern — a daemon-side background Observer writing an
append-only dated observation log, condensed by a Reflector — was **not** built for omp-squad,
so it isn't re-proposed.

## Decision: do not build
The adversarial design pass (2 red teams) established that a new observation store would
duplicate three existing subsystems and deliver ~zero standalone value under the hard
constraint (the daemon cannot touch a child `omp` process's live context window):

- **Payload already exists** — `src/digest.ts` `buildDigest` writes Goal / Summary
  (zero-token extractive `summarize()`) / Files touched / **Where we left off**, rebuilt on
  every `agent_end` via `finalizeRun`. That is the observation payload, per-turn, already.
- **Accumulation already exists** — `src/reflection.ts` is an append-only, dated, per-worktree
  JSONL note store with an LLM condense seam and an explicit "refutation not accumulation"
  discipline. A new log would be a third per-worktree prose store beside `digests/` and
  `reflections/`.
- **Injection already exists** — `src/fabric.ts` + `buildContextPrimer` inject cross-agent
  context at spawn (`src/squad-manager.ts:~2942`).
- **New bug surface** — the proposed in-memory cursor is a racy read-modify-write across
  fire-and-forget invocations (duplicate entries + double haiku spend), not restart-durable,
  and multi-KB JSONL appends can corrupt middle lines.

## If cross-turn accumulation is ever genuinely needed
Do NOT stand up a parallel log. Extend `src/reflection.ts` with a `kind: "progress"` variant,
or make `composeResumeTask`/the digest surfacing read the existing digest — whichever consumer
actually needs it. Concerns 01 and 02 already consume the digest, which is sufficient.

## Verify
n/a — decision record. Superseded by concern 01 (digest surfacing) and 02 (veto reprompt).
