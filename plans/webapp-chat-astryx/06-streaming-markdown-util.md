# streamingMarkdown.ts — settled boundary + artifact suppression
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: webapp/src/lib/streamingMarkdown.ts (new), webapp/src/lib/streamingMarkdown.test.ts (new)

## Goal
Pure string functions that (a) split streaming markdown at a safe "settled" boundary so the prefix can be render-memoized, and (b) clean the unsettled tail so half-typed syntax never flashes raw. No React, no remark — strings in, strings out.

## Approach
API:
- `findSettledBoundary(text: string): number`
- `splitSettled(text: string): { settled: string; tail: string }`
- `trimStreamingArtifacts(tail: string): string`

**Boundary rule (tightened per red team — paragraph-level only):** a candidate boundary is a blank line that is (a) outside any fenced code block (track ``` and ~~~ fence state line-by-line), (b) at column 0, and (c) followed by a line that is neither indented (4+ spaces / tab) nor a list-item continuation — i.e. the tail must start a genuinely new top-level block. This prevents the two-tree seam bugs: loose-list splits (tail re-parsing as an indented code block or losing nesting) and mid-construct splits. The boundary is computed on the **raw accumulated text, never on trimmed text** (invariant: suppression applies to the tail only, downstream of the split — by pipeline construction, DESIGN.md).

**Artifact rules** (port astryx's semantics from `packages/core/src/Markdown/parser.ts` — `trimStreamingArtifacts` + `trimUnsettledStructural` at commit deb5aa0; fetch for reference, reimplement for our shape):
- Trim trailing unclosed `[` / `![` link openers.
- Trim trailing unpaired `` ` ``, `*`, `~~` markers.
- **Auto-close** mid-line unclosed `**bold` (render formatting live rather than hiding it).
- Hold back a trailing bare `- `/`* ` bullet with no content yet.
- Hold back a lone table-header line until its `|---|` separator row arrives; once a table is established, let new rows through immediately.

**Known accepted limitations** (document in the file header): reference-link definitions in the settled prefix don't resolve in the tail (two independent remark trees) — heals at stream end; a single fence longer than the whole entry means the boundary never advances (degenerates to status-quo full re-parse — acceptable, memo from concern 01 still bounds it to one entry).

## Cross-Repo Side Effects
None.

## Verify
`bun test webapp/src/lib/streamingMarkdown.test.ts` — required cases:
- Boundary: never inside a fence; skips blank lines between loose-list items and before indented continuations (the red-team divergence cases as regression tests); advances past a completed fence; column-0 rule.
- `splitSettled(x).settled + splitSettled(x).tail === x` for arbitrary inputs (property-style loop over fixtures).
- Trimming: each rule above, plus **idempotency** (`trim(trim(x)) === trim(x)`) and completed-syntax pass-through (`trim` of well-formed markdown is identity).
- Settled prefix is never trimmed: assert the pipeline helper never applies `trimStreamingArtifacts` before splitting (structural: `splitSettled` operates on raw input).

## Resolution
Implemented `findSettledBoundary`, `splitSettled`, and `trimStreamingArtifacts` as pure string functions in `webapp/src/lib/streamingMarkdown.ts`, covered by `streamingMarkdown.test.ts` (boundary, round-trip, idempotency, and pass-through cases). No consumer wiring (deferred to concern 07).
