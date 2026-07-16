# Preview origin registration + SSRF denylist

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: new preview-origin registry (project-registry.ts shape/pattern), src/ssrf.ts or a sibling module, src/authz.ts (restActionTier), src/server.ts (registration route)
BLOCKED_BY: 01

## Goal

This is the actual security surface of the epic (arbitration §10, binding). An agent must never be able to name an arbitrary URL and have the daemon fetch+screenshot it — that is the daemon's own SSRF-prone browser act on the agent's behalf, plus a route to the daemon aiming its screenshot capability at itself. Two distinct protections, both required:

1. **Registration is OPERATOR-tier only, never the agent.** The natural UX an agent would reach for — "my dev server is on :5173, let me register and preview it" — must go through a human or a pre-declared unit profile, never a tool call the agent itself makes mid-turn.
2. **The daemon's own origin/port is denylisted REGARDLESS of allowlist contents.** Even an operator-registered allowlist must not be able to include the daemon's own admin surface — an agent screenshotting the daemon's admin UI is a privilege downgrade of the admin-only vision route (`src/authz.ts:79-83`, the `/^\/api\/agents\/[^/]+\/(land|vision)$/` admin gate — vision is admin-only specifically because it "drives the daemon's browser off-box"; a preview tool that could point at the daemon's own UI would let an operator-tier-adjacent registration act as an end-run around that admin gate for the daemon's own surfaces even if not for third-party ones).

## Approach

**Registry.** New durable registry, same shape as `src/project-registry.ts` (a per-stateDir tiny-JSON-set, decoded through `decodeJsonWith`/a real `Schema` not a `JSON.parse as` cast, `RegistryWrite`/`RegistryDelete`-style idempotent add/delete, "registration does not touch anything, deregistration deletes nothing" semantics). Entries are `{origin: string, label?: string}` — an origin (scheme+host+port), not a path (paths are the tool-call-time parameter from concern 01). Registration happens via a REST route gated `admin` in `restActionTier` (`src/authz.ts`) — the same tier the project registry itself uses (`if (pathname === "/api/projects") return method === "GET" ? "viewer" : "admin"`, `authz.ts` near line 62) — reads are viewer, writes are admin. **No path exists for an agent's host-tool call to add/modify this registry** — `onHostTool`'s dispatch table (concern 01) only ever reads it, never writes it. Note in `00-meta.md`'s locked decisions: this is stricter than most registration in the codebase (which is merely admin-tier); it is agent-inaccessible by construction, not just role-gated, because the whole point is removing the agent's ability to choose the destination at all.

**Hard denylist (regardless of allowlist).** Before any origin is accepted into the registry (write-time) AND again before any resolved URL is dispatched to `agent-browser` (call-time, belt-and-suspenders against a registry entry added before this check existed or a bug in the write-time check): reject any origin whose host+port matches the daemon's own bound address. The daemon's port is `DEFAULT_PORT`/`OMP_SQUAD_PORT` (`src/index.ts` — `--port` flag, `$OMP_SQUAD_PORT`, printed at `cmdUp`); loopback host matching that port (`127.0.0.1`, `localhost`, `::1`, and any address the daemon actually bound to, not just the literal string) is denylisted independent of what the registry otherwise contains. This denylist check cannot be satisfied away by an operator — it is not a registry entry that can be deleted, it is a code-level guard that runs on every registration write and every dispatch.

**Resolved-URL validation AFTER path-joining.** Concern 01's handler joins `origin + path` before validation ever runs — validate the FULL resolved URL (origin + path + any query the path parameter might carry), not just the registered origin string, so a path segment cannot smuggle a scheme/host override past a check that only looked at the origin (e.g. a `path` value containing `//evil.example.com` or similar that a naive string-concat + `new URL()` re-interprets as a new authority). Use `new URL(path, origin)` and then re-check `.origin` on the RESULT still equals the registered origin's `.origin` — reject if path-joining silently changed the authority.

**This is NOT `src/ssrf.ts`'s existing case — it is the inverted shape.** `checkVisionUrl` (`src/ssrf.ts`) exists to BLOCK loopback/private/link-local ranges by default, with `OMP_SQUAD_APP_URL` as the one allowlisted exception — its whole design assumes private-range = dangerous, public = fine. The preview tool's threat model is the opposite: legitimate preview targets are OVERWHELMINGLY loopback/private (`localhost:5173`, a dev server on the operator's LAN) — that's the entire point of the tool — so blanket-blocking private ranges would make it useless. The actual danger here is one specific loopback target (the daemon's own port), not the whole private range. Do not reuse or relax `checkVisionUrl` for this; write new validation — same file (`src/ssrf.ts`, as a second exported function with a comment explaining the inverted assumption) or a sibling module — that: allows arbitrary loopback/private/public origins EXCEPT the daemon's own bound origin/port, resolved via DNS the same defensive way `checkVisionUrl` does (resolve the hostname, check the RESOLVED address against the daemon's own bound address/port, not just the literal string — a DNS entry or `/etc/hosts` alias pointing at 127.0.0.1 must not bypass the string-level check).

**Cross-lineage review is MANDATORY** (arbitration §10, meta 00-meta.md's blanket rule for any auth-surface touch) — both codex and grok review this concern's diff before it lands, independent of the standard review gauntlet. Given the harness-hook-reporting precedent (fleet-ide-bridge/03: codex found a path-traversal + non-atomic write, the OTHER foreign lineage found a different defect class on the same diff — "each also refuted a false claim from the other"), budget for both passes finding real, non-overlapping issues.

## Cross-Repo Side Effects

None — omp-squad only. No webapp UI for registration ships in this concern (see 00-overview.md's "Out of scope" — a UI is a follow-up once a real consumer exists); registration is REST-only, operator-tier, driven by a human via `curl`/a future CLI verb, or a pre-declared unit profile field.

## Verify

- Unit: write-time denylist rejects the daemon's own `127.0.0.1:<port>`, `localhost:<port>`, and a DNS name resolving to the daemon's bound address, regardless of an admin caller attempting to register it.
- Unit: call-time re-check catches a registry entry that predates the denylist (simulate by inserting one directly into registry storage, bypassing the write-time guard) — dispatch still refuses it.
- Unit: path-join authority-smuggling test — a `path` value crafted to change the resolved URL's origin is rejected even though the registered `origin` string alone looks fine.
- Unit: `restActionTier` returns `admin` for the registration route's non-GET methods, `viewer` for GET, and the host-tool dispatch path (concern 01) has literally no code path that calls the registry's write function.
- Live (scratch-daemon): register a real local dev server's origin as admin, confirm a `preview_snapshot` call against it succeeds; attempt to register the scratch daemon's own origin/port as admin, confirm the registration write itself is rejected (not just silently dropped) with a clear reason.
- Cross-lineage: codex AND grok review this concern's diff before merge; findings from each get their own follow-up items, adjudicated against the code per the model-routing doctrine (a reviewer's finding is a hypothesis, not a verdict).
