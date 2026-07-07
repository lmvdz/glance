# Policy-as-data + pre-execution gates (research #2 + #3)

## Outcome
An operator can tighten a live fleet with a data rule (no redeploy), and a big/risky diff no longer auto-lands unattended. Both fail-open and default-off.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| C-LAND land blast-radius gate | Stop a large/risky-path diff from auto-landing into main unattended | architectural | `src/land.ts`, `src/land-risk.ts` (new), `src/land-risk.test.ts` (new) |
| C-STORE policy store + evaluator | The shared substrate: `policy.json` + one pure `evalPolicy` | architectural | `src/policy.ts` (new), `src/policy.test.ts` (new), `schema/*` |
| C-RULES data-driven tool-call rules | The #2 headline: operator-added deny/ask rules tighten a live fleet | architectural | `src/agent-guard.ts`, `src/server.ts`, `src/runtime-settings.ts` |
| C-COST cost projection (shadow) | Project spend before dispatch/land; warn-only in v1 | research | `src/cost-gate.ts` (new), `src/squad-manager.ts`, `src/land.ts` |

## Order

| Batch | Concerns | Why |
|---|---|---|
| 1 | C-LAND | Self-contained, highest value×tractability, no store dependency. **Executed this pass.** |
| 2 | C-STORE | Shared substrate the rule-driven concerns consume. |
| 3 | C-RULES, C-COST | Consume C-STORE's evaluator; disjoint files. |

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| C-LAND | — | — |
| C-STORE | — | — |
| C-RULES | C-STORE | `grep -q "export function evalPolicy" src/policy.ts` |
| C-COST | — (shadow reuses buildScoreboard) | `grep -q "buildScoreboard" src/attribution-scoreboard.ts` |

## Notes
- Adversarial design (opus designer, code-verified) cut the grand 3-tier per-org engine to a flat deny/ask table whose schema makes widening unrepresentable — see DESIGN.md.
- **Execution status:** C-LAND executed + shipped this pass; C-STORE/C-RULES/C-COST decomposed and deferred to a follow-up execution (the durable plan is the handoff).
- Verified: `PendingRequest` ASK round-trip is live-agent-only → daemon-side ASK must park/block, never a synthetic pending (cmux black-hole lesson). `RISKY_RE` (squad-manager) already classifies destructive requests — reused.
