# Off-dashboard, agent-initiated human escalation

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/webhook-sink.ts (new), src/server.ts, src/push.ts, src/types.ts, src/squad-manager.ts, src/redact.ts (use), README.md

## Goal

Let a blocked/uncertain agent reach a human **off the dashboard** — a generic webhook (Slack-compatible) — and tag every escalation with `urgency` so a channel can triage. Today a needs-input agent only buzzes web-push-subscribed devices; an operator not running the PWA gets no signal. This is omp-squad's one genuine capability gap vs HumanLayer's thesis (Factors 7/11; BRIEF Pattern 2). File-disjoint from Goal 1 → parallel-safe.

## Approach

### 1. `NotificationSink` interface (load-bearing contract)
Define `interface NotificationSink { notify(p: PushPayload): Promise<void> }` (in `src/push.ts` or `src/types.ts`). **Contract: `notify` MUST NOT throw and MUST NOT reject** — it swallows its own errors (mirrors `PushService.notify`'s internal try/catch, push.ts:178-180). State this in a doc-comment; a cold agent will otherwise copy a bare one-liner (RedTeam F1). `PushService` already conforms (its `notify` returns a count and never rejects).

### 2. `WebhookSink` (src/webhook-sink.ts, new — ~50 LOC)
```ts
export class WebhookSink implements NotificationSink {
  constructor(private url: string, private format: "slack" | "generic" = "generic") {}
  async notify(p: PushPayload): Promise<void> {
    try {
      const body = this.format === "slack"
        ? JSON.stringify({ text: `[${p.title}] ${p.body}` })
        : JSON.stringify(p);
      await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(5000) });
    } catch { /* best-effort; no delivery guarantee (documented) */ }
  }
}
```
- `AbortSignal.timeout(5000)` so a black-holed endpoint can't dangle (RedTeam F2). No retry — best-effort, **documented as such** in README.
- The whole body is in try/catch so a DNS/refused/timeout error resolves cleanly (never rejects — RedTeam F1).

### 3. Security — redact + https before any external POST (RedTeam F5, Medium)
A webhook posts **plaintext to a third party** (unlike E2E-encrypted web-push). `escalationPayload`'s body can be `a.error` = raw `err.message` carrying repo paths / command output / secret-shaped strings.
- Run the existing `redact()` (src/redact.ts:29 — catches `sk-`/`AKIA`/`gh_`/JWT/PEM/`KEY=value`) over `title` + `body` **before constructing a WebhookSink payload** (do NOT redact the web-push payload — it's E2E-encrypted to the operator's own device). Cleanest: redact inside `WebhookSink.notify`, or pass an already-redacted payload only to external sinks.
- **Enforce https-only** on `OMP_SQUAD_WEBHOOK_URL` at construction: reject/skip a non-`https:` URL with a logged warning.
- README documents exactly which fields leave the box (`title`, redacted `body`, deep-link path, agent name, urgency).

### 4. Fan-out with per-sink isolation (src/server.ts `maybePushAlert`, ~737-755)
- Hold `sinks: NotificationSink[]` on the server (built in the constructor: `PushService` if configured + `WebhookSink` if `OMP_SQUAD_WEBHOOK_URL` set). Keep the existing `push?: PushService` option working (it becomes one sink).
- Replace `void push.notify(payload)` (server.ts:754) with a per-sink-isolated fan-out:
  ```ts
  for (const s of this.sinks) { try { void s.notify(payload).catch(() => {}); } catch { /* sync-throw isolation */ } }
  ```
  A synchronously-throwing sink (e.g. bad `new URL`) must NOT bubble into `broadcast`→`schedulePresence` and kill the WS stream (RedTeam F3). Keep the existing seed/transition/`lastPush` 3s dedup guards UPSTREAM of the fan-out unchanged — fan-out inherits them correctly (RedTeam F4).

### 5. Urgency
- Add `urgency?: "low" | "medium" | "high"` to `PendingRequest` (src/types.ts:31-46) and to `PushPayload` (src/push.ts:23-30).
- Set urgency where the request is built — `onUi` and `onHostTool` (src/squad-manager.ts; verify exact lines on read — onUi ≈ :1449, onHostTool ≈ :1475). **Do NOT reuse `RISKY_RE` verbatim** as the signal (it's deliberately over-broad — `production|release|publish|deploy|drop` match benign plan-review text → false pages; RedTeam F6). Rule: `source === "tool"` → `high`; a tight destructive subset (`force-push|reset --hard|rm -rf|wipe|truncate|mainnet`) → `high`; everything else → `medium`. Document the residual over-paging.
- Thread urgency into the payload in `escalationPayload` (src/server.ts:130 — the actual builder; it takes `AgentDTO`, so read `a.pending` and use the **max** urgency across pending, not just `pending[0]` — RedTeam F7).
- **No second "budget-spent" fire** (RedTeam optional note): when the auto-supervise budget is spent the agent is already `input` → the transition push already fired. Fold "this one needed a human" into the urgency of that existing push; do not double-fire.

### 6. Config + docs (same-change rule)
README "Notifications" section: `OMP_SQUAD_WEBHOOK_URL` (https only; enables the webhook sink), `OMP_SQUAD_WEBHOOK_FORMAT=slack|generic` (default generic), best-effort/no-retry semantics, the redacted field list, and that web-push is unchanged + independent.

## Cross-Repo Side Effects

None outside omp-squad. `PendingRequest`/`PushPayload` gain an optional field (back-compatible). Goal 3 (`04`/`06`) also edits `src/server.ts` and `src/squad-manager.ts` in different regions — **this concern lands first**; Goal 3 rebases onto it.

## Verify

- New `tests/webhook-sink.test.ts`: `notify` never throws/rejects when `fetch` is stubbed to reject; slack vs generic body shape; https-only rejects an `http://` URL; `redact()` scrubs an `sk-...`/`AKIA...` string from title+body. (Inject `fetch`/the sink via constructor or a `send` param — match `push.ts`'s injectable `send` style, push.ts:121/127.)
- Existing `tests/*` (incl. any server/push tests) stay green.
- `bun run check` clean.
- Manual: set `OMP_SQUAD_WEBHOOK_URL=https://webhook.site/...`, block an agent → the webhook receives a redacted payload with `urgency`; unset → behavior identical to today.
