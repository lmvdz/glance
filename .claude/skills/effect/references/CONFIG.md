# Config

Use this when reading runtime configuration, env vars, `.env` files, provider-specific settings, or writing `layerConfig(...)` helpers.

Read runtime configuration through Effect `Config` recipes and provider layers, not direct `process.env` access inside application logic.

```ts id=config-basics file=config-basics.ts
import { Config, Context, Effect, Layer, Schema } from "effect"

const AbsolutePath = Schema.String.pipe(Schema.brand("AbsolutePath"))

export const dataDirectoryConfig = Config.schema(
  AbsolutePath,
  "APP_DATA_DIR",
)

interface ConfigurationShape {
  readonly apiKey: unknown
  readonly optionalModel: unknown
  readonly enabled: boolean
}
export class Configuration extends Context.Service<Configuration, ConfigurationShape>()(
  "Config.Configuration",
) {}

export const layerFromEnvironment = Layer.effect(
  Configuration,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("API_KEY")
    const optionalModel = yield* Config.option(Config.string("MODEL"))
    const enabled = yield* Config.boolean("FEATURE_ENABLED").pipe(
      Config.withDefault(false),
    )

    return Configuration.of({ apiKey, optionalModel, enabled })
  }),
)
```

## Config Recipes

- `Config<T>` is yieldable and reads the current `ConfigProvider` reference.
- The default provider is `ConfigProvider.fromEnv()`.
- Use `Config.redacted(...)` for credentials.
- Use `Config.schema(...)` or `Config.mapOrFail(...)` for refined values.
- Use `Config.option(...)` for semantic absence.
- Use `Config.withDefault(...)` for missing-data defaults only; malformed values still fail.
- Use `Config.orElse(...)` only when intentionally catching any config parse failure.
- Use `Config.unwrap(...)` / `Config.Wrap<T>` for `layerConfig(...)` helpers.

## Providers

- Use `ConfigProvider.layer(provider)` to replace the active provider for an app or suite.
- Use `ConfigProvider.layerAdd(provider)` for fallbacks; pass `{ asPrimary: true }` when the added provider must override the current provider.
- Use `ConfigProvider.fromUnknown(...)` for deterministic test config.
- Use `ConfigProvider.fromEnv(...)` for environment variables.
- Use `ConfigProvider.constantCase` when camelCase schema keys should read `SCREAMING_SNAKE_CASE` env vars.
- Use `ConfigProvider.nested(...)` to scope a provider under a prefix.
- Treat `.env`, directory, and environment providers as startup/boundary sources, not business-workflow reads.

## Layer Config Helpers

Library-style layers often expose both concrete `layer(options)` and config-backed `layerConfig(options: Config.Wrap<Options>)`.

```ts id=layer-config-helper
import { Config, Context, Effect, Layer } from "effect"

interface ClientOptions {
  readonly baseUrl: string
}
interface ClientShape {
  readonly baseUrl: string
}
class Client extends Context.Service<Client, ClientShape>()("Config.Client") {}

declare const makeClient: (options: ClientOptions) => Effect.Effect<ClientShape>

export const layerConfig = (
  config: Config.Wrap<ClientOptions>,
) =>
  Layer.effect(
    Client,
    Config.unwrap(config).pipe(
      Effect.flatMap(makeClient),
      Effect.map((client) => Client.of(client)),
    ),
  )
```

Use this pattern when a service naturally supports runtime config while still allowing tests to pass concrete values.

Use `Layer.succeed(AppConfiguration.Service, testConfig)` when the app already wraps environment config in an application service and the test does not need to exercise Config decoding itself.

## Do Nots

- Do not use `as any`, non-null assertions, or unchecked casts to silence Effect typing problems.
- Do not read runtime config with `Number(process.env.X) || default` — a legitimate, intentional `0` (or any other falsy-but-valid numeric value) silently becomes `default` instead, because `0 || default` evaluates to `default`. This class of bug hit 34 call sites in one migration in this repo before it was caught. Use an explicit `undefined`/`NaN` check (`const n = Number(process.env.X); const value = process.env.X === undefined || Number.isNaN(n) ? default : n;`) or, preferably, read it through `Config.number("X").pipe(Config.withDefault(default))` so the falsy-eating bug class cannot recur.
- Do not bypass `Config`/`ConfigProvider` with direct `process.env` reads in application logic — it forgoes typed decoding, redaction, and the ability to swap providers in tests.
