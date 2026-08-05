# Design: Agent Realized-Impact Metrics

Arbitrated 2026-07-28 from one designer draft and two red-team critiques (git-mechanics/durability; metric-semantics/gameability). The draft's spine survived; four of its mechanisms were replaced.

## Approach

For every unit of agent work that lands on main, record an append-only ledger line at land time (unit id, true merge commit, the exact line ranges the land contributed, the branch commit set, feature id). A flag-gated daemon loop then measures each land at fixed offsets (+7/+14/+28 days) and writes one snapshot file per (land, offset). Reports derive only from snapshot files — no git re-walking at read time.

The lane measures **static reference and survival**, not execution — and says so everywhere. Its four vectors, honestly named:

- **Instrumentability** — leads every report: what fraction of this unit's work the lane can see at all. Measured live: 44% of recent merges added zero exported symbols, so uninstrumentable units render as declared gaps, never as clean rows.
- **Statically-referenced** (was "load-bearing") — inbound `calls` edges (imports counted separately) into the unit's added exports from *cross-feature* code authored after land. Same-feature edges are classified separately to kill two-unit split farming.
- **Survival** — % of added lines unmodified at each offset (raw numerator/denominator, bucketed by file-churn tertile, never cross-bucket compared; no medians — the censoring makes them fiction). Modifiers classified: same unit, same feature, other agent, human, deleted-within-window (the real rejection signal here; `^Revert` matching is a dead sensor in a fix-forward fleet).
- **Cost** — feature-level rollup (union of member/parent-chain agentIds' receipts), with a cost-coverage line; below full coverage, impact-per-dollar is a gap, not a number.

No composite score. No verdict-named quadrants — a scatter of raw counts with mechanism-named axes.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Commit→unit join | Append-only ledger written at all **three** land sites (local, PR, pr-reconcile), deduped on merge SHA | Git trailers; populating land-assessment refs; DoneProof extension | Trailers stamp ~zero commits (land-site commits are WIP-sweeps; agents author their own work commits); byBranch maps overwrite on reuse. Refs fix kept as a non-blocking cross-check. |
| What "the unit added" means | First-parent diff of the true merge commit, captured at land, lockfiles/generated excluded (exclusion list recorded) | Diff of stored baseSha vs recorded mergeCommit | The recorded mergeCommit is the **branch tip** under the default merge method (land-pr.ts:443) — stored-base diffs misattribute main's concurrent work. First-parent diff is exactly what the land contributed. |
| Survival primitive | `git blame --reverse mergeSha..HEAD -L` per recorded range | `git log -L` | `log -L` resolves ranges at the *newest* revision — empirically measures the wrong lines once anything shifts above them; blame --reverse resolves at mergeSha, tolerates deletion/renames. ~0.2s/query, ~4 CPU-min/day at current land cadence. |
| Snapshot identity | (mergeSha, offsetDays) | (agentId, offsetDays) | One agent lands many times; agent-keying silently drops every land after the first. |
| Call-edge source | codegraph.db behind an `impactIndex()` seam with **per-unit, per-file usability gates** (file indexed, content hash matches HEAD, indexed_at postdates mergeSha, unresolved-ref density under threshold, schema version pinned); any failure → declared gap | Name-existence matching; structural-delta call resolver | The DB is live-verified 70% incomplete and answers confidently for unindexed files; presence/mtime checks can't catch that. Name-existence is gameable by identifier reuse — permitted only as a fleet-wide ceiling, never per-agent. Structural-delta resolver is the future second impl behind the same seam. |
| Cost denominator | featureId rollup via receipts' existing featureId/parentId fields; no featureId → gap | Per-agentId sum | Forks mint new agentIds; per-id sums report ~25% of true cost for the flakiest work. The join data already exists in every receipt. |
| Accretion counterweight | Deletion credit: dead-export baseline reduction attributed to the unit | None | Without it every vector's gradient points toward new-module proliferation and away from in-place repair and cleanup. |
| Agent exposure | Tested firewall invariant: no impact number reaches agent-readable surfaces until cross-feature classification and coverage gates are live and a red-team cohort has run | Ship and see | Agents read their own learning ledger; the gaming vectors are cheap and invisible in review. |

## Risks

- **Measurability selection**: most units will carry gaps; if numeric rows outrank gap rows visually, the lane rewards being measurable (= greenfield). Mitigation: gap fraction rendered inside the same visual as every rollup; cohorts below a measurability floor render as gaps wholesale; cohorts keyed (repo, week).
- **Codegraph coverage may stay low** (watcher disabled in the global install; index rides operator git hooks). The lane stays honest via gates, but statically-referenced may be mostly gap until the structural-delta second impl lands. Accepted: a gap is strictly better than a biased number.
- **Survival still correlates with file temperature** even churn-bucketed. Accepted with the bucket rule and mechanism-named labels ("unmodified ranges (churn-adjusted)", never "still good").
- Ledger/land-path crash windows: closed by mirroring the DoneProof write pattern (append after assertion, reconcile backfills, read-time dedupe on mergeSha).

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| `log -L` measures wrong lines | critical | blame --reverse primitive |
| branchTip recorded as mergeCommit corrupts diffs and backfill | critical | true-merge resolution + first-parent diff; backfill via first-parent merge walk; unrecoverable method="merge" history marked range-less |
| Trailers stamp ~nothing | critical | Trailers cut; ledger stores branch commit set for modifier classification |
| (agentId, offset) drops repeat lands | critical | mergeSha keying |
| 44% of merges not instrumentable | critical | Instrumentability leads every report; 0-candidate units = gap rows |
| Name-existence DOA gameable + agent-readable | critical | Ceiling-only, firewalled from agent surfaces |
| codegraph 70% incomplete, confident zeros | critical | Per-file usability gates |
| agentId cost fragmentation | critical | featureId rollup |
| pr-reconcile land path uninstrumented | significant | Third ledger write site (also catches human GitHub-UI merges) |
| Survival = file temperature; medians undefined under censoring | significant | Churn tertiles; % with n/d; no medians |
| Two-unit split farming; accretion gradient | significant | sameFeature edge class; deletion credit |
| unresolved refs 4:1 vs resolved | significant | `unresolved` is its own rendered category with share shown |
| Missing/estimated costUsd | significant | Cost-coverage line; estimates flagged |
| Land-race on shared checkout reads; re-merge sha drift; lockfile noise; late snapshots; repoHash16 path-keying | significant/minor | withRepoLandLock around reads; capture HEAD at ok-return only; path exclusions; record actualAt+measured HEAD; store repoIdentity in lines |
| Validator-cost exclusion vacuous | minor | Note reads "validator cost unmeasured" (validators don't write receipts) |

## Open Questions

None blocking. Deferred by prior scope decision: runtime execution sampler (realized-line rate) is the final, later concern; the lane's language must not imply execution until it exists.
