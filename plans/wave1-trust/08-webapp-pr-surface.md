# Webapp PR surface

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/lib/dto.ts, webapp/src/components/ActiveWorkPane.tsx, webapp/src/components/AssistantChat.tsx, webapp/src/components/TaskDetail.tsx, src/web/index.html

## Goal

The operator experiences this whole wave through the dashboard. Mirror `AgentDTO.prUrl`/`prNumber`/`prState` (added server-side by concern 06) into the webapp's hand-maintained DTO mirror, and surface a PR link + state badge + per-mode Land button label everywhere the daemon already shows land status today.

## Approach

### 1. `webapp/src/lib/dto.ts` — mirror the new fields

Verified: this file's `AgentDTO` (lines 165-196, 32 fields) is a hand-maintained SUBSET mirror of the server-side `src/types.ts:435-523` type (~45 fields) — it does NOT include every server field (e.g. `kind`, `parentId`, `verified`, `repoId`, `workflow`, `adopted`, `queued` are all absent from the webapp mirror today). This is a known drift-prone pattern (flagged previously by the `lifecycle-truth` plan for its own fields) — a missing field here silently type-drops at the network boundary with no compile error, since the webapp simply never references it. Add the three new fields immediately after the existing `landReady?: boolean;` (line 195, right before the closing brace at 196):

```ts
	/** PR-mode landing metadata, set at push (draft/open) and merge (merged) time. Absent in local mode. */
	prUrl?: string;
	prNumber?: number;
	prState?: 'draft' | 'open' | 'merged' | 'closed';
```

### 2. `webapp/src/components/ActiveWorkPane.tsx` — badge + Land button label

Verified three land-related sites in this file:

