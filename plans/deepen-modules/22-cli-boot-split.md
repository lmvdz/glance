# index.ts → boot.ts + cli/client.ts + cli/render.ts
STATUS: done
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/index.ts (1,630 lines: cmdUp 255-line composition root; 17 proxy verbs, fetch ×14, !res.ok ×8; 5 test-only render exports)
MODE: afk

## Goal
Split by the DELETION TEST, not by "CLI vs not": (a) src/boot.ts — the composition root,
independently testable (its ordering is incident-documented, move verbatim); (b)
src/cli/client.ts — one api() helper + the proxy verbs as a declarative table (fixes the
!res.ok drift once); (c) src/cli/render.ts. The local-compute verbs (plan-validate, decompose,
curate-plane, doctor, land-assessment) are the ONLY entry points to their modules — they keep
their behavior, just organized.

## Provenance
Round-2 review, daemon agent, rank 5, Worth exploring.

## Done (2026-08-12, round 3 iteration 14 — PR pending)
index.ts 1,630 → 382 lines by the deletion test: boot.ts (cmdUp verbatim, hash-verified by
codex, incident ordering intact), cli/client.ts (ONE api() replacing ~14 fetch sites in 4+
drifted !res.ok shapes — including two verbs with NO check and one trusting body.ok over HTTP
status; four verbs became a declarative table), cli/render.ts. Executed by an implementation
agent under the deepen playbook, gated + reviewed here. Codex 2M+1L all fixed: promote --json's
machine-readable 409 refusals restored (the unification had broken a jq script contract), the
~18 changed error paths got regression pins (the old exit-0-on-error paths adjudicated as false
success, not contract), stale ownership comments re-pointed. Native check: origin's dispatch
had a DUPLICATE unreachable case-open, correctly dropped. Grok narration-only x2 (7th gap).
Gates: check 0, HELP byte-identical, root 5332/2-inherited, webapp 2002/0.
