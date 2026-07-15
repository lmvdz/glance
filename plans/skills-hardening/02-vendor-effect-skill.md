# Vendor the kitlangton effect skill, adapted and gate-proven
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: .claude/skills/effect/** (new), .claude/skills/README.md, tests/skills-verify.test.ts (manifest + baseline updates)
BLOCKED_BY: 01

## Goal
`.claude/skills/effect/` exists: Kit Langton's Effect v4 skill (SKILL.md router + 8 references/*.md), adapted to our resolved pin and our recorded Effect v4 gotchas, with every TypeScript example proven by the skills-verify gate.

## Approach
Vendor from `kitlangton/skills` at SHA `30dee8607214c893dd89f6eee65c669ef3dce8c9` (MIT) via `gh api` / `git show <sha>:path` — single edited copy, no pristine in-repo duplicate. Ship alongside it:
- upstream `LICENSE` verbatim (MIT requires it to travel);
- `PROVENANCE.md`: upstream URL, SHA, vendor date, explicit adaptation list, re-vendor runbook (fetch new SHA → diff against RECORDED old SHA, not our copy → re-apply adaptations → bump stamps → gate);
- `vendor.patch`: pristine→edited diff captured at vendor time (upstream is young/single-author; a force-push or deletion must not orphan our provenance).

Adaptation pass (each item recorded in PROVENANCE.md):
1. Retarget the Source Rule and all version references at OUR resolved pin (read at vendor time — beta.93 today, or newer if 03 landed first); review effect changelogs between upstream's reviewed version and ours for semantic drift in prose claims.
2. Annotate every ts block with `id=` (+ `file=` for multi-file progressive examples per the 01 grammar); give blocks their imports where upstream relied on earlier-block context; deliberate-wrong "Do not" examples get `// @ts-expect-error` inside verified blocks, not `no-verify`.
3. Fold our recorded Effect v4 gotchas (memory: effect-setup lessons from PRs #76/#81–#87, e.g. the `Number(env)||default` zero-eating class) into the relevant references as extra Do-Nots.
4. Demote the self-export namespace pattern (upstream itself flags it "unusual") to a clearly-optional aside unless it matches our house style — check `src/` conventions first.
5. Frontmatter: keep upstream `license`/`compatibility` keys; add `vendored-from: kitlangton/skills@30dee860...`; add `verified-against` via `--stamp` after the gate runs green.
6. Measure real file sizes and set the gate's size caps from them (01 left caps provisional); update the gate's skill-name manifest and no-verify baseline.
7. Add the effect skill to `.claude/skills/README.md`'s catalog.

## Cross-Repo Side Effects
None.

## Verify
`bun test tests/skills-verify.test.ts` green with the effect skill contributing its blocks (report shows >0 verified ts blocks; tripwire from 01 now armed); `git apply --check vendor.patch` reproduces our copy from the pristine fetch; a spot semantic review: pick 3 APIs the skill prescribes and confirm against `node_modules/effect` source that behavior matches prose at our pin.
