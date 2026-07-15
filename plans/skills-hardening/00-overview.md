# skills-hardening

Truth gate for the agent-facing docs/skills layer + the delivery fixes the red team proved were missing. Source: [research brief](../research-kitlangton-skills/BRIEF.md), [DESIGN.md](DESIGN.md).

## Outcome
- Skill docs can't lie silently: TS examples compile-proven at the resolved effect pin, prose identifiers existence-checked, freshness tool-stamped, all fail-closed under `bun test`.
- Fleet units writing Effect code get an authority-authored, gate-proven skill; every unit gets evergreen Do-Nots; recorded recurring failures reach unit primers by default.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| [01 skills-verify gate](01-skills-verify-gate.md) | Docs layer has no fail-closed edge; drift class already bitten (prose identifiers) | architectural | scripts/, tests/, .gitignore, skills README |
| [02 vendor effect skill](02-vendor-effect-skill.md) | Units write Effect v4 with zero guidance; upstream corpus is compile-proven authority | architectural | .claude/skills/effect/**, tests |
| [03 effect bump attempt](03-effect-bump-attempt.md) | Shrinks 02's adaptation delta; beta line must be crossed pre-stable anyway | mechanical | package.json, bun.lock, src/** |
| [04 Do-Not dispatch constant](04-donot-dispatch-constant.md) | Both draft Do-Not channels provably never reach dispatched units | mechanical | agent-profiles.ts, squad-manager.ts |
| [05 failure-memory default on](05-failure-memory-default-on.md) | Lesson-transport mechanism built, wired, and dark by default | mechanical | squad-manager.ts, observer.ts, fabric-search.ts |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 03, 04 | Disjoint TOUCHES; 01 is the keystone; 03 independent timeboxed attempt |
| 2 | 02, 05 | 02 needs the gate to prove the vendor commit; 05 shares squad-manager.ts with 04 |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 02 | 01 | `test -f tests/skills-verify.test.ts && bun test tests/skills-verify.test.ts` |
| 05 | 04 | `git log --oneline -5 -- src/agent-profiles.ts` shows DO_NOT_BLOCK landed |
| 01, 03, 04 | — | — |

## Not yet specified
- (none)

## Out of scope
- Hardening `~/.claude/skills` (user-global pipeline skills) — outside repo gate authority; 01 ships an advisory `--roots` mode and names the exclusion. Revisit as its own initiative if advisory runs find real drift.
- Router-restructure of repo skills (research concept 4) — repo skills measured 4–8KB, already small; reduced to the size-cap lint inside 01.
- Multi-harness skill delivery (codex/grok units read AGENTS.md, not .claude/skills) — the 04 pointer line partially mitigates; full parity is a harness-registry question, not a docs question.

## Decisions so far
- [DESIGN.md](DESIGN.md) — in-process compiler API, identifier-existence tier, tool-stamped freshness, unconditional Do-Not join, vendor-at-our-pin with independent bump concern.

## Notes
- auto-approved: headless (research→plan pipeline, 2026-07-15). EXPLORE/DESIGN/DECOMPOSE checkpoints recorded here and in DESIGN.md; EXECUTE not auto-started per gate policy.
- Phase 0 WIP snapshot: proceeded over 13 plans with open concerns (41 open; oldest cohort dated 2026-07-15 in scanner output — mtime-based, not authorship). Debt logged, not hidden.
- Adversarial design ran with 2 red teams; 5 critical findings, all resolved in DESIGN.md's concerns table. Notably two draft mechanisms were provably inert (dot-dir tsconfig globs; profile.memory for profile-less units) — caught before any code was written.
- `/plan-to-plane` not yet run for this plan; run it when work should become trackable Plane issues (project OMPSQ).
