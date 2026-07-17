# Design: ADW software-factory borrows

Source: plans/research-adw-software-factory/BRIEF.md. Adversarial round: sonnet designer, two fable red teams (correctness lens, simplicity lens), fable arbiter. Both red teams independently found the same four critical defects in the draft; every one is resolved below by reshaping, not patching.

## Approach

Five borrows, all build-the-pattern, reshaped by review into nine concerns:

- **Typed work lanes** — a closed 3-lane taxonomy (`hotfix` / `feature` / `chore`) classified at intake, carried on the unit, and used as a parameter key by model routing and cost gating. Not 5 lanes: docs and chore produce identical policy rows, and "investigation" already exists as ask-mode observer units that deliberately never land.
- **Promotion as a one-shot, plus the missing state gate** — the draft's daemon polling loop dies on two facts: the Dispatcher dispatches Backlog issues today (no state check anywhere in `Dispatcher.tick`), and the live Backlog offers ~2 promotable human tickets per week. The reshape: a dispatcher **state gate** (the single most load-bearing concern in this plan — without it there is no holding pen and "release to Todo" is theater), plus a human-triggered `glance promote` one-shot that authors Tier-1/Tier-2 enrichment via the existing ask-mode seam and fail-closes through `parseTier2`. Release = drag to Todo in Plane; no custom state, no polling loop, no budget env.
- **Containerize the last unsandboxed executor** — the draft's `runContainerized` primitive re-invented `gate-runner.ts`, which shipped, is default-on, and already owns `OMP_SQUAD_GATE_SANDBOX` with richer semantics. The real gap is exactly `src/validate.ts`'s commissioning-gate spawns (scout ticket OMPSQ-160 already names it). Route those through the existing `execGatedCommand` and stop.
- **Race-once at real gate exhaustion** — the draft hooked `fileLandBlockedEscalation`, where work has already *passed* its gates and is blocked on land infrastructure; racing there is waste plus a manufactured double-land. The correct seam is the workflow catastrophe terminal (visit-cap exhaustion), where a fresh-context alternate-strategy sibling is genuinely different from the same-lineage fixup cascade. Original parks first; a persisted race key makes it once-per-issue.
- **Evidence-gated enforcement** — per-lane model-route apply and real cost-gate enforce (closing the deferral `cost-gate.ts` names in its own header), with a prerequisite the review surfaced: the cost aggregate must be **lane-keyed** before any lane enforces, or the first deny is wrong on arrival. Every shadow mode ships with a named exit (scoreboard surface + review checkpoint) — the model-route ledger sat empty for a month; shadow-forever is the observed failure mode.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Lane taxonomy | Closed 3-value union, code-level | 5 lanes; extensible config taxonomy | Only 3 distinct policy rows exist; unions widen cheaply and shrink expensively |
| Lane transport from Plane | Labels, read on the per-issue detail fetch the dispatcher already makes | Title-tag `[lane:x]` convention | Titles are LLM-writable (Scout files them verbatim) — a fail-open security key; labels are human-set, and the detail call already resolves label names |
| Lane precedence + clamp | operator `opts.lane` > Plane label > classifier > `feature`; label/classifier lanes may only move privilege axes (model spend, ceilings) in shadow or stricter | Unclamped precedence | Ticket text must never buy privilege; mirrors the fail-safe-only direction of `do-not-auto-land` |
| Lane policy storage | Hard constants in `src/lane.ts`; operator override via the existing `policy.json` store (extend the dispatch seam subject) | New `OMP_SQUAD_LANE_POLICY` env-JSON schema | The repo already has two per-unit config systems and 179 `OMP_SQUAD_*` vars; a third config system is operator debt. Fail-soft env-JSON decode is also the wrong posture for policy |
| Lane × outcome matrix | Lane stays OUT of the `${mode}:${tier}` matrix key; it sets per-call router params | Third key dimension | Fragmenting thin cells delays every cell past its sample floor — model-route's own discipline |
| Promotion trigger | Human-triggered one-shot (CLI + web button) | Daemon polling loop | Measured trigger volume ~2/week; a loop needs budget envs, multi-org guards, and idempotency machinery the volume doesn't justify |
| Promotion state machine | Backlog = unreleased, Todo = released; no custom state | "Promotion Review" custom Plane state | The dispatcher state gate makes Backlog a real holding pen; two states already express the whole machine |
| Gate containment | Route `validate.ts` spawns through existing `gateExec` | New `runContainerized` primitive; shadow host-vs-container diff | Primitive exists, is default-on, fail-closed, and owns the env contract; a second docker path forks security plumbing that will drift. Shadow diff = zero security during shadow + nondeterministic noise |
| Sandbox-by-default for units | **Deferred** to the workflow-node containment spike (aligns with factory-control-plane concern 04) | Flip defaults now | Dispatched units are workflow-kind; `makeDriver` ignores `sandbox` for them — the flip would report containment while running on host (false-green), and regress explicit sandbox spawns. Also `--network=none` kills agent model calls |
| Race-once seam | Workflow catastrophe terminal (visit-cap), park original, persisted race key | `fileLandBlockedEscalation` | Land-blocked work already passed gates — racing it is waste plus double-land; in-memory escalation dedup resets on restart |
| Cost enforce prerequisite | Lane-keyed O(1) rolling aggregate (model+tier+lane, lane-agnostic fallback below min-sample) | Enforce against existing model+tier projection | A chore ceiling checked against feature-dominated history denies wrongly on arrival |
| Enforcement rollout | chore lane first; hotfix/feature stay shadow/ask; flips are operator actions | Global flip; auto-tuning | Measured-escalation over the framework's static prescription; auto-flip reintroduces the router-grading-itself circularity |

