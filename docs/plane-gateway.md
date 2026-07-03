# Plane gateway — design (follow-up to the in-process throttle)

Status: PROPOSED. The in-process throttle (`src/plane-throttle.ts`) ships first and solves the
rate-limit problem in practice; this gateway is the next step if/when cross-process isolation is needed.

## Problem

Plane cloud rate-limits per workspace token. Many independent processes share that one token:

- the glance daemon (dispatcher poll, observer poll + filing, worktree reaper, scout),
- the Plane MCP server (used by interactive agent sessions),
- any other agent/tool acting on the same workspace.

The in-process throttle coordinates callers **within one process**. It cannot coordinate across
processes: a second daemon, the MCP, and an ad-hoc agent each run their own limiter and still
collectively burst past the token's limit — which is exactly the 429 storm that motivated this work.

## Goal

One process owns the Plane token and is the ONLY thing that talks to Plane's API. Everything else
calls *it*. A single global limiter + shared cache then actually bounds total load.

## Shape

```
 daemon ─┐
 MCP    ─┼──HTTP──▶ plane-gateway ──(token, 1 limiter, 1 cache)──▶ Plane API
 agents ─┘
```

- **Transport:** a tiny local HTTP service (Bun.serve) on a loopback port; auth via a shared secret.
  Endpoints mirror the plane.ts surface: `GET /issues?repo=`, `POST /issues`, `PATCH /issues/:id/state`,
  `GET /issues/:id/relations`, `POST /modules`, …
- **Core:** reuse `plane-throttle.ts` verbatim (throttledFetch + makeCache) inside the gateway — the
  limiter and cache become process-global for the whole fleet instead of per-process.
- **Client:** `plane.ts` gains a `PLANE_GATEWAY_URL` mode: when set, every function calls the gateway
  instead of Plane directly (same return types, callers unchanged). When unset, today's direct +
  in-process-throttle path is used (no regression, gateway is opt-in).
- **MCP:** point the Plane MCP at `PLANE_GATEWAY_URL` too, so interactive sessions share the same budget.

## Why not now

- A new long-lived service + transport + auth + lifecycle (start/stop/health) is real surface area.
- The in-process throttle already removes the dominant consumer's self-saturation, which frees the
  shared token for the MCP and other callers — measure first; build the gateway only if 429s persist.

## Acceptance (when built)

- With the daemon + MCP + an ad-hoc agent all active, sustained Plane request rate stays under the
  token limit (no 429s) — verified by the gateway's own request log.
- `PLANE_GATEWAY_URL` unset ⇒ byte-for-byte today's behaviour (the gateway is purely additive).
