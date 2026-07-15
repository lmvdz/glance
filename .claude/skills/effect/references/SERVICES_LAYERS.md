# Services, Layers, And Modules

Use this when defining service tags, module surfaces, layer implementations, runtime wiring, typed errors, or `Effect.fn` operation boundaries.

## Module Surface

One opinionated application-module style uses file-local role names and one canonical ES module namespace projection. Follow the existing codebase's module style when it has one; this convention is not required by Effect.

```ts id=user-repo-module file=user-repo.ts
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"

// Minimal stand-ins so this module-surface example compiles standalone; a real app defines these
// with SCHEMA.md's pattern (a Schema.Struct + same-name interface).
export type UserId = string
export interface User {
  readonly id: UserId
}

export interface Interface {
  readonly get: (id: UserId) => Effect.Effect<User, NotFound | PersistenceError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/UserRepo",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const get = Effect.fn("UserRepo.get")(function* (id: UserId) {
      // ...
      return yield* Effect.fail(new NotFound({ id }))
    })

    return Service.of({ get })
  }),
)

export class NotFound extends Schema.TaggedErrorClass<NotFound>()(
  "UserRepo.NotFound",
  { id: Schema.String },
) {}

export class PersistenceError extends Schema.TaggedErrorClass<PersistenceError>()(
  "UserRepo.PersistenceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export * as UserRepo from "./user-repo.js"
```

Consumers use the module namespace.

```ts id=user-repo-consumer file=consumer.ts
import { Effect } from "effect"
import { UserRepo } from "./user-repo.js"

export const program = Effect.gen(function* () {
  const repo = yield* UserRepo.Service
  return yield* repo.get("some-id")
})
```

The self-export is deliberate. It lets the file remain the module while giving every consumer the same domain-first name, without a TypeScript `namespace`, wrapper object, or repeated consumer-side aliases: `export * as UserRepo from "./user-repo.js"` at the bottom of `user-repo.ts` (shown above), so siblings write `import { UserRepo } from "./user-repo.js"` and folder/package barrels relay it with `export { UserRepo } from "./user-repo.js"`.

> **Optional, not this repo's convention.** This self-export namespace style is upstream's opinionated default, but it produces the unusual `UserRepo.UserRepo === UserRepo` self-reference, and it is not how this codebase's own modules are organized today (`src/**` has zero `export * as` occurrences at vendor time). Treat it as an aside: reach for it only in a codebase that has already adopted it, and prefer plain named exports or a separate barrel otherwise.

Guidance:

- Do not name the tag class `UserRepo` inside `user-repo.ts`; the module namespace is the domain name.
- In this module style, single-file modules self-export their canonical namespace at the bottom: `export * as UserRepo from "./user-repo.js"`.
- Sibling modules import that namespace from the owning leaf; they do not import through their own aggregate barrel.
- Folder and package barrels relay established leaf identities with `export { UserRepo } from "./user-repo.js"`.
- The resulting `UserRepo.UserRepo === UserRepo` self-reference is unusual. Use this pattern only where the runtime and toolchain support it; otherwise use named exports or a separate barrel.
- Export only intentional surface; keep local schemas, row codecs, helpers, and implementation details unexported.
- Do not introduce TypeScript `namespace` declarations for organization.
- Use a named service class such as `class UserRepo extends Context.Service...` when an external library or existing codebase does not use module namespace style.

## Layer Constructors

Choose the layer constructor that matches the thing produced.

```ts id=layer-constructors
import { Context, Effect, Layer } from "effect"

interface Shape {
  readonly ping: () => Effect.Effect<string>
}
class Service extends Context.Service<Service, Shape>()("LayerConstructors.Service") {}

declare const impl: Shape
declare const makeEffect: Effect.Effect<Shape>

Layer.succeed(Service, impl)       // already-built service
Layer.sync(Service, () => impl)    // lazy synchronous service
Layer.effect(Service, makeEffect)  // effectful service acquisition
```

Guidance:

