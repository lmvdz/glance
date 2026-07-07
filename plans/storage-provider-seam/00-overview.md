# Pluggable storage-provider seam (Archil green-light follow-up, sans Archil)

## Outcome
omp-squad's durable state is written and read through one swappable `StorageBackend`. The backend is
`LocalStorageBackend` today (byte-identical to the prior direct-fs behavior); a different substrate —
an Archil shared/branchable mount, S3, a networked FS — is a drop-in via one interface, with **zero
call-site changes**. This is the `OrgStorage`/`ArchilStorage` "payoff" the archil pilot deferred,
built here decoupled from Archil (operator chose "storage seam, skip Archil").

## What shipped

| Piece | Where |
|---|---|
| `StorageBackend` interface (writeDurable/appendDurable/readText/readTextSync/readdir/remove/mkdir/exists) | `src/dal/storage.ts` |
| `LocalStorageBackend` — the durable-write (temp→fsync→rename→fsync-dir) + fs primitives, moved out of `store.ts` | `src/dal/storage.ts` |
| `ArchilStorageBackend` — typed drop-in stub that LOUD-FAILS until the pilot's gate runs (never silently degrades) | `src/dal/storage.ts` |
| `setStorageBackend`/`getStorageBackend`/`backendFromEnv` (`OMP_SQUAD_STORAGE_BACKEND=local\|archil`), selected at daemon boot | `src/dal/storage.ts`, `src/index.ts` |
| `writeFileDurable` → delegates to the backend (so `FileStore`, settings, policy ride it for free) | `src/dal/store.ts` |
| `appendReceipt` → `backend.appendDurable` | `src/receipts.ts` |
| proof records (runProof/recordProof write, proofFor read, sweepProofs) → backend (also upgrades proof writes to durable) | `src/proof.ts` |
| config stores fully swappable — `RuntimeSettingsStore` + `PolicyStore` load/exists → backend (daemon-side reads) | `src/runtime-settings.ts`, `src/policy.ts` |

## Scope boundary (deliberate)
- **In:** the DAEMON's authoritative durable state — roster/feature `state.json`, transcripts, feedback, settings, policy, receipts, proofs. Keyed by absolute path, so per-org roots are encoded in the path (not the backend instance).
- **Out (correct, not a gap):** git **worktrees** (real fs paths git operates on directly — an Archil deployment *mounts* them), and **agent-process reads** (`readPolicyDocSync` — a separate process reads the mounted disk directly, not the daemon's backend).
- **Migration completed (2026-07-07):** the remaining state-dir writers are now routed too — 19 more files. The backend gained `writeDurableSync` (a sync durable write, so the sync JSON ledgers route with ZERO async-ripple and get a durability upgrade) and a `mode?` write option (so secret files keep `0o600`). Routed: dispatch-ledger, failure-memory, orchestrator-state, scout-cursor, model-outcomes, done-proof (ledger), opportunity, scout, land-pr (PendingPr ledger), resident-planner (state), digest, audit, comments, fabric (reads), the 3 ingest cursors, and auth/push secrets.
- **Deliberately still raw fs (NOT gaps — routing them would be wrong or lossy):**
  - `convergence-oracle.ts` — a filesystem CONTRACT shared with `scripts/continue-loop.sh` (bash reads the same files and can't call the backend); routing it would let daemon + shell diverge on a non-local backend.
  - `state-lock.ts` — the single-writer mutex needs real hardlink semantics + local `/proc` liveness; a networked/branchable substrate breaks it.
  - `metrics.ts` / `jsonl-log.ts` — best-effort, ring-authoritative hot logs (per-sample fsync would hurt; jsonl-log rotation needs stat/rename the seam doesn't expose). The in-memory ring is the source of truth; the file degrades to local, which is fine.
  - `plane-secrets.ts` — a HOST credential file (`~/.claude/secrets/plane.env`) outside the state dir; a swapped substrate wouldn't contain it.
  - worktree/repo writers (architect, plan-writer, workflow/executor, features, explore) and not-fs hits (validate, smart-spawn, workflow-source, intake).

## Verification
- `tests/storage-backend.test.ts`: LocalBackend round-trips; a MemBackend proves `writeFileDurable`/`appendReceipt`/proof all route through the ACTIVE backend; the Archil stub loud-fails; `backendFromEnv` selects.
- Behavior preserved: full suite **1730 pass / 0 fail**, tsc clean — incl. the fsync-spy durability regression test, dal-store round-trips, proof + receipts suites.
- Live-driven: swapping in a MemBackend redirected `RuntimeSettingsStore` + `PolicyStore` writes AND reads entirely — nothing hit disk.

## Notes
- `ArchilStorageBackend` is intentionally NOT implemented: the archil pilot's collaboration/consistency GO-NO-GO gate (`plans/archive/archil-mt-pilot/` concern 02) hasn't run, so live Archil ops would be an unvalidated integration against a paid, unprovisioned dependency. The stub makes the drop-in point typed and explicit while failing loud on misconfig.
