# Self-drive: background loops and autonomy

omp-squad runs several background loops that keep the fleet moving without operator input.

## Background loops

- **Orchestrator** — periodic tick: auto-lands idle agents whose work verifies green, self-heals
  red gates through the failure router, drains cap-parked spawns back in under the WIP ceiling.
  On by default; `OMP_SQUAD_AUTODRIVE=0` disables it.
- **Scout** — scans agent reasoning for latent backlog items (bugs, follow-ups, tech debt, risks)
  and files them to Plane for human triage. Fires mid-run (periodic sweep) and at run-end.
- **Observer** — audits operational fleet state: stale branches, red gates, land failures;
  files actionable issues.
- **Auto-dispatch** — polls Plane for new open issues and spawns routed agents (when Plane is
  configured). `OMP_SQUAD_AUTODISPATCH=0` to disable.

## Scout LLM-call budget

The Scout makes one LLM call per scan. In a verbose multi-agent fleet this can add up quickly.
Cap it with `OMP_SQUAD_SCOUT_MAX_CALLS_PER_HOUR` (default `30`; `<=0` for unlimited). The limit
is a sliding window over the trailing hour, checked before each scan. Monitor current usage via
`omp-squad automation` or `GET /api/automation`.

## Loop failure visibility

Background loop failures are no longer swallowed silently:

- Transient Plane poll errors get one automatic retry before being recorded.
- Each loop iteration records its outcome (success, error, items filed, LLM calls used) to the
  automation log.

Use `omp-squad automation [--window 1h] [--loop <name>]` to see what each loop has been doing,
or `GET /api/automation` for the raw feed. The dashboard's **Automation** panel shows the same
feed live — useful for confirming the Scout is running, seeing how many issues it filed, and
spotting recurring Plane-poll errors before they become a pattern.
