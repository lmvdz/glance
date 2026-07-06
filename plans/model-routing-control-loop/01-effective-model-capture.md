# Effective-model capture (RPC path)
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/receipts.ts, src/types.ts

## Goal
Populate `RunReceipt.model` with the model omp **actually used**, not the (usually undefined) requested model. Today a dispatched fleet unit sets no model, so `seed.model` is undefined → `modelKey`→"default" / `modelFamily`→"unknown", and the whole `task-class × model` matrix collapses to a single model bucket. Fix the dominant (RPC) path, where the effective model is already on the wire.

## Approach
The RPC assistant frame already carries the resolved model. On every assistant `message_end`/`turn_end`/`message_update`, `frame.message` is an `AssistantMessage` with a plain `model: string` (e.g. `"claude-sonnet-4-5"`) co-located with the `usage` receipts already reads. The daemon ignores it only because its local `Frame` type narrows it away.

1. In `src/receipts.ts`, widen the local `Frame`/message type (~`:165`) from `message?: { role?: string; usage?: AssistantUsage }` to also carry `model?: string`.
2. Where the assistant-usage frame is handled (~`:183`, `if (frame.message?.role === "assistant" && frame.message.usage) acc.onAssistantUsage(...)`), also late-bind the model: if `acc.seed.model` is unset/falsy and `frame.message.model` is present, stamp it onto the accumulator so `snapshot()`/`finish()` emit it on `RunReceipt.model`. Late-bind (first-model-wins) rather than last, so a mid-run change doesn't silently rewrite attribution — but note there is no mid-run swap in v1, so first == only.
3. Optionally also read the `config_update` frame (`type:"config_update"`, carries `model`) as a fallback seed at startup, if it is simpler to hook than the assistant frame. Prefer the assistant frame — it reflects what actually ran.
4. Leave `seed.model` from an explicit `opts.model` authoritative when present (routed units, C06) — only late-bind when it's empty.

Do **not** touch the ACP driver here: `src/acp-agent-driver.ts` synthesizes its own `message_end` with usage-only and holds only a string spec, so codex/auggie units have no output model. That is a documented gap (see DESIGN Risk 1); C06 guarantees a real model on any unit the loop *acts* on regardless of harness.

## Cross-Repo Side Effects
None. `RunReceipt.model` is already an optional field consumed by `buildAttribution` (`modelFamily(r.model)`) — populating it makes existing attribution honest for fleet units too, a free side-benefit.

## Verify
- Dispatch a fleet unit (no explicit model) through the daemon; after it finishes, read its `receipts/<agentId>.jsonl` and confirm `model` is a real id (e.g. `claude-sonnet-4-5`), not absent.
- Confirm `buildAttribution` over those receipts now shows the real model family instead of everything under `unknown`.
- Unit test: feed a synthetic assistant frame with `message.model` set + `seed.model` unset → accumulator emits that model; with `seed.model` preset → preset wins.
