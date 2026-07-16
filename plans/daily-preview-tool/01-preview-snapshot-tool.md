# Preview snapshot host-tool

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts (SQUAD_HOST_TOOLS :247, onHostTool :7834, registerHostTools :7817, daemon boot path), src/harness-registry.ts (Bun.which precedent, no change expected), tests

## Goal

Add a new `HostToolDef` — `preview_snapshot` — to `SQUAD_HOST_TOOLS` (`src/squad-manager.ts:247`, mirroring `squad_kb_search`'s shape: name/description/parameters, dispatched via a `handle*Tool` method following the `handleKbSearchTool` pattern) so a driven agent can request a screenshot of a page inside a preview it's building, without the daemon hosting a browser or an MCP server. The daemon shells out to the `agent-browser` CLI as a one-shot subprocess per call — the same "spawn an external binary, collect artifacts, respond" shape `src/vision.ts`'s `ompProducer` already uses, just synchronous per-call instead of an autonomous multi-shot pass.

## Approach

**Tool shape.** `preview_snapshot({ origin: string, path: string, verb?: "open"|"screenshot" })` (or equivalent) — `origin` names one of the operator-registered preview origins from concern 02's registry (never a bare URL string the agent invents), `path` is a path *within* that origin (leading `/`, relative). The handler joins `origin + path` into a full URL only after `origin` is validated against the registry (concern 02 owns that check; this concern's handler calls into it, does not duplicate it). Parameters and description follow `KB_SEARCH_TOOL`'s style: a `usage:` error string on malformed input via `rec.agent.respondHostTool(call.id, ..., true)`, mirroring `handleKbSearchTool`'s early-return shape.

**Binary pinning at daemon boot (BINDING).** `agent-browser` today resolves to `/home/lars/.volta/bin/agent-browser`, a volta shim — verified live: `env -i PATH=/usr/bin:/bin /home/lars/.volta/bin/agent-browser --version` still exits 0 and prints `agent-browser 0.25.3`, so the *absolute path* survives even a stripped daemon-launch environment (systemd/non-login-shell), but a bare `agent-browser` on `PATH` would not survive that same stripping. Resolve the absolute path ONCE at daemon boot using the same pattern `harness-registry.ts`'s `binResolvable` already uses for exactly this class of hazard: `Bun.which("agent-browser", { PATH: augmentedPath })` where `augmentedPath` includes common install roots (`~/.volta/bin`, `~/.local/bin`, the raw `process.env.PATH`) the same way `binResolvable` augments with `node_modules/.bin` for `omp`. Cache the resolved absolute path for the daemon's lifetime (module-level, like `resolveSpawnBin`/`harnessTierInfo`'s caching). **If resolution fails, the tool is not registered at all** — `SQUAD_HOST_TOOLS` construction (or `registerHostTools`'s tool-list assembly, the same conditional-inclusion pattern already used for `RECORD_DECISION_TOOL_DEF`'s flag gate) must exclude `preview_snapshot` when the binary isn't found, so a harness's `set_host_tools` call never advertises a tool that will 404 on first invocation. This mirrors the existing `harnessTierInfo` philosophy verbatim: "a verified [tool] that will fail to spawn is a worse trap than an honestly-unverified one" (`harness-registry.ts:129`) — surface the absence at boot/doctor time, never at first call.
- `glance doctor` gets a probe (same shape as the harness-hook-reporting doctor probe, fleet-ide-bridge/03): binary resolved yes/no, resolved path shown, tool registered yes/no.

**Concurrency (RESEARCH NOTE, not yet a design decision).** `agent-browser` maintains browser state across invocations (`connect`, `close [--all]` verbs exist, implying a persistent session/profile rather than a fresh browser per invocation). If two units in parallel both call `preview_snapshot` against the same daemon, a shared browser profile could mean one agent's navigation clobbers another's in-flight screenshot, or `close --all` from one call tears down a session another call is mid-use with. Before implementing the dispatch handler, investigate `agent-browser`'s actual session semantics (does it default to an isolated profile per invocation, or one persistent daemon-wide browser process the CLI attaches to?) — this determines whether the fix is (a) a per-unit session flag if `agent-browser` supports naming/isolating sessions, or (b) a serialization queue in the daemon (one `preview_snapshot` call in flight at a time, others queued) if it doesn't. Record the finding and the chosen mitigation as an addendum to this concern before merging the dispatch handler; do not ship an unserialized handler against a shared-profile CLI without one of the two mitigations in place.

**Subprocess execution.** Follow `vision.ts`'s spawn shape: `Bun.spawn([resolvedAbsolutePath, verb, url], { cwd: worktree, stdout: "pipe", stderr: "ignore", env: scrubbedSpawnEnv(...), signal: AbortSignal.timeout(...) })` — reuse `scrubbedSpawnEnv`/`gitNoSignEnv` so the preview subprocess doesn't inherit daemon secrets, same as every other tenant-agent-adjacent spawn in this codebase. A bounded timeout (the vision pass uses 180s for a multi-shot LLM loop; a single screenshot needs far less — seconds, not minutes) so one bad call can't hang the calling agent's turn indefinitely.

## Cross-Repo Side Effects

None — omp-squad only. The tool is visible exclusively to `caps.hostTools` harnesses (omp today; ACP/pi are `hostTools:false` in `harness-registry.ts`), so no glance-desktop or cockpit surface is touched by this concern.

## Verify

- Unit: `SQUAD_HOST_TOOLS` excludes `preview_snapshot` when the resolved-binary cache is empty (simulate absence by pointing the resolution PATH at a directory without the binary); doctor probe reports the same absent/present state consistently with what was registered.
- Unit: handler rejects a malformed call (missing `origin`/`path`) with the `usage:` error shape before ever spawning a subprocess.
- Live (scratch-daemon): boot with `agent-browser` present, confirm `preview_snapshot` appears in an omp agent's tool list (`set_host_tools` payload) and a call against a registered origin (concern 02, stubbed/mocked until 02 lands) returns a screenshot artifact reference. Boot with the resolution path broken, confirm the tool is silently absent from the same agent's tool list and `glance doctor` flags it — never a first-call failure.
- Concurrency: whatever mitigation the research note lands on (session flag or serialization queue) gets its own test — two parallel `preview_snapshot` calls against the same origin do not interleave/clobber each other's session state.
