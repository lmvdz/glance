# Scheduling And Retry

Use this when writing retries, repeats, polling workers, backoff, jitter, rate-limit-aware policies, timeouts, or pass loops.

Use `Schedule` for retry, polling, pacing, and repeated background work instead of hand-rolled `while (true)` loops with sleeps.

## Core Rules

- `Effect.retry(...)` retries typed failures; defects and interruptions are not retried.
- `Effect.repeat(...)` repeats successful effects; failures stop repetition unless the pass handles them first.
- The source effect runs once before the schedule is stepped.
- `Schedule.recurs(3)` means three retries/repetitions after the initial run.
- `Schedule.spaced(...)` waits after work completes.
- `Schedule.fixed(...)` aligns executions to a cadence.
- Use `Schedule.exponential(...)` or `Schedule.fibonacci(...)` for backoff.
- Add `Schedule.jittered` to avoid synchronized retry storms.
- Use `Schedule.recurs(...)` for a counter schedule or `Schedule.upTo({ times })` to bound a delay schedule.
- Use `Schedule.tap(...)` to log retry metadata — its callback receives the full `{ input, output, duration, attempt, elapsed }` shape (there is no separate `tapInput` at this pin; pick the field you need off the metadata object).
- Use `Effect.retryOrElse(...)` when exhausted retries need a fallback/reporting effect.
- Retry only at the narrowest boundary with proven idempotency.
- Exhausted failures should remain visible unless the boundary has a truthful fallback.

## Polling Workers

Prefer typed pass failures over cause recovery.

```ts id=polling-worker
import { Effect, Schedule } from "effect"

declare const runPass: () => Effect.Effect<void, { readonly reason: string }>

const pass = runPass().pipe(
  Effect.tapError((error) =>
    Effect.logError("Worker.pass_failed", error),
  ),
  Effect.ignore,
)

const run = pass.pipe(
  Effect.repeat(Schedule.spaced("1 second")),
)
```

This shape says expected operational pass failures are logged and the worker continues. Defects still defect and can reach supervision.

Use cause-level recovery only at supervision boundaries where the policy is truly "report non-interrupt failure and continue".

```ts id=cause-level-supervision
import { Cause, Effect } from "effect"

const logNonInterruptCauseAndContinue = (message: string) =>
  Effect.catchCauseIf(
    (cause: Cause.Cause<unknown>) => !Cause.hasInterrupts(cause),
    (cause) => Effect.logError(message, cause),
  )
```

Do not catch causes just to make failures disappear. If only expected typed failures should be recoverable, use `Effect.catchIf(...)`, `Effect.catchFilter(...)`, `Effect.catchTag(...)`, or `Effect.retry(...)` on those typed errors instead.

## Per-Item Failure Isolation

For batch workers, catch expected item-level typed failures around each item so one bad item does not stall the batch.

```ts id=per-item-failure-isolation
import { Effect } from "effect"

interface Item {
  readonly id: string
}
declare const items: ReadonlyArray<Item>
declare const processItem: (item: Item) => Effect.Effect<void, { readonly reason: string }>

const run = Effect.forEach(
  items,
  (item) =>
    processItem(item).pipe(
      Effect.tapError((error) =>
        Effect.logError("Worker.item_failed", error).pipe(
          Effect.annotateLogs({ itemId: item.id }),
        ),
      ),
      Effect.ignore,
    ),
  { discard: true, concurrency: 5 },
)
```

Only do this when retrying the item later is truthful or skipping the item is the product policy.

## Reusable Retry Policy

```ts id=reusable-retry-policy
import { Effect, Schedule } from "effect"

interface ProjectionError {
  readonly operation: string
}
interface Target {
  readonly id: string
}
declare const reconcile: (target: Target) => Effect.Effect<void, ProjectionError>

const projectionRetrySchedule: Schedule.Schedule<unknown, ProjectionError> =
  Schedule.exponential("100 millis").pipe(
    Schedule.jittered,
    Schedule.upTo({ times: 5 }),
  )

const reconcileWithRetry = (target: Target) =>
  reconcile(target).pipe(
    Effect.retryOrElse(
      projectionRetrySchedule.pipe(
        Schedule.tap((metadata) =>
          Effect.logWarning("Agent.Projection.reconcile.retrying").pipe(
            Effect.annotateLogs({ operation: metadata.input.operation }),
          ),
        ),
      ),
      (error) => Effect.logError("Agent.Projection.reconcile.stopped", error),
    ),
  )
```

Use this when the operation is idempotent and retry state is useful for logs or metrics.

## Rate-Limit-Aware Typed Retry

For provider errors that carry `retryAfterMs`, let the schedule use the larger of the backoff delay and the provider delay.

```ts id=rate-limit-aware-retry
import { Duration, Effect, Schedule } from "effect"

type RateLimited = {
  readonly retryAfterMs?: number | undefined
}

// Schedule.exponential's Input is `unknown` (it accepts any input) — narrowing it to the actual
// provider-error shape up front is a safe, common idiom before composing on Input-aware
// combinators like `modifyDelay` below.
const providerRetrySchedule: Schedule.Schedule<RateLimited, RateLimited> =
  (Schedule.exponential("200 millis") as Schedule.Schedule<Duration.Duration, RateLimited>).pipe(
    Schedule.jittered,
    Schedule.upTo({ times: 5 }),
    Schedule.passthrough,
    Schedule.modifyDelay(({ input, duration }) =>
      Effect.succeed(
        input.retryAfterMs === undefined
          ? duration
          : Duration.max(duration, Duration.millis(input.retryAfterMs)),
      ),
    ),
  )
```

Use this for operation-level retries over typed provider errors. For Effect HttpClient-level 429 handling and proactive pacing, read `HTTP_CLIENTS.md`.

## Timeouts And Delays

- Use `Effect.timeout(...)` when the operation has a real deadline.
- Use `Effect.delay(...)` when one operation should start later.
- Use `Effect.sleep(...)` inside production workflows only when sleeping itself is the domain behavior.
- Avoid manual sleep loops; use `Effect.repeat(...)` with `Schedule` for recurring work.
- In tests, use `TestClock` rather than real time. Read `TESTING.md`.

## Do Nots

- Do not read a retry count, backoff base, or poll interval with `Number(process.env.X) || default` — see `CONFIG.md`'s Do Nots; a deliberately-configured `0` (e.g. "no backoff") silently becomes the default.
