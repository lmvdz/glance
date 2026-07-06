# Link the per-agent digest into the trace tree
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/spans.ts, src/squad-manager.ts, src/server.ts, tests/trace-api.test.ts

## Goal (what is built)
Every run span carries a `digest` attr (= the agentId), and `GET /api/digest/:id` returns that agent's
compact reasoning/IO digest markdown. This makes the actual prompt/output reachable from a trace node
without inlining (or un-redacting) it into span attrs. This is DESIGN D3.

## Approach (how)
- `src/spans.ts:65 ATTR_KEYS` — add `digest: true` to the whitelist so a `digest` attr survives the
  `attrs()` filter (src/spans.ts:87).
- `src/spans.ts:145 SpanCollector.start` — the run span's `attrs({...})` call (line 158) already passes
  `agent: this.seed.agentId`. Add `digest: this.seed.agentId` to that object so the run span links to
  `digests/<agentId>.md`. Also add `digest: r.agentId` to `fallbackRunSpan`'s `attrs({...})` (src/spans.ts:306)
  so a sampled-out legacy receipt's reconstructed run span still carries the link.
- `src/squad-manager.ts` — add a thin reader method next to `receipts(id)` (src/squad-manager.ts:4483):
  `async digest(id: string): Promise<string> { return readDigest(this.stateDir, id); }`. Import
  `readDigest` from `./digest.ts` (the module already exports it; `buildDigest`/`writeDigest` are already
  imported in squad-manager — extend that import).
- `src/server.ts` — add a route beside the trace route (src/server.ts:1263):
  ```
  const mdigest = url.pathname.match(/^\/api\/digest\/([^/]+)$/);
  if (mdigest && req.method === "GET") {
    const md = await manager.digest(decodeURIComponent(mdigest[1]));
    if (!md) return new Response("digest not found", { status: 404 });
    return new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }
  ```
  Place it inside the same authenticated request handler block the trace route lives in (same `manager`/
  `actor` scope) so it inherits auth. Digest is read-only, non-sensitive (already redaction-shaped), so no
  extra RBAC beyond the block's existing gate.
- `tests/trace-api.test.ts` — add: a run whose receipt/span tree exposes `attrs.digest` on the run node,
  and (if the test harness spins a server) a `GET /api/digest/<agentId>` returning the markdown; else a
  direct `manager.digest(id)` round-trip after `writeDigest`.

## Scope boundary (what NOT to touch)
Do not change span redaction/truncation or inline prompts/outputs into attrs — the digest is the reachable
payload. Do not build the UI affordance (concern 05 renders the link). Do not touch sampling (01),
weaving (02), or the exporter (03).

## Verify (concrete command + expected observable outcome)
`bun test tests/trace-api.test.ts` — green, including the `attrs.digest` assertion and the digest
round-trip. Live: `curl -s localhost:<port>/api/digest/<agentId>` (with the daemon's auth header) returns
the markdown body (Goal/Summary/Files/Where-we-left-off); `curl -s localhost:<port>/api/trace/<id> | jq
'.root.attrs.digest'` prints the agentId.
