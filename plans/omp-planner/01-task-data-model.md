# Task-detail server seam — issue body + Tier-2 parser + `/api/tasks/:id`

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/plane.ts, src/server.ts, src/types.ts, tests/plane-tier2.test.ts (new)
BLOCKED_BY: —

## Goal

Surface a Plane issue's **body** to the webapp so a task can show description + acceptance criteria
+ context-bundle preview + properties. Today `/api/plane/issues` (server.ts:665) returns `IssueRef[]`
with no body; `IssueRef` (types.ts:56) has only id/name/state/blockedBy. Add a single detail fetch +
a pure Tier-2 parser + one endpoint.

## Approach

### 1. `src/types.ts` — `TaskDetail` (after `IssueRef`, ~line 71)
```ts
export interface TaskDetail {
  id: string;
  identifier?: string;
  name: string;
  state?: string;
  priority?: string;
  labels: string[];
  url?: string;
  blockedBy: string[];
  /** Raw issue body (markdown/stripped) for fallback rendering. */
  body: string;
  /** Parsed promote-issue Tier-2 sections (empty strings when absent). */
  tier2: { description: string; acceptanceCriteria: string; verification: string; scope: string };
}
```

### 2. `src/plane.ts` — `parseTier2(body)` (pure) + `fetchIssueDetail(repo, issueId)`
- `parseTier2(body: string): TaskDetail["tier2"]` — split the markdown by `##`/`###` headings and
  bucket sections by heading text, **case-insensitive, tolerant of absence**. Map headings to fields:
  acceptance: matches `/accept/i`; verification: `/verif|gate/i`; scope: `/scope|boundary/i`;
  description/everything-before-the-first-known-section → `description`. Read `skill://promote-issue`
  for the canonical Tier-2 headings and match those; a body with none → all-empty (never throw).
- `fetchIssueDetail(repo, issueId)`: reuse the existing `planeContext(repo)` helper (used by
  `featureTickets`/`createPlaneIssue`). `GET ${base}/issues/${issueId}/` → read
  `description_stripped` (fallback `description_html` stripped) for the body, plus `state`,
  `priority`, label ids→names, `external`/`url`. Fetch `${base}/issues/${issueId}/issue-relations/`
  and run it through the existing `parseBlockedBy`. Return a `TaskDetail` (`body` = stripped text,
  `tier2 = parseTier2(body)`). `null` when Plane unconfigured/unreachable (mirror `listPlaneIssues`).
  Cache with the existing TTL cache pattern (`issueListCache` sibling) keyed by issueId.

### 3. `src/server.ts` — `GET /api/tasks/:id?repo=` (beside `/api/plane/issues`, ~line 665)
```ts
if (url.pathname.startsWith("/api/tasks/")) {
  const id = decodeURIComponent(url.pathname.slice("/api/tasks/".length));
  const detail = await fetchIssueDetail(url.searchParams.get("repo") ?? process.cwd(), id);
  if (detail === null) return new Response("plane not configured", { status: 501 });
  return Response.json(detail);
}
```
Viewer-readable (GET; same tier as `/api/plane/issues`). No new RBAC.

## Cross-Repo Side Effects
None. `parseTier2` is pure/leaf; `fetchIssueDetail` reuses `planeContext`+`parseBlockedBy`. Endpoint
slots into the existing GET cluster — no overlap with the features POST handlers.

## Verify
- `tests/plane-tier2.test.ts`: a real promote-issue Tier-2 body → `{description, acceptanceCriteria,
  verification, scope}` all populated; a body with only a description → others empty, description set;
  empty string → all empty, no throw.
- `bun run check` clean; `bun test tests/plane-tier2.test.ts` green.
- Manual: `curl "localhost:7878/api/tasks/<id>?repo=$PWD"` returns the parsed detail.
