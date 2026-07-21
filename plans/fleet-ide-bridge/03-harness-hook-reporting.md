# Harness hook self-reporting — close the attribution gap

STATUS: done — PR #179 merged, branch patch-equivalent to main; verified on main, 2026-07-21 reality audit

## Reality delta (2026-07-14, PR #179)

The concern's stated premise — cost attribution gap — was WRONG: `src/ingest/claude-code.ts` + `codex.ts` already walk transcripts and attribute spend. The actual gap this closes is LIVENESS (a raw `claude` session is invisible to `glance who` until a transcript walk catches up). Events map onto the EXISTING presence registry, not a new store. Only claude-code's hook schema is verified/written; codex (schema undocumented in CLI) and gemini (not installed) are declared `unverified` and skipped — honesty-tier discipline. Both foreign-lineage reviews found real defects on the config-write + shim surface (path-traversal via sessionId, dead token path, non-atomic write, FD-blocking curl); all fixed + pinned. See PR body for the full table.
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/install-hooks.ts (generalize), src/ingest/, src/server.ts (ingest endpoint), src/doctor.ts (verification probe), tests
BLOCKED_BY: none

## Goal

Foreign harness CLIs (claude, codex, gemini) self-report lifecycle events to the daemon via hooks installed into THEIR OWN config — `~/.claude/settings.json` (Stop/Notification/UserPromptSubmit), `~/.codex/hooks.json`, `~/.gemini/settings.json` — so ad-hoc sessions in registered projects are attributed (cost/activity ingesters see them) and become adoptable raw material for Epic E. terax proved this trick works across all three CLIs (BRIEF.md, agent.rs section).

## Recon first (30 min, in-repo)

Read the current hook schema docs for all three CLIs at implementation time — terax's shapes are evidence they exist, not a spec to copy blind. Also read `src/ingest/` to reuse the existing per-harness ingester seam (claude-code + codex ingesters exist; see harness-attribution memory).

## Approach

- Extend `src/install-hooks.ts` (which already owns the "install once, no per-invocation flags" doctrine for omp extensions) with `--harness-hooks` mode: writes idempotent hook entries whose command is a tiny shim script (dropped in the state dir) that POSTs `{harness, event, sessionId?, cwd, ts}` to the daemon.
- Scope discipline — hooks fire for EVERY user session, so: the shim exits 0 instantly when `cwd` is not inside a registered project (read project registry paths from a cached file, no daemon call on the hot path), AND the daemon re-checks server-side. Never block or slow the user's session: fire-and-forget with a ~1s timeout, always exit 0.
- Auth: shim reads the daemon token the same way the CLI does (config/state dir); events land at `POST /api/ingest/harness-events` (new, viewer-tier write-only) and flow into the existing ingest pipeline keyed by repo path + harness.
- `glance doctor`: new probe — hooks installed for each detected harness CLI, shim present, endpoint reachable; suggests the install command when missing.
- Uninstall path (`--uninstall` parity) and idempotent re-install (JSON-merge, never clobber user's other hooks — surgical insert/remove of our entries only).

## Acceptance

- Unit tests: JSON merge in/out preserves foreign hook entries byte-for-byte elsewhere; shim scope check; endpoint validation.
- Live: install hooks, run a raw `claude -p "hi"` inside a registered project, see the event in the ingest store; run one OUTSIDE a registered project, see nothing. Doctor probe green/red states demonstrated.
