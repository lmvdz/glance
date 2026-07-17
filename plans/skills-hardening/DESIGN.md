# Design: skills-hardening — a truth gate for the agent-facing docs layer

Source research: [plans/research-kitlangton-skills/BRIEF.md](../research-kitlangton-skills/BRIEF.md). Adversarial design ran 2026-07-15 (designer + 2 red teams + arbiter); auto-approved: headless.

## Approach

Extend the repo's ratchet-gate suite with a **skills-verify gate** that makes agent-facing skill docs provable the same way code is: TypeScript examples typecheck against the actually-resolved `effect` pin, prose identifiers (env vars, paths, script names) must exist in the code they describe, and structural claims (frontmatter, reference links, freshness stamps) are enforced fail-closed. On top of that verified layer: vendor Kit Langton's Effect v4 skill (the only dense TS-example corpus), and fix the two delivery gaps the red team proved — evergreen Do-Nots ride the unconditional dispatch-prompt join, and the already-built failure-memory→primer path gets its default flipped on.

The gate runs **in-process** (TypeScript compiler API inside the gate test, explicit root files from the extraction manifest) rather than shelling to `tsc` — red team reproduced that the shell-out design fails structurally (dot-dir include globs match nothing; the repo's gate classifiers are bun-test-shaped and prove nothing about tsc output; `node` is not in the sandbox image contract).

## Key decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| TS verification mechanism | Extract fenced ts blocks from skill markdown; synthesize per-reference-doc packages (`file=` info-string axis); in-process `ts.createProgram` with explicit rootNames; assert rootNames count == manifest count | Shell out to tsc with synthesized tsconfig; hand-maintained mirror fixtures | Typechecks what ships (no mirror drift — the DTO-mirror class); explicit files dodge the reproduced dot-dir glob trap; structural proof-of-work replaces regex-over-stdout; no new sandbox binary |
| Prose claims | Identifier-existence tier over ALL skills: backticked `OMP_SQUAD_*`/`GLANCE_*` ↔ real env-read site; backticked repo-relative paths exist; `bun run X` ↔ package.json scripts; `.workflow.js` references syntax-checked | ts-blocks-only (draft) | 5 of 8 skills have zero code blocks; every historically observed doc-drift incident was prose identifiers, not TS |
| `verified-against` semantics | Tool-stamped only (`--stamp` rewrites to exact resolved version after a green run); gate hard-fails on mismatch with currently-resolved version | Hand-edited hard-fail; warn-with-ratchet | Hand-editing certifies a YAML edit, not a re-verification; stamping couples the green state to an actual proof run. Resolved version read from node_modules AND lockfile — legible failure when they disagree or node_modules is absent (fresh worktrees) |
| Escape hatches | `no-verify reason="..."` count ratcheted per skill against committed baseline; reasons printed every run; untagged fences in ts-bearing files = hard fail; deliberate-wrong examples use `@ts-expect-error` inside verified blocks (fails when the error stops existing) | Unbounded opt-out; count floors like `blocks >= 8` | Count floors are brittle on refactors and soft against the retag-to-text dodge; ratchet makes opting out monotonically expensive; set-equality manifest of skill names replaces scan-count floors |
| Vendoring | Single edited copy at `.claude/skills/effect/` + upstream LICENSE + PROVENANCE.md (SHA `30dee860`, adaptation list, re-vendor runbook) + committed `vendor.patch` (pristine→edited diff) | Pristine copy + overlay merge; cherry-pick content into our own docs | Overlay = a generated file with no compiler edge (the class this design eliminates); vendor.patch keeps the diff reconstructable if upstream force-pushes/vanishes |
| Vendor version direction | Adapt examples to OUR resolved pin (beta.93 today); the effect bump to latest beta is a separate, independent concern | Bump repo to beta.97 first, then vendor pristine | Guidance must be proven at the version units actually build against; coupling a daemon-wide dependency bump into a docs plan is unjustified blast radius. If the bump lands first, adaptation delta shrinks; the gate re-stamps cheaply in either order |
| Do-Not delivery | Exported constant (~10 evergreen lines) in the unconditional `appendSystemPrompt` join (precedent: `VERDICT_FIRST_BLOCK`); plus flip `OMP_SQUAD_FAILURE_MEMORY` default on with the existing Variant metrics as measurement | `profile.memory` seam; new fabric KbDocType; static list only | `profile.memory` provably never reaches profile-less dispatched units (same bug class R3 fixed for the primer); failure-memory→primer is built, wired, and dark — flipping it is the highest-leverage single action in this problem area |
| Size lint | All files in skill dirs (md and .workflow.js), caps set from measured reality at vendor time | md-only, guessed caps | Upstream corpus likely violates guessed caps day one; the largest file in the tree today is a .workflow.js the md-only lint would exempt |
| Reach | Gate covers repo `.claude/skills/**`; script accepts `--roots` for advisory (non-gating) runs over `~/.claude/skills`; exclusion of user-global skills named explicitly | Pretend "the docs layer" is hardened | The user-global pipeline skills are higher-traffic but outside the repo's gate authority; honesty over coverage theater |

## Risks

- **Extraction fragility**: tight parser scope (top-level fences, ts/typescript tags); ambiguous or untagged-in-ts-file fences hard-fail rather than skip.
- **Effect bump coupling**: every effect version bump now also requires `--stamp` re-run in the same PR. Rare, deliberate, documented in the convention.
- **Identifier-tier false positives**: prose can legitimately name hypothetical paths/vars. Conservative token patterns + ratcheted allowlist, not silent skips.
- **Vendored guidance semantic drift** (beta.97-authored prose at beta.93): compile-proven but behavior described in words can differ; adaptation pass reviews changelogs beta.93→97; residual risk accepted and recorded in PROVENANCE.md.
- **Failure-memory flip blast radius**: every spawn's primer may grow; bounded by existing topK=6; measured via existing Variant metrics; trivially reversible env default.

## Red team concerns addressed

| Concern | Severity | Resolution |
|---|---|---|
| Dot-dir tsconfig include matches zero inputs (reproduced) | critical | In-process compiler API, explicit rootNames |
| gateRunUnrunnable/greenGateUnproven vacuous on tsc output | critical | Structural proof-of-work (rootNames count + diagnostics), classifiers not borrowed |
| Upstream examples are multi-file progressive programs | critical | `file=` info-string axis; one synthesized package per reference doc |
| Gate verifies only the imported skill; prose drift unverified | critical | Identifier-existence tier over all skills |
| Do-Not channels dead by default (flag off; profile.memory misses dispatched units) | critical | Unconditional join constant + flag-flip concern |
| `node` not in sandbox image contract; degraded-image fail-open replay | significant | Moot in-process |
| verified-against source split (node_modules absent in fresh worktrees) | significant | Read both, legible hard-fail on disagreement |
| Hand-edited hard-fail trains rubber-stamping | significant | Tool-stamped only |
| Unbounded no-verify; brittle count floors; retag dodge | significant | Ratcheted no-verify, manifest set-equality, untagged-fence rule |
| Size caps guessed below vendored corpus | significant | Measure at vendor time |
| Bump-first-then-vendor | significant | Split: bump is its own independent concern; vendor adapts to resolved pin |
| SHA-as-pristine fragile on young repo | minor | Committed vendor.patch |
| Upstream frontmatter has extra keys (license, compatibility) | minor | Lint tolerates extended keys |
| skillsScanned>=9 counts README | minor | Skill = dir containing SKILL.md; manifest set-equality |

## Open questions

None blocking. `/plan-to-plane` filing and EXECUTE are deliberately not auto-started (headless run).
