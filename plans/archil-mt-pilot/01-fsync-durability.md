# fsync durability hardening of the persistence layer
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/dal/store.ts, src/receipts.ts
PLANE: OMPSQ-75 — https://app.plane.so/inkwell-finance/browse/OMPSQ-75/

## Goal

Every *committed* persistence write survives a host crash, by invoking the durability barrier that both
POSIX and Archil define (`fsync` = durably committed). Today the persistence layer never fsyncs, so committed
bytes sit in a machine-local cache pending async flush — the exact data a crash loses. This is correct on
plain local disk too (crash-safety), and is the prerequisite for any durability claim — so it is the
ONE piece of real code that earns its place before the collaboration gate. **No-regret in either framing**
(local-disk replacement OR collaborative agentic-OS substrate): an agentic OS that loses committed agent
expression on a crash is broken.

This concern is **fully engineering-ready** — no Archil account or mount required.

## Approach

Add a single durable-write helper and route the persistence writes through it.

1. **Helper** (in `src/dal/store.ts`, exported for reuse, or a small `src/dal/durable-write.ts`):
   ```ts
   import * as fs from "node:fs/promises";
   /** Atomically + durably write `data` to `file`: temp → fsync(file) → rename → fsync(dir). */
   export async function writeFileDurable(file: string, data: string): Promise<void> {
     const dir = path.dirname(file);
     await fs.mkdir(dir, { recursive: true });
     const tmp = `${file}.tmp`;
     const fh = await fs.open(tmp, "w");
     try {
       await fh.writeFile(data);
       await fh.sync();            // fsync the file's bytes
     } finally {
       await fh.close();
     }
     await fs.rename(tmp, file);
     // fsync the directory so the rename itself is durable.
     const dfh = await fs.open(dir, "r");
     try { await dfh.sync(); } finally { await dfh.close(); }
   }
   ```
   On any throw, best-effort `fs.rm(tmp,{force:true})` (preserve today's behavior at store.ts:81-83).
   `ponytail:` directory-fd fsync is skipped on platforms where opening a dir for fsync fails (some FUSE) —
   catch `EISDIR`/`EINVAL`/`EBADF` there and proceed; name the ceiling in the comment.

2. **Route `FileStore.save`** (store.ts:75-84) through `writeFileDurable(this.stateFile, JSON.stringify(...))`,
   dropping the inline `writeFile`+`rename` (same temp+rename semantics, now fsynced).

3. **Route `DbStore.saveTranscripts`** (store.ts:229-238) through the same helper (identical temp+rename today).

4. **`appendReceipt`** (receipts.ts:163): after the `appendFile`, fsync the file — open with flag `"a"`, write,
   `fh.sync()`, close (replaces the bare `appendFile`). Keep the per-line-tolerant read path
   (receipts.ts:173-184) untouched; a torn tail line is already tolerated, fsync just narrows the window.

Behavior is otherwise identical: same files, same JSON shape, same atomic rename. No interface change, so no
caller updates.

## Cross-Repo Side Effects
None. Internal to omp-squad's persistence layer; `Store` interface unchanged.

## Verify
- New `tests/durable-write.test.ts`: (a) `writeFileDurable` produces the file with exact content and removes
  the `.tmp` on success; (b) a spy on the `FileHandle.sync` (or `fs.fsync`) path asserts fsync is invoked on
  the commit (so a future refactor that drops it fails the test); (c) a thrown write leaves neither a partial
  target nor a stray `.tmp`.
- Existing persistence/round-trip tests (`tests/context-store.test.ts` and any `state.json` round-trip) stay
  green — behavior-preserving.
- Gate: `bun run check` + `bun test`.
