# Secret-file permission sweep
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/dal/storage.ts, src/dal/store.ts, src/audit.ts, src/gate-logs.ts, src/state-dir.ts, tests/file-perms.test.ts (new)
MODE: afk

## Goal
Files that hold secrets or secret-adjacent data are not world-readable. Today only 3 files are 0600; everything
else the daemon writes is 0644.

## Approach
`LocalStorageBackend.writeDurable` honors `opts.mode` but defaults to 0644 (`dal/storage.ts:61-124`), and
`appendDurable` (`:126-135`) opens with **no mode at all** → always 0644. Only `auth.ts:29` (token), `push.ts:144`
(vapid), `push.ts:207` (subs) pass 0600.

- Add a `mode` param to `appendDurable` (`fs.open(file, "a", opts?.mode)`), pass `0o600` at its secret-bearing
  callers: `audit.ts:61` (audit.jsonl), `gate-logs.ts:46` (gate logs).
- Pass `mode: 0o600` at `dal/store.ts:37` (state.json — holds full agent DTOs, options, prompts).
- `chmod 0700` the state-dir root on creation (`state-dir.ts`), so directory listing is owner-only even for files
  that slip the sweep.
- Leave genuinely-public files (webapp dist, openapi) untouched — scope to the state dir.

Defense-in-depth on top of single-tenancy: on a shared host, another local process reading `state.json` or
`audit.jsonl` is the threat this closes.

## Cross-Repo Side Effects
None.

## Verify
- New `file-perms.test.ts`: after a write, `fs.stat` on state.json / audit.jsonl / gate-logs shows mode `0600`;
  the state-dir root is `0700`.
- Mutation proof: drop the `mode` at the state.json caller → the perms test goes red.
- Full suite green (no test asserts the old 0644).