- `:330` — `const landable = canLand(agent) && (agent.landReady || agent.availableActions?.includes('land'));` — no change needed; PR-mode agents still become "landable" the same way (a ready-to-merge PR is still `landReady`-equivalent per concern 06's wiring).
- `:352` — the existing `landReady` badge: `{agent.landReady && <span className="rounded bg-amber-100 ...">✓ ready</span>}`. Extend to show PR state when present, falling back to the existing badge when `prState` is absent (local mode, unaffected):
  ```tsx
  {agent.prState ? (
    <span className={`rounded px-1.5 py-0.5 text-xs ${prStateBadgeClass(agent.prState)}`}>
      {prStateBadgeLabel(agent.prState)}
    </span>
  ) : agent.landReady && (
    <span className="rounded bg-amber-100 ...">✓ ready</span>
  )}
  ```
  Add small local helpers `prStateBadgeLabel`/`prStateBadgeClass` in this file (or a shared UI-copy module if one already exists for badge copy — check for one before adding a new local pair): `draft`/`open` → "awaiting merge" (with a small "checking…" variant while the reconciler's out-of-band-merge window is still open, i.e. within ~120s of the last known state change — this is a nice-to-have polish, not required for correctness, do not over-engineer a live countdown), `merged` → "merged", `closed` → a visually distinct warning treatment (closed-unmerged is the one state that needs the operator's attention).
- `:405` — `readyToLand` computation (`fleetAgents.filter((a) => canLand(a) && (a.landReady || a.availableActions?.includes('land'))), ...`) feeding the Land action list — no change needed, same reasoning as `:330`.

If the actual Land button element (around lines 355-364 per the verified `landFleetAgent` wiring at :409-421) renders a literal `"Land"` label, add the per-mode label here too: `agent.prState ? "Merge PR" : "Land"` (mirrors the label logic specified for `AssistantChat.tsx` below — keep the two in sync, ideally via one shared `landButtonLabel(agent)` helper imported by both files rather than duplicating the ternary).

### 3. `webapp/src/components/AssistantChat.tsx` — Land button label

Verified `:695`:

```tsx
{busy === 'land' ? 'Landing…' : forceArmed ? 'Force land ⚠' : agent.landReady ? 'Land ✓' : 'Land'}
```

Extend with the PR-mode label, inserted before the plain `'Land'` fallback so force/busy states still take priority:

```tsx
{busy === 'land' ? 'Landing…' : forceArmed ? 'Force land ⚠' : agent.prState === 'merged' ? 'Merged ✓' : agent.prState ? 'Merge PR' : agent.landReady ? 'Land ✓' : 'Land'}
```

### 4. `webapp/src/components/TaskDetail.tsx` — new addition, not an extension

Verified: this file currently has NO `landReady`/Land-button/land-status code at all (0 matches) — land UI lives entirely in `ActiveWorkPane.tsx`/`AssistantChat.tsx` today. Since the design brief explicitly lists `TaskDetail.tsx` as part of the webapp surface for this wave (the operator's agent-detail drill-down should show PR status too, not just the fleet list), add a small PR-status line in the agent detail header — reuse the same `prStateBadgeLabel`/`prStateBadgeClass` helpers from `ActiveWorkPane.tsx` (extract them to a shared location, e.g. `webapp/src/lib/agent-badges.ts` or similar, if one doesn't already exist, rather than triplicating badge copy across three files) plus a plain link when `prUrl` is present: `{agent.prUrl && <a href={agent.prUrl} target="_blank" rel="noreferrer">PR #{agent.prNumber}</a>}`.

### 5. `src/web/index.html` — legacy fallback, minimal addition

Verified `:1927`, inside the agent-card template string:

```js
${a.landReady?`<span class="badge b-ready">✓ ready to land</span>`:""}
```

Add a minimal PR-link addition alongside it (this is the legacy non-React fallback UI — keep the change as small as the existing badge, no new CSS classes beyond what already exists for `.badge`):

```js
${a.prUrl?`<a class="badge b-ready" href="${a.prUrl}" target="_blank" rel="noreferrer">${a.prState==="merged"?"merged":"PR #"+a.prNumber}</a>`:a.landReady?`<span class="badge b-ready">✓ ready to land</span>`:""}
```

### 6. `src/server.ts` / DTO serialization — verified, no change needed

Verified: `src/server.ts` does NOT construct or serialize `AgentDTO` itself — the land routes (`POST /api/agents/:id/land` at `:1281-1294`, `POST /api/features/:id/land` at `:1016-1021`) and the agent-list/get endpoints all return whatever `manager.list()`/`manager.getAgent(id)`/`manager.land(...)` already produce, straight to `Response.json(...)`. Since concern 06 sets `prUrl`/`prNumber`/`prState` directly on `rec.dto` (the same pattern `landReady` already uses, per the verified assignment sites `squad-manager.ts:1669`/`:1717`), the new fields flow through automatically the moment concern 06 lands — **no `server.ts` change is required by this concern**. Confirm this at implementation time by checking that a manual land/push in a repo resolved to PR mode makes `GET /api/agents` return the new fields with no server.ts edits; if server.ts turns out to have some intermediate DTO-shaping step not caught during decomposition, that is the one place to add pass-through, but the verified read found none.

## Cross-Repo Side Effects

None — single repo.

## Verify

- `bun run check` (webapp typecheck — new optional DTO fields compile cleanly, no `any` widening).
- Manual probe (documented in the `run`/`verify` skill style used elsewhere in this repo, since this concern is pure UI): with a repo resolved to PR mode (concern 05) and a landed agent (concern 06), open the webapp dashboard and confirm: (a) the fleet list badge shows "awaiting merge"/"merged" instead of the plain ready-to-land badge once `prState` is set; (b) the Land button in `AssistantChat.tsx` reads "Merge PR" before merge and "Merged ✓" after; (c) `TaskDetail.tsx`'s agent header shows a working `PR #<n>` link; (d) the legacy `src/web/index.html` fallback (load it directly, bypassing the Vite build) shows the same PR link/badge.
- No new automated webapp test is required for this concern beyond the typecheck — if the webapp's existing component test setup (check for one, e.g. a `webapp/src/**/*.test.tsx` convention) already covers `ActiveWorkPane`/`AssistantChat` rendering, extend those with one case each asserting the PR-state badge/label render correctly for `prState: undefined` (unchanged legacy path) and `prState: "merged"` (new path) — do not introduce a new test framework/harness if none exists for the webapp today.
