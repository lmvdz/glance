# REPO_LOCAL — this repo's Effect v4 pin, ratchet, and blocked APIs

Repo-authored (NOT vendored from upstream — see `PROVENANCE.md`). This is the file the
`AGENTS.md` Effect doctrine section points at for the how-to-write-it detail.

## The pin

`effect@4.0.0-beta` (the `effect-smol` line). What were separate `@effect/*` packages in v3 are
consolidated into the single `effect` package under `effect/unstable/*`. Read the CURRENT pin
from `package.json`/`bun.lock`; this skill's `verified-against` frontmatter stamp is
gate-enforced against it by `scripts/skills-verify.ts`.

## Blocked APIs on this beta (overrides upstream defaults in this skill)

Upstream's Core Defaults say "read runtime config through `Config`" — **in this repo, do not**:
the installed beta lacks the stable Config/runtime surface for the classic `Config.integer`
API, and likewise for `setInterval`→fiber-loop conversions. Stay in the sync `Schema`/`Result`
lane until v4 leaves beta.

## Migration recipes (the ratchet's approved lanes)

- **Reading an env number** → `envInt` / `envNumber` from `src/config.ts`. NEVER
  `Number(process.env.X) || d` — it eats a legitimate `0` and hides garbage (34 call sites hit
  by this in the original migration; also recorded as a Do-Not in `references/CONFIG.md`).
- **Parsing untrusted or cross-boundary JSON** (HTTP body, WS/federation frame, agent-host
  frame, a peer/plane payload, a persisted file you didn't just write) → decode with a `Schema`
  from `src/schema/*`. See `src/schema/client-command.ts` for the pattern: a `Result`-returning
  decoder, `formatDecodeIssue`, and a compile-time drift guard keeping `types.ts` the source of
  truth. NEVER `JSON.parse(...) as T` at a trust boundary.
- **Not everything migrates**: a `throw` for an internal invariant, or `JSON.parse` of a file
  we just wrote, is fine. Gate the boundary, not the whole codebase.

## Secondary references

- `effect-solutions` CLI: `effect-solutions list` for available guides,
  `effect-solutions show <topic>...` for patterns (topics: quick-start, project-setup, tsconfig,
  basics, services-and-layers, data-modeling, error-handling, config, testing, cli). The guides
  target v4.
- The Effect v4 repository (`effect-smol`) is cloned at `~/.local/share/effect-solutions/effect`
  for API exploration; package sources under `packages/`.
