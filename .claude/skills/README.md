# Agent recipe library

Distilled 2026-07-04 by mining all ~40 Claude Code session transcripts (~250MB JSONL, 5 parallel miners + 240 subagent transcripts) for recurring work shapes. Recipes are ranked by how often the shape recurred × how much manual babysitting it cost.

## Codified as skills (this directory)

| Skill | One-liner | Mined recurrence |
|---|---|---|
| `land-sweep` | Verify "merged" actually reached main; restack wrong-base PRs; harvest stranded branches + uncommitted worktree WIP; prove; sweep | all 5 miners, 8+ sessions — the #1 shape |
| `bounce` | Daemon restart + prove-new-code-is-serving, plus the "I don't see the change" staleness triage tree | 6+ sessions, 4 memory notes |
| `reality-audit` | plans × Plane × code-on-main three-way lie detector with adversarial verification | 4 sessions (one ran it as a 26-agent/1.74M-token ad-hoc workflow, then threw the script away) |
| `scratch-daemon` | Isolated throwaway daemon for live verification: boot/seed/drive/teardown + controlled pipeline dogfood + prove-preexisting | 6 sessions, ~10 spinups in one |
| `execute-plan` | Adversarial design panel → review-gated batches → audit gauntlet → stacked PRs → crash recovery (scripts in `references/`) | 6 workflow executions, 13/13 concerns shipped clean |
| `make-it-work` | (pre-existing) one lies→works fix per iteration, proven by running it | — |
| `effect` | Vendored from [kitlangton/skills](https://github.com/kitlangton/skills) (MIT, SHA `30dee860`; see `effect/PROVENANCE.md`) — opinionated Effect v4 guide (services/layers, schema, config, scheduling, caching, streams, HTTP clients, testing), adapted to this repo's `effect@4.0.0-beta.98` pin and gate-proven: every fenced TS example compiles in-process against that exact version | first `skills-verify`-gated skill; router + 8 references |

## Proposed skills (worth writing when the shape next fires)

- **untangle-wip** — disentangle the shared main checkout's working tree into owned threads (mine vs foreign session/daemon WIP), hunk-level staging, zero-foreign-marker verification before commit. (5 sessions; near-miss: almost shipped foreign code.)
- **unit-autopsy** — on-demand diagnosis of one squad unit: worktree mtime/diff/commits vs concern TOUCHES (off-script detector), verify-contention, main divergence, transcript tail → healthy/thrashing/off-script/stalled + the escalation ladder (scope-locked re-dispatch from a task file → after 2 failures, direct in-harness implementation).
- **webapp-crash-triage** — minified stack/white-screen → symbol→component mapping → API-boundary shape-drift root cause → `normalize*`-at-data-boundary fix pattern (house style) → deploy + served-bundle-hash confirm. (Same crash class 4+ times.)
- **incident-fix** — two-track discipline: immediate live unblock now, permanent fix + regression test + draft PR always, recurrence stakeout when the cause can re-arm.
- **docs-truth-audit** — parallel code-ground-truth extraction (CLI/routes/env/defaults) + per-section staleness audit; verify every dubious claim against code (caught a fabricated command and an overclaiming commit).
- **safe-rebrand-sweep** — classify occurrences display vs functional (env prefixes, state dirs, security regexes, protocol ids); compat shims first; user-facing sweep only; treat string-assertion test failures as classifier feedback. (Fires again at the glance deep rename.)
- **design-mock-then-port** — reference imagery → interactive HTML artifact mock (cheap iteration, ~15 rounds observed) → checkpoint commit of mock+DESIGN.md as draft PR → backend slice + tests → renderer port → live verify. (Shipped Fleet Pulse.)
- **live-ui-goal-review** — build → scratch-daemon → screenshot key surfaces with real data → critique ranked worst-first against the product goal → fix with regression tests → re-click the actual flows.
- **third-party-integration-verify** — ground the API against the installed package's dist (never memory); pure testable core first; live-drive the whole protocol incl. tampered payloads; hand the user the one dashboard step you can't do.
- **transcript-mining-diagnosis** — partition the session archive by size across parallel miners, one question each, verbatim quotes + dated events; grounding agent builds designed-vs-documented reality; synthesize ranked diagnosis → BRIEF → /plan. (Produced the direct-vs-glance diagnosis and this very library.)
- **session-recover** — worktree sessions key transcripts to the worktree's project dir; copy into the main project dir; `/resume` needs the full UUID, not the 8-char job id.
- **goal-gap-loop** — the /loop body that works: parallel goal audits → rank by leverage → 1-2 scoped fixes with tests → prove failures pre-existing → ledger + memory → stop when only operator decisions remain, and present them.

## Proposed daemon capabilities / code work (file as Plane tickets, not skills)

- **land-watch** — `glance watch <unit|issue>`: branch tip + landReady + automation log → fire on land/stall/fail with the reason; guards against the observed false positives (matching your own filing commit; stale watchers; timeout ≠ landed).
- **gate-sitter** — operator-side gate loop: poll for gates, surface plan docs, answer via the command API, detect dead-at-gate processes (frozen lastActivity) → restart then re-answer.
- **stranded-WIP consolidator** — daemonized `land-sweep` phase 2/3: the observer's `auditStrandedUncommitted` (shipped in PR #39) finds it; nothing yet harvests it automatically.
- **cross-agent invariant audit** — after multi-agent batches: verify each earlier agent's load-bearing invariants survived later rewrites (sibling of race-reviewer in the capability catalog).

## Proposed hooks (via /update-config)

- **push-integrity** (PostToolUse on `git push`) — `git ls-remote origin <branch>` SHA must equal local HEAD; rtk-summarized output once hid 6/8 failed pushes. Highest-stakes near-miss in the corpus.

## Cross-cutting boilerplate for every fan-out prompt

1. rtk mangles bash grep/gh/git output — Read/Grep tools or `rtk proxy`; distrust null results.
2. `PATH="$PWD/node_modules/.bin:$PATH" bun test`; the 2 WSL spawn flakes are pre-existing.
3. Absolute paths / repo-root cwd for gates (`cd` residue broke suites twice).
4. Big reports → file + pointer (notifications truncate).
5. Detached processes: separate exports + `nohup … &`; kill by port, not name.

## Top systemic pain points the recipes exist to kill

1. Merge-world integrity: MERGED ≠ on main (wrong-base stacks, never-pushed work, units-never-commit) → `land-sweep`, stacked-PR rules in `execute-plan`.
2. Fix-invisible-after-ship: global-install symlink, unbuilt dist, cache-pinned shell, service workers, stale tokens → `bounce`.
3. Status stores lie in every direction → `reality-audit`.
4. Shared checkout + shared sockets as collision zones → `scratch-daemon`, untangle-wip.
5. Tooling that lies (rtk mangling, swallowed pushes, truncated notifications) → boilerplate above + push-integrity hook.

## skills-verify: a truth gate for this directory

A skill doc is a claim about the codebase — "run `bun run check`", "`src/plane.ts` does X", "set
`OMP_SQUAD_AUTOSUPERVISE=0`". Nothing checked those claims until `scripts/skills-verify.ts`, which
runs automatically under `bun test tests/skills-verify.test.ts` (and therefore under `bun test`)
and gates every skill directly under this one — the set of names committed in
`COMMITTED_SKILL_NAMES` in that script. It fails closed: a broken link, a fenced TypeScript example
that no longer typechecks, a `` `bun run` `` command that names no real script, or an env var this
codebase never reads all turn the gate red, by design, the same way `defect-ratchet.ts` and
`effect-migration.ts` gate the `src/` tree.

This section documents the conventions the gate enforces. See
`plans/skills-hardening/01-skills-verify-gate.md` and `plans/skills-hardening/DESIGN.md` for the
full spec and the red-team reasoning behind each decision.

### Fence info-string grammar

A fenced code block's info string (the text right after the opening ` ``` `) can carry attributes:

```
```ts id=user-repo file=user-repo.ts
```
```ts id=main file=main.ts
import { UserRepo } from "./user-repo.js"
```
```ts no-verify reason="illustrative pseudocode, not a real API"
```

- **`` ```ts `` / `` ```typescript ``** blocks are typechecked. They require an `id=` (used in
  error messages and, absent `file=`, as the synthesized filename) unless the block is opted out
  with `no-verify`.
- **`file=<relative-path>`** is optional. Every ts block from the same doc that carries a `file=`
  is written into ONE synthesized directory for that doc, so blocks can `import` each other by
  relative specifier — write `./foo.js` in the example (bundler resolution maps the `.js`
  specifier to the synthesized `.ts` source, matching how this repo's own `verbatimModuleSyntax`
  + `moduleResolution: bundler` setup expects imports to look). Without `file=`, the block gets its
  own file named `<id>.ts` in that same per-doc directory.
- **`no-verify reason="..."`** opts a ts block out of typechecking entirely. The reason is
  mandatory and non-empty — an empty or missing reason is itself a gate violation. Every
  `no-verify` is counted per skill and checked against a committed ceiling
  (`NO_VERIFY_BASELINE` in `scripts/skills-verify.ts` — the vendored `effect` skill carries 2, for
  `@effect/vitest` examples this repo can't compile). Opting a NEW block out requires deliberately raising that skill's baseline
  in the same PR — the same ratchet discipline as `defect-ratchet.ts`'s `PATTERNS[].baseline`.
- A **deliberately-wrong** example (showing what NOT to do) stays verified rather than opting out:
  mark the erroring line `// @ts-expect-error` inside an otherwise-normal `ts` block. The gate
  fails if the expected error ever stops firing (TS2578), so the example can't silently drift into
  actually being correct without anyone noticing.
- **Untagged fences** (` ``` ` with no language at all) are fine in a file with no ts blocks
  (this repo's `blind-review` and `make-it-work` skills both use bare fences for prose templates).
  An untagged fence in a file that ALSO has a ts block is a hard failure — tag it or opt it out
  explicitly. `js`/`javascript` tags are verified the same as `ts` (a retag between code spellings
  changes nothing), fences opened with 4+ backticks are parsed like any other, and an unterminated
  fence is a hard failure (everything after it would silently leave the gate's view). Honest
  limitation: retagging a code example as ` ```text ` DOES drop it out of typechecking — the gate
  cannot know prose from code by content; that dodge is visible in review, not to the gate.

### Identifier-existence tier

Every skill's prose (and the inside of ` ```bash ` fences — bash examples make real claims too) is
scanned for three backticked patterns, whether or not the skill has any code blocks:

- `` `OMP_SQUAD_*` `` / `` `GLANCE_*` `` tokens must have a real read site somewhere in `src/**`
  (`process.env.X`, or `X` passed as a string literal to `envInt`/`envBool`).
- Backticked repo-relative paths (contain `/`, don't start with `http(s)://`, `~`, `$`, or contain
  a `<placeholder>` or `origin/`-style git ref) must exist on disk — checked relative to the
  skill's own directory first, then the repo root.
- `` `bun run <script>` `` must name a script in the root `package.json` or `webapp/package.json`.

False positives (a git branch name that happens to look like a path, a build artifact that only
exists after a build step) go in the committed `IDENTIFIER_ALLOWLIST` in `scripts/skills-verify.ts`
— never a silent skip. The allowlist's SIZE is itself ratcheted
(`IDENTIFIER_ALLOWLIST_BASELINE`), so growing it is a deliberate, reviewed act. Be conservative
about what you flag in the first place: when a token pattern is genuinely ambiguous, prefer
allowlisting it by name over widening the detection regex — a noisy gate gets deleted, not fixed.

### `verified-against` stamps

A skill's frontmatter can declare `verified-against: effect@4.0.0-beta.93`. The gate hard-fails
when that version doesn't match the currently-resolved `effect` pin (read from
`node_modules/effect/package.json`, cross-checked against `bun.lock`). The ONLY way to green a
stale stamp is:

```
bun run scripts/skills-verify.ts --stamp
```

which rewrites every stale stamp to the resolved version — but only once the rest of the gate
(typecheck, structure, identifiers) is already clean; it refuses to stamp over a genuinely broken
skill, and it hard-errors (never silently no-ops) if a stamp line fails to rewrite. Precisely
stated, the enforced invariant is: the stamp must EQUAL the currently-resolved version, and the
gate re-proves every example against that resolved version on every run — so a hand-edit to the
matching version is equivalent to stamping (the proof behind the number is the gate run itself,
not the tool that wrote it). Every `effect` version bump requires a `--stamp` re-run (or the
equivalent edit) in the same PR that bumps it.

### Advisory mode (`~/.claude/skills` and other external roots)

```
bun scripts/skills-verify.ts --roots ~/.claude/skills
```

runs the same five tiers (typecheck, workflow-file syntax, identifiers, structure, freshness) over
any directory — but ADVISORY only. The repo-manifest set-equality check and the `effect`-skill
tripwire (both specific to this repo's own committed skill list) are skipped, and nothing in this
repo's `bun test` suite scans anything but the default root (`.claude/skills`). The user-global
skills pipeline at `~/.claude/skills` is real and higher-traffic than this repo's own skills, but it
is explicitly OUT of this gate's authority — this command exists to let you point the same checks
at it by hand, not to make it part of `omp-squad`'s CI surface.
