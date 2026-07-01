# Spawn-time requires check + post-run produces audit (git-diff sourced)

STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts
PLANE: OMPSQ-346 — https://app.plane.so/inkwell-finance/browse/OMPSQ-346/

## Goal
Enforce the scope contract at the two points it matters: (1) at spawn, warn (or block,
for operator-declared) when a unit's `requires` collides with a live unit's write scope;
(2) after a run, audit declared `produces` against what the agent ACTUALLY changed —
sourced from the **branch git diff**, never the receipt's tool-frame `filesTouched`
(red team A-S4: `filesTouched` comes from omp tool frames at `receipts.ts:160-175` and
both under- and over-states the real change).

## Approach
1. **Spawn-time `requires` validation.** At the existing ownership-conflict site
   (`src/squad-manager.ts:1905-1908`), after the write-write `ownershipConflict` check,
   add a read-write check using `requiresConflict` (concern 07):
   ```ts
   if (opts.requires?.length) {
     const c = requiresConflict([...this.agents.values()].map(r => r.dto), opts.repo, opts.requires);
     if (c) {
       if (opts.scopeSource === "operator") throw new Error(`requires conflict: ${c.paths.join(", ")} written by "${c.agent}" — wait for it to land or narrow scope`);
       else this.fileScopeFinding("low", `inferred requires overlaps live agent ${c.agent}: ${c.paths.join(", ")}`, opts);  // advisory only
     }
   }
   ```
   Operator-declared → hard block (the enforced path that actually fires on the fleet);
   LLM-inferred → advisory finding, never blocks a spawn on a hallucinated dep.

2. **Post-run produces audit.** After a run completes (where the receipt is finalized),
   compute the agent's REAL changed-file set from git, not the receipt:
   ```ts
   const actual = await this.filesOnAgentBranch(rec);    // git ls-tree / diff vs base, squad-manager.ts:1799
   const declared = rec.dto.produces ?? rec.dto.owns ?? [];
   const outOfScope = actual.filter(f => !isWithinAny(f, declared) && !isAllowlisted(f));
   if (outOfScope.length) this.fileScopeFinding("low", `wrote outside declared produces: ${outOfScope.slice(0,10).join(", ")}`, rec);
   ```
   - `filesOnAgentBranch`/`aheadOfMain` (`:1799`/`:1774`) already give the actual landed
     file set via git — use that as ground truth.
   - **Shared-file allowlist** `isAllowlisted`: `package.json`, `bun.lock`, `bun.lockb`,
     `tsconfig.json`, `.gitignore`, extendable via `OMP_SQUAD_PRODUCES_ALLOW`
     (comma-separated). Prevents a lockfile write from tripping the audit (red team
     follow-up to A-S4).
   - Normalize both sides to repo-relative before comparing (git diff is repo-relative;
     declared prefixes are too).

3. **`fileScopeFinding` helper** routes through the existing Observer finding/filing
   path (deduped, triage-gated, capped) at `severity: "low"`, `autoFixable: false`. It
   NEVER blocks a land — advisory signal only.

## Cross-Repo Side Effects
Depends on concern 07 (`requires`/`produces`/`scopeSource` on DTO, `requiresConflict`).
Touches `src/squad-manager.ts`, which concern 04 also touches — land after 04 (overview
ordering). The finding flows into the same store the Observer already writes.

## Verify
- `bun run typecheck` clean; `bun test` green.
- Operator-declared `requires` overlapping a live agent's `produces` → spawn throws with
  a clear message. Inferred `requires` overlapping → spawn proceeds, a low-sev finding
  appears.
- Run an agent that edits a file outside its declared `produces` (and not allowlisted) →
  exactly one low-sev "wrote outside declared produces" finding, sourced from the git
  branch diff (verify by also touching a file the receipt's `filesTouched` would miss,
  e.g. via a bash `sed` step — the audit must still catch it).
- Lockfile-only out-of-scope write → NO finding (allowlist).
