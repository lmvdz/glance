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
- **Follow-up (mechanical, non-urgent):** the ~40 non-authoritative log/cache/cursor writers still use raw `fs`; they migrate by swapping their fs calls for the backend helpers. Durability is unaffected (they were never fsync'd) and they're not authoritative state.

## Verification
- `tests/storage-backend.test.ts`: LocalBackend round-trips; a MemBackend proves `writeFileDurable`/`appendReceipt`/proof all route through the ACTIVE backend; the Archil stub loud-fails; `backendFromEnv` selects.
- Behavior preserved: full suite **1730 pass / 0 fail**, tsc clean — incl. the fsync-spy durability regression test, dal-store round-trips, proof + receipts suites.
- Live-driven: swapping in a MemBackend redirected `RuntimeSettingsStore` + `PolicyStore` writes AND reads entirely — nothing hit disk.

## Notes
- `ArchilStorageBackend` is intentionally NOT implemented: the archil pilot's collaboration/consistency GO-NO-GO gate (`plans/archive/archil-mt-pilot/` concern 02) hasn't run, so live Archil ops would be an unvalidated integration against a paid, unprovisioned dependency. The stub makes the drop-in point typed and explicit while failing loud on misconfig.
