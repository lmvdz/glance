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
- [01 skills-verify gate](01-skills-verify-gate.md) — shipped (`0f6028e`); five tiers, mutation-proven fail-closed; caught real upstream drift (`Schedule.tapInput` gone at beta.98) during 02.
- [02 vendor effect skill](02-vendor-effect-skill.md) — shipped (`8bba2d1`); 24 ts blocks gate-verified at beta.98, 2 ratcheted no-verify (vitest-only examples), 3 genuine upstream compile defects fixed, stamped `verified-against: effect@4.0.0-beta.98`.
- [03 effect bump](03-effect-bump-attempt.md) — shipped (`ca863d0`); beta.93→beta.98, zero src changes; its full-suite run exposed 04's cold-adopt re-append bug.
- [04 Do-Not dispatch block](04-donot-dispatch-constant.md) — shipped (`74d31d8` + idempotence fixup); live-verified in a scratch daemon.
- [05 failure-memory default on](05-failure-memory-default-on.md) — shipped (`462234b`); single FLAG_DEFAULT source of truth; live-verified: seeded annotation surfaced as "Do not repeat: …" in a real spawn's primer, `=0` suppresses it.

## Notes
- auto-approved: headless (research→plan pipeline, 2026-07-15). EXPLORE/DESIGN/DECOMPOSE checkpoints recorded here and in DESIGN.md; EXECUTE not auto-started per gate policy.
- Phase 0 WIP snapshot: proceeded over 13 plans with open concerns (41 open; oldest cohort dated 2026-07-15 in scanner output — mtime-based, not authorship). Debt logged, not hidden.
- Adversarial design ran with 2 red teams; 5 critical findings, all resolved in DESIGN.md's concerns table. Notably two draft mechanisms were provably inert (dot-dir tsconfig globs; profile.memory for profile-less units) — caught before any code was written.
- `/plan-to-plane` not yet run for this plan; run it when work should become trackable Plane issues (project OMPSQ).
- EXECUTED 2026-07-15 (same session, user-authorized): 5/5 concerns done. Audit: full canonical suite green across 3 runs, 0 fail each (two runs showed the pre-existing "unhandled error between tests" ACP flake — proven at the beta.93 baseline by 03's rollback test at 2/5 and reproduced 1/5 in isolation on the final tree — plus one non-reproducing cross-file teardown flake on the first run — `state.json save failed` ENOENT under tests/land-seam's temp dir, 0/8 isolated repros, both flag arms clean; second run fully green); live scratch-daemon pass for 04+05 (probe unit via `--bin /bin/true`: Do-Not block ×1, "Do not repeat: <seeded rootCause>" primer line, effect pointer under the pre-review daemon-rooted contract; `OMP_SQUAD_FAILURE_MEMORY=0` suppresses the failure line only). The review round then CHANGED the pointer contract (repo-keyed, stamp-quoting) — its post-change coverage is the real-`create()` cases in tests/donot-block.test.ts, which drive the same composition path the live probe exercised. Incidental finding, not from this diff: the unverified-harness gate refused `claude-code` (works as designed).
- REVIEW GAUNTLET (`/code-review high`, 26 agents + blind grok pass on the plans/-excluded diff) surfaced 13 briefed + 3 blind-only findings — ALL fixed in `c44136e`. The blind-only three were fail-opens in the gate itself: a missing synth tree read as vacuous green (file-less diagnostics were skipped), assignment-form env tokens (`X=1`) were invisible to the identifier tier (and its own fixture test was vacuous), and code-lang retags/4-backtick/unterminated fences escaped scope. Briefed highlights: untrusted primer text could suppress the "unconditional" Do-Not block (join moved pre-primer), the effect pointer named the daemon install's caret range instead of the unit repo's gate-maintained stamp (now repo-keyed + stamp-quoting, refreshed contract in tests/donot-block.test.ts), `--stamp` could report success on a silent no-op rewrite, legacy `=false`/`=off` spellings would have been flipped ON by the default change, and three prose surfaces (AGENTS.md, SKILL.md body, skills README) carried version claims no gate tier could see. Deliberately left: O(n·m) lineAt (bounded corpus), `text`-retag dodge (documented as out of scope in the README).
