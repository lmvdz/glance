# Artifact comment API + SPA panel

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/server.ts, webapp/**, README.md
BLOCKED_BY: 04-artifact-comment-store, web-framework (landed)
VERIFY_BLOCKER: `grep -q "addComment\|listComments" src/squad-manager.ts` (04 merged) AND `cd webapp && bun run build` succeeds (SPA toolchain present)

## Goal

Expose the comment store (04) over HTTP and give the operator a way to *create*, read, and resolve comments on a Feature's plan/research artifacts in the new `webapp/` SPA. This is the affordance that makes the whole of Goal 3 live (without it, 04/06 are dead — RedTeam F14).

## Approach

### API (`src/server.ts`, in the features routing cluster ≈ :477-494)
Add, mirroring the existing `/api/features*` handlers' shape (JSON body validation, repo defaulting to `process.cwd()`, tier check via the same path `/api/command` uses):
- `GET /api/artifacts/comments?repo=&planDir=&unresolved=1` → `manager.listComments({repo, planDir, unresolved})`.
- `POST /api/artifacts/comments` body `{repo, planDir, file, body, urgent?}` → `manager.addComment(input, actor)` (author = the authenticated actor). 400 on missing `planDir`/`file`/`body`.
- `POST /api/artifacts/comments/:id/resolve` → `manager.resolveComment(id, actor)`.
Match the existing RBAC: comment add/resolve require at least the `operator` tier (same as `prompt`/`answer`); list is viewer-readable.

### SPA panel (`webapp/`)
On the Feature/artifact view (the SPA's equivalent of the current Feature detail), add a **Comments** panel:
- List unresolved comments for the Feature's `planDir`, grouped by `file`; each with author, time, body, a **Resolve** button.
- A composer: pick a plan-dir file (from the Feature's known artifacts), type a comment, optional "urgent" toggle, submit → `POST`.
- Live refresh on the existing WS/poll cadence the SPA already uses for features.
- File-level only (no line anchors in v1 — RedTeam F13).

Follow the SPA's component conventions (shadcn/ui + Tailwind v4, the patterns established by the `web-framework` plan). Do NOT touch legacy `src/web/index.html`.

### Docs
README: document the comment endpoints and the review-on-the-plan workflow (create a comment on a plan artifact → it feeds the next RPI phase via concern 06).

## Cross-Repo Side Effects

None outside omp-squad. Consumes 04's manager methods. Shares `src/server.ts` with Goal 2 (03, already landed) — different region (features cluster vs `maybePushAlert`/`escalationPayload`).

## Verify

- A server test (extend the existing server/webapp test style): `POST` a comment → `GET ...?unresolved=1` returns it → `POST .../resolve` → `GET ...?unresolved=1` no longer returns it. RBAC: a viewer token cannot `POST`.
- `cd webapp && bun run build` succeeds; the Comments panel renders against a stubbed API in the SPA test harness.
- `bun run check` clean. Manual: add a comment in the UI, see it land in `comments.jsonl`, resolve it, see it clear.