- Default real implementations to `Layer.effect(Service, Effect.gen(...))`.
- Use `Layer.effectContext(...)` when one acquisition intentionally supplies multiple services, especially first-class test stubs or one client backing several service tags.
- Use `Layer.unwrap(...)` when config or runtime discovery chooses/builds the layer.
- Use `Layer.fresh(...)` or `Effect.provide(layer, { local: true })` only when a test or operation needs isolated acquisition.
- Use `Context.Reference` rarely, only for ambient/defaultable runtime references where a safe default is real.

## Long-Lived Work

A layer that starts a stream, listener, worker, subscription, or forever loop must fork that work into the layer scope. Layer acquisition must complete.

```ts id=long-lived-work
import { Context, Effect, Layer, Stream } from "effect"

interface EventsShape {
  readonly stream: Stream.Stream<string>
}
class Events extends Context.Service<Events, EventsShape>()("LongLivedWork.Events") {}

declare const handleEvent: (event: string) => Effect.Effect<void>

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* Events

    yield* events.stream.pipe(
      Stream.runForEach(handleEvent),
      Effect.forkScoped,
    )
  }),
)
```

Guidance:

- Use `Effect.forkScoped`, `FiberSet`, or `FiberMap` for scoped background work.
- Do not run forever work inline during layer acquisition.
- Do not expose public `start` methods unless the domain explicitly needs manual lifecycle control.

## Runtime Wiring

- Use `Layer.provide(...)` to hide an implementation dependency.
- Use `Layer.provideMerge(...)` only when the dependency should remain exposed for downstream consumers.
- Use `Layer.mergeAll(...)` for independent exposed layers.
- Prefer flat, topologically sorted runtime layer values with named subgraphs.
- Avoid using `provideMerge` as a blind make-it-compile tool.
- Avoid hiding important authority or lifecycle dependencies behind broad invisible provisioning.

## Effect.fn

Use extra `Effect.fn(...)` arguments for wrappers that apply to the whole function call. Each transform receives `(effect, ...originalArgs)`.

```ts id=effect-fn-transforms
import { Effect } from "effect"

interface AttachmentRef {
  readonly id: string
}
declare const api: { readonly read: (ref: AttachmentRef) => Effect.Effect<Uint8Array> }
declare const attachmentError: (
  operation: string,
  meta: { readonly attachmentId: string },
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

const readAttachment = Effect.fn("Attachment.read")(
  function* (ref: AttachmentRef) {
    return yield* api.read(ref)
  },
  (effect, ref) =>
    effect.pipe(
      attachmentError("Attachment.read", { attachmentId: ref.id }),
    ),
)
```

Good whole-function transforms:

- error classification
- localized recovery
- logging annotations
- spans
- retry
- timeout
- ensuring cleanup
- small local provisioning
- result mapping

Guidance:

- Keep the generator body focused on the core workflow.
- Use transforms when the wrapper needs original arguments.
- Do not build long clever pipelines; one or two transforms is usually enough.
- Do not use this for local branch-level handling inside the workflow.

## Operation Error Helpers

For boundary errors with operation labels, prefer a shared curried `mapError` helper over hand-writing wrappers in every module.

```ts id=operation-error-helper
import { Effect, Schema } from "effect"

class PersistenceError extends Schema.TaggedErrorClass<PersistenceError>()(
  "UserRepository.PersistenceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const operationError = <E>(make: (input: { readonly operation: string; readonly cause: unknown }) => E) =>
  (operation: string) =>
    <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, E, R> =>
      effect.pipe(Effect.mapError((cause) => make({ operation, cause })))

const persistenceError = operationError((input) => new PersistenceError(input))

declare const query: Effect.Effect<{ readonly id: string }>

const program = Effect.gen(function* () {
  const row = yield* query.pipe(
    persistenceError("UserRepository.findById"),
  )
  return row
})
```

Name the local helper after the error it produces, such as `persistenceError`, `projectionError`, or `processingError`. Use `Effect.fn(...)` and spans for observability in addition to payload labels, not instead of them.
