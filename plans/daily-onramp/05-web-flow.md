# Web flow — `glance here --web` / printed URL

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/index.ts, tests/here-web-flow.test.ts (new)
BLOCKED_BY: 02

## Goal

`glance here` always prints the webapp URL for the session it just opened (terminal-first stays primary, per DESIGN.md — no new auth surface in wave 1); `--web` additionally opens it in a browser. Both ride the EXISTING `?token=` bootstrap the webapp already speaks — no new token minting, no new auth surface. The deferred one-time-token hardening work this flow's own design surfaced is recorded here, verbatim, for whoever picks up that hardening concern later — not built now.

## Approach

**Printed URL, always.** Today `glance up` prints the base URL and token but nothing auto-opens a browser (landscape verified: no browser auto-open anywhere in the codebase); `main()`'s existing `"open"` case (src/index.ts:1095-1099) already just writes `${base(flags)}\n`. `glance here` follows the same shape: after creating the session (concern 02), print `${base}/?token=<token>#/agent/<id>` — reusing `tokenHeader()`'s persisted-token read (src/index.ts, `readFileSync(path.join(stateDirPath(), "access-token"))`) to source the token, and the same `/#/agent/<id>` deep-link shape push payloads already use (`src/push.ts`, `url: "/#/agent/<id>"`).

**Token placement — the one non-obvious ordering constraint.** The webapp's `captureToken()` (webapp/src/lib/api.ts) reads `new URL(location.href).searchParams.get("token")`, then strips it and calls `history.replaceState`. `URLSearchParams` only sees the QUERY string, never the fragment — so the token parameter MUST precede the `#` (`?token=X#/agent/Y`), never follow it (`#/agent/Y?token=X`, which would silently fail to authenticate since the token would live inside the fragment where `searchParams` never looks). This concern's URL construction is the one place this ordering has to be gotten right; get it wrong and the failure is silent (page loads, shows an unauthenticated/empty shell, per `clearToken()`'s own doc comment about exactly this class of confusion).

**`--web` opens it.** Platform-aware open, since this operator runs WSL2 (verified in this session's own environment: `Linux 6.18.33.2-microsoft-standard-WSL2`) where the generic Linux opener does nothing useful: `xdg-open` on native Linux, `wslview` on WSL2 (detect via `WSL_DISTRO_NAME` env var or `/proc/version` containing "microsoft"/"WSL" — `wslview` ships with `wslu` and correctly hands the URL to the Windows-host browser; plain `xdg-open` under WSL2 either no-ops or errors depending on distro). `open` on macOS (`process.platform === "darwin"`), best-effort `start` on native Windows. Spawn detached, ignore the child's own exit code (a missing opener binary should degrade to "URL printed, not opened" with a one-line note — never crash the REPL over a browser-launch failure).

## Deferred: one-time-token hardening findings (verbatim, for the future hardening concern)

The arbitrated design (DESIGN.md, arbitration §2) deliberately defers a real per-link one-time-token surface — terminal-first entry moots the need for it in the primary flow, and building it now would be auth-surface scope creep on a mechanical concern. The following findings, produced during this epic's own red-team review, are recorded here so they are not re-discovered from scratch when that concern is picked up:

- **"Viewer-scoped" cannot prompt.** `prompt`/`create`/`answer`/`interrupt` are operator-tier, not viewer-tier (`commandTier`, src/authz.ts:33-49 — default case returns `"operator"`; only `snapshot`/`subscribe` are `"viewer"`). A hypothetical viewer-scoped one-time link could watch a `here` session but never drive it — any hardening design that assumes "viewer" is a safe default for a shared link is wrong until the tier map itself changes.
- **File mode grants local admin regardless.** `effectiveRole` grants local surfaces admin in file mode (src/authz.ts:15-16 doc comment) — a scoped token is cosmetic in file mode; the real boundary there is "has the bearer token at all," not a tier inside it. Hardening only has teeth in DB mode, where per-org membership already exists.
- **Fragment-vs-query placement** (this concern's own finding, above) — any future one-time-token design must place the token as a query param before the `#`, never inside the fragment, or `searchParams`-based capture silently misses it.
- **Atomicity under concurrent exchange.** A true one-time token needs an atomic check-and-invalidate on first use — two near-simultaneous requests racing the same token must not both succeed (a plain read-then-delete has a TOCTOU window). Not designed here; flagged so the hardening concern treats it as a stated requirement, not an afterthought.
- **WSL2 needs `wslview`, not `xdg-open`.** Recorded here (and implemented in this concern's `--web` opener above) so a future concern touching browser-open doesn't have to rediscover it.

## Cross-Repo Side Effects

none

## Verify

- Unit (`tests/here-web-flow.test.ts`): printed URL has `?token=` before `#/agent/`, never after; opener command selection is correct for `WSL_DISTRO_NAME` set vs unset vs `darwin`; a missing opener binary degrades to a printed note, never a thrown error.
- Live: `glance here --web` from this operator's actual WSL2 shell opens the Windows-host default browser at the correct deep-linked, authenticated URL (confirms `wslview` path works, not just unit-tested).

## Resolution

(filled in when this concern executes)