## Risks

- **Dispatcher state gate is a behavioral migration** — today raw Backlog tickets auto-dispatch; after the flip they wait for promotion/release. Shipped flag-gated with an explicit default-flip step so the operator chooses the cutover.
- **Prompt-injection chain remains real** — Scout ticket → promoter enrichment → spec injected into a yolo agent's prompt. Mitigations: promoter refuses `do-not-auto-land` tickets, validator checks the *injectable* (truncation-applied) form, release requires a human drag. Residual risk accepted and documented; the human tap is the trust boundary.
- **Race-once sibling bookkeeping** — claimed/ledger interplay, deterministic branch names, escalation suppression. Sized as its own concern with the persisted race key as the invariant.
- **Shadow-forever** — every shadow mode here names its exit surface and review checkpoint in the concern's Verify section.

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| Backlog is already dispatchable; promoter races dispatcher; permanent ledger makes the loss unrecoverable (both RTs) | critical | New concern 03 (dispatcher state gate) is now the promoter's prerequisite; promotion is one-shot; release = Todo |
| `runContainerized` re-invents shipped `gate-runner.ts`; `OMP_SQUAD_GATE_SANDBOX` already exists with different semantics (both RTs) | critical | Concept collapsed to routing `validate.ts` through `execGatedCommand` (closes OMPSQ-160); no new primitive, no new env var |
| Sandbox-by-default no-ops for workflow-kind units and regresses explicit sandbox spawns (both RTs) | critical | Deferred to workflow-node containment spike; recorded in overview with factory-control-plane pointer |
| `--network=none` kills sandboxed agents' model calls (RT2) / acceptance gate needs network (RT1) | critical | Agent injection dropped with the deferral; acceptance container gets an explicit per-call network decision in concern 06 |
| Race-once hooks land-blocked, not gate exhaustion; double-land; restart re-fire (both RTs) | critical/significant | Moved to catastrophe seam; original parked before sibling spawns; race key persisted |
| Lane via title tags = attacker-writable privilege key (RT1) | critical | Plane labels + clamped precedence; privilege axes never from ticket text |
| LanePolicy = third config system; env-JSON fail-soft posture (RT2/RT1) | significant | Hard constants + existing policy store; no new env schema |
| Promoter idempotency, multi-org double-writes, WIP starvation, `create()` throw at cap (RT1) | significant | One-shot trigger removes the loop; promotion marker + re-read-before-write; uses the real ask-mode entry, not raw `create` |
| `movePlaneIssueToState` group-fallback fails open to Todo (RT1) | significant | Named-state-or-no-write contract in concern 04 |
| Validator validates shape not trust; 4000-char spec truncation cuts validated sections (RT1) | significant | Validate the injectable form; skip quarantined tickets; human release documented as the trust boundary |
| Lane-blind cost projection vs lane ceiling (RT1) | significant | Concern 08 makes the aggregate lane-keyed before concern 09 enforces |
| Shadow evidence with no reader (RT2) | significant | Named shadow exits per concern |
| 5 lanes where 3 rows exist; `[lane:x]` colon breaks `titleTokens` (RT2) | minor | 3-lane union; title tags dropped entirely |
| Per-lane `minEdge` repurposes documented test-only seams (RT2) | minor | One deliberate paragraph in concern 09; overrides stay operator-config |

## Open Questions

None blocking. Two items deliberately deferred with pointers recorded in `00-overview.md`: workflow-node containment (factory-control-plane 04) and dispatch-level best-of-n racing.
