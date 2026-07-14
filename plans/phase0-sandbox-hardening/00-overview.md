# Phase 0 — Agent Sandbox & Secret Hardening

## Outcome
The security foundation the single-tenant + marketplace strategy stacks on. Two halves:
- **0a (ships now):** closes the live vectors on `main` — the gate's read-write `.git` mount (an agent can plant
  a hook that runs as *you*), unredacted gate logs, world-readable state files, and the residual API source-read
  holes. Zero sandbox dependency; each item is independently landable this week.
- **0b (opt-in sandbox → real containment):** brings the *existing* `--sandbox` path to a true containment
  contract so "sandboxed" stops being a false claim — non-root, `:ro` `.git`/`node_modules`, resource limits,
  STRICT gates, sandbox-inheritance on fan-out, host-tools, a default agent image, and one live-proven
  omp-in-container run. This is the precondition Phase 3's default-flip will stand on.

The default-sandbox flip itself is **Phase 3** (deferred with three code-verified reasons — see DESIGN.md).

## Work
| Concern | Half | Why it exists | Complexity | Touches |
|---|---|---|---|---|
| [01 Gate `.git` mount → read-only](01-gate-mount-readonly.md) | 0a | Live operator-RCE: agent gate code writes `.git/hooks` → runs as you on `git status` | architectural | gate-runner, proof, worktree |
| [02 Redaction: harden + apply to gate output](02-redaction.md) | 0a | Gate stdout persisted raw; redact misses `DATABASE_URL` values | mechanical | redact, proof, gate-logs |
| [03 Secret-file permission sweep](03-file-perms.md) | 0a | state.json/audit.jsonl/gate-logs are 0644; `appendDurable` has no mode | mechanical | dal/storage, dal/store, audit, gate-logs |
| [04 Residual API source-read holes](04-api-source-reads.md) | 0a | `/api/graph/commit?repo=<cwd>`, `/api/info` cwd, `registerProject` arbitrary path | architectural | server, squad-manager |
| [05 Per-tenant socket directory](05-socket-dir-scoping.md) | 0a | Global `<stateDir>/sockets` → cross-tenant socket injection | mechanical | agent-host, state-dir |
| [06 Harden the agent container](06-agent-container-hardening.md) | 0b | Runs as root, full egress, no limits, no mount discipline | architectural | sandbox-agent-driver |
| [07 Sandbox spawn policy](07-sandbox-spawn-policy.md) | 0b | Fan-out children don't inherit sandbox; silent host-downgrade; workflow silently un-sandboxes | architectural | squad-manager |
| [08 Host-tools over docker-exec](08-sandbox-host-tools.md) | 0b | `setHostTools?.()` silently no-ops on sandbox | mechanical | sandbox-agent-driver, squad-manager |
| [09 Default agent image + credential injection + live run](09-agent-image-and-live-run.md) | 0b | No image exists; in-container auth unproven — the acceptance gate | architectural | new Dockerfile, sandbox-agent-driver, image build |
| [10 Sandbox lifecycle operational hardening](10-sandbox-lifecycle-ops.md) | 0b | pid-less driver strands leases; no orphan reaper; no capacity metric | architectural | agent-driver/lease, squad-manager, metrics |
| [11 Env-scrub docker-boundary parity](11-env-scrub-docker-parity.md) | 0b | Verify no daemon secret crosses the container boundary | mechanical | spawn-env (voice dep), sandbox-agent-driver, tests |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 0a-1 | 01, 02, 03, 04, 05 | All mechanical, disjoint files, zero sandbox dependency — parallel, worktree-isolated, ship this week |
| 0b-1 | 06, 07 | The container-run hardening + the spawn policy that governs it; 07 depends on 06's contract |
| 0b-2 | 08, 10 | Host-tools + lifecycle ops; disjoint from each other, build on 06/07 |
| 0b-3 | 11 | Env-scrub parity — behind the voice branch landing |
| 0b-4 | 09 | Default image + live real-omp-in-container run — the acceptance gate for all of 0b |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01–05 | — | (0a is independent) |
| 06 | 01 (shares the containment-contract mount discipline) | gate `.git` mount is `:ro` |
| 07 | 06 | agent container run is hardened; `p.sandbox` is the field to inherit |
| 08 | 06 | SandboxAgentDriver speaks the docker-exec JSONL frame |
| 09 | 06, 07, 08, **voice-db-mode/02** | `src/secrets.ts` exists (org secret store) for credential injection |
| 10 | 06 | sandbox driver exists to reap/meter |
| 11 | **voice-db-mode/01** | `src/spawn-env.ts` exists on the voice branch |

## Not yet specified
- (none — the fog is in Phase 3's flip, which is out of scope here)

## Out of scope (→ Phase 3)
- **Default-sandbox flip** — architecturally unreachable + no image + container doesn't contain (DESIGN.md).
- **`untrusted` trust field + fail-closed branch** — its producer (the marketplace) is Phase 3; a dead flag now
  is a false security claim. Phase 0 ships the *plumbing shape* (sandbox-inheritance + hard-refusal) keyed on
  the real `sandbox` field, so Phase 3's `untrusted` is a one-line re-derivation into working machinery.
- **Protocol-agnostic containment wrapper** — the code assigns it to Phase 3 twice; scaffolding with no consumer.
- **Egress allowlist proxy** — `--network none` is the v1 posture; the proxy rides with the flip.
- **WorkflowDriver inner-agent containment** — part of the flip's re-architecture.

## Out of scope (delegated, not deferred)
- **Env-scrub implementation** — done on `worktree-voice-db-mode` concern 01; Phase 0 depends on it (concern 11).
- **At-rest secret encryption** — voice concern 02 (`src/secrets.ts`); Phase 0 consumes it (concern 09).

## Decisions so far
- [Flip deferred to Phase 3](DESIGN.md) — three independently sufficient, code-verified reasons.
- [Containment unit = the worktree](01-gate-mount-readonly.md) — `.git`/`node_modules` `:ro`, build overlay.
- [Trust taint keyed on `sandbox`, not a dead `untrusted` flag](07-sandbox-spawn-policy.md).
- [Voice-db-mode consumed as a dependency](11-env-scrub-docker-parity.md) — env-scrub + secret store.

## Notes
- Adversarial panel 2026-07-14; both red teams found criticals the draft missed and converged on the scope
  re-cut from opposite lenses (containment-escape and rollout). Detail in DESIGN.md.
- Three MODE:hitl open questions (operator-git protection, resource-limit values, credential-injection
  mechanism) live in DESIGN.md — resolve before/at 0b execution.
- Proceeded over the existing WIP pile with the operator's explicit go (this session).
