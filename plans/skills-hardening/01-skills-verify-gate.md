# skills-verify gate: prove skill docs the way we prove code
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: scripts/skills-verify.ts, tests/skills-verify.test.ts, .gitignore, .claude/skills/README.md

## Goal
A fail-closed gate over `.claude/skills/**` that (a) typechecks every fenced TypeScript example against the actually-resolved `effect` pin, (b) verifies prose identifiers exist in the code they describe, (c) enforces structure (frontmatter, no dangling reference links, size caps) and freshness (`verified-against` stamps). Runs automatically under `bun test` like the other ratchet gates.

## Approach
`scripts/skills-verify.ts` exports a `runSkillsVerify(roots: string[])` returning a structured report; `tests/skills-verify.test.ts` imports and drives it (the test IS the entry point — nothing else invokes the script, and importing it also gets it typechecked/loaded; mirror `tests/defect-ratchet.test.ts`).

**Extraction**: parse top-level fenced blocks in `*/SKILL.md` and `*/references/*.md`. Blocks tagged `ts`/`typescript` require an info-string `id=` and optional `file=` (relative path). Blocks sharing a reference doc synthesize into one package (dir per doc) so multi-file progressive examples (`import { UserRepo } from "./user-repo.js"`) resolve — bundler resolution maps `.js` specifiers to `.ts` sources. Opt-out only via `no-verify reason="..."` (non-empty). Untagged fences inside a file that contains any ts block = hard fail (kills the retag-to-text dodge). Deliberately-wrong examples stay verified and carry `// @ts-expect-error` (TS2578 fires when the error stops existing).

**Typecheck (in-process — do NOT shell out to tsc)**: `import ts from "typescript"`; load root tsconfig options via `ts.getParsedCommandLineOfConfigFile`; synthesize files under repo-root `.skills-verify/` (wipe-then-write; explicit rootNames from the in-memory manifest, never dir globs — dot-dir include globs match nothing, reproduced); `ts.createProgram({rootNames, options})`; **assert `program.getRootFileNames().length === manifest.length`** before trusting diagnostics; map diagnostics back to `skill/block-id`. Resolved effect version: read BOTH `node_modules/effect/package.json` and `bun.lock`; hard-fail with "node_modules absent/stale — run bun install" when missing or disagreeing (fresh worktrees have lock but no node_modules).

**Identifier-existence tier (all skills, including the 5 with zero code blocks)**: backticked tokens matching `^(OMP_SQUAD|GLANCE)_[A-Z0-9_]+$` must appear in an env-read site in `src/**` (`process.env`, `envInt`, `envBool`); backticked repo-relative paths (contain `/`, exist-checkable) must exist; `` `bun run <script>` `` must match a `package.json` script; `references/*.workflow.js` files syntax-check via `new Function`-free parse (`Bun.Transpiler` or `ts.createSourceFile` + diagnostics). False positives go in a committed allowlist whose size is ratcheted, never silently skipped.

**Structure & freshness**: skill = directory containing SKILL.md; committed manifest of skill names compared by set-equality (readable diff on drift); frontmatter requires `name` + `description`, tolerates extended keys (`license`, `compatibility`, `verified-against`, `vendored-from`); every relative link/reference path in a SKILL.md resolves; size caps over ALL files in the skill dir (md and .workflow.js — caps set from measured reality once 02 lands, generous headroom); any skill carrying `verified-against: <pkg>@<version>` hard-fails when `<version>` ≠ currently-resolved. `--stamp` mode (run via `bun run scripts/skills-verify.ts --stamp`) rewrites stamps to the resolved version only after a green verification pass — the documented way to green a bump.

**Fail-closed accounting**: `no-verify` count per skill ratcheted against a committed baseline (decrements committed, like `scripts/defect-ratchet.ts`); reasons printed in every run's output; tripwires: manifest non-empty, ≥1 ts block verified once 02 lands (encode as: the `effect` skill, when present in the manifest, must contribute ≥1 verified block).

Add `.skills-verify/` to `.gitignore` in the same commit. Document the conventions (info-string grammar, stamp workflow, escape-hatch policy) in `.claude/skills/README.md`.

## Cross-Repo Side Effects
None. `--roots` flag allows advisory (non-gating) runs over `~/.claude/skills`; user-global skills are explicitly OUT of the gate's authority — say so in the README section.

## Verify
`bun test tests/skills-verify.test.ts` green on the current tree (8 skills, prose tier + structure only); mutation tests: break a frontmatter field, dangle a reference link, plant a fake `OMP_SQUAD_NOPE` token, plant a ts block with a type error → each turns the gate red with a message naming the skill/block; delete all skills → manifest set-equality fails (not a vacuous pass); `--stamp` on a stale stamp greens it only after the program actually ran (assert via report counts).

## Resolution
Commit `0f6028e` — scripts/skills-verify.ts (911 lines, five tiers: in-process typecheck via ts.createProgram with explicit rootNames, workflow-file parse, identifier existence, structure/size, verified-against freshness) + tests/skills-verify.test.ts (21 tests including permanent mutation fixtures). Gate green on the pre-vendor tree with 6 justified allowlist entries; all three planted-defect mutations (fake env token, ts type error, broken frontmatter) turned it red with messages naming skill/block. Live: the gate caught a real upstream API drift during 02 (`Schedule.tapInput` removed by beta.98). scripts/skills-verify.ts added to tsconfig include by name (mirrors dto-conformance.test-d.ts).
