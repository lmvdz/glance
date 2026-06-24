# Brief — omp-dashboard: enterprise operator UI (HumanLayer-shaped, piyaz-skinned)

A pivot from the `omp-graph` clone. The piyaz force-graph is a *viewer*; this plan makes the
`webapp/` a real **operator control plane** with parity to `src/web/index.html`, using HumanLayer's
CodeLayer information architecture and the piyaz visual skin.

## Inputs (researched)
- **HumanLayer CodeLayer UI** (humanlayer.dev product shots + DeepWiki): task-centric **three-pane**
  — tasks list │ task detail with a **session/stage table** │ **artifacts** panel — dark + mono,
  **keyboard-first** (Superhuman-style), **command palette for every action**, and an **approvals
  inbox** (`request_permission` → ApprovalModal; the session blocks until approve/deny; WS notify).
  It is **list / inbox-first, not graph-first**.
- **Repo research** `plans/research-humanlayer-baml/BRIEF.md`: concluded **"omp-squad is already
  CodeLayer-shaped"** (daemon + thin-client + worktree isolation + approval gating). Named gaps:
  the approval **stakes ladder** and **agent-initiated escalation** (F7) — both daemon-side, noted.
- **`src/web/index.html`**: the current operator dashboard = the **parity spec** (every view + action).
- **`omp-graph-ui` branch**: piyaz tokens + WS client (`lib/ws.ts`) + `useSquad` + force-graph +
  dual-mode shell — the skin, one view, and the transport, already built.
- **`squad/ompsq-55` branch**: a shadcn primitive kit (table/dialog/toast/badge/select/input/
  skeleton/empty/error + a showcase) — **reskin, don't rebuild**.

## The gap (why this plan exists)
The omp-graph clone renders state but performs **no actions**: `useSquad`'s `send(ClientCommand)` is
wired and unused — no transcript, no approvals, no spawn. `src/web/index.html` already does all of
it. HumanLayer shows the enterprise shape: **inbox + session detail + live transcript + inline
approvals + actions**, list/table-first, graph as a lens.

## Direction (composition, not either/or)
- **IA = HumanLayer** — sidebar nav → list/table → detail (live transcript + inline approvals) →
  context/artifacts; an **approvals inbox** and a **command palette** as first-class surfaces.
- **Skin = piyaz** (indigo/Raycast tokens from `omp-graph-ui`; user pick).
- **Primitives = ompsq-55**, reskinned to piyaz tokens.
- **Transport = the daemon** — WS `SquadEvent` stream + `ClientCommand` (also `POST /api/command`)
  + `/api/*` fetches. **No new endpoints.**
- **omp-graph = one view**, not the product.
- **Spec = `index.html`** — a parity matrix in `00-overview.md` gates "done".

Build-vs-buy: borrow patterns + reskin existing code (primitives, transport, graph). The new work is
**IA + wiring + parity**, not new infrastructure.
