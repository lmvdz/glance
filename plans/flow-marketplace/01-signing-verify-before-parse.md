# Raw-byte signing + verify-before-parse + top-level allowlist
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 09
TOUCHES: src/capabilities/index.ts, src/marketplace/pack-signing.ts (new), src/push.ts (crypto reuse), tests/pack-signing.test.ts (new)
MODE: afk

## Goal
A pack's authenticity is verified over its EXACT served bytes, BEFORE any structured parse of untrusted input, and
no field that drives a trust decision is left unsigned.

## Approach
Three fixes, all red-team-confirmed:
1. **Sign raw canonical bytes, full manifest — not the subset checksum.** The current checksum (`index.ts:379`)
   covers `{sourceId,framework,slug,version,title,description,files,profiles,workflows,tools,skills,context}` and
   provably EXCLUDES `preview` (the pre-purchase trust surface shown to the buyer), `requiredEnv`, `compatibility`,
   `extra`. Sign a detached ES256 signature (P-256/SHA-256) over the exact canonical manifest bytes the broker
   serves. Reuse the WebCrypto primitives already in `push.ts:73/106-107` (ECDSA generate/import/sign) — zero new
   deps.
2. **Verify before parse.** Today the checksum is computed *inside* `parseCapabilityManifest` (`:366-379`), forcing
   a parse of untrusted input before any integrity check (deserialize-before-verify). Invert: the import entry
   receives `(rawBytes, signature, publisherKeyId)`, verifies the signature against the pinned publisher directory,
   and only then calls the existing parser. A bad signature ⇒ the parser never touches the bytes.
3. **Allowlist top-level keys.** Convert `EXECUTABLE_TOP_LEVEL` (`:199`, applied `:368`) from a denylist to an
   allowlist of permitted top-level keys; unknown keys reject (not silently stashed in `extra`).

**Key model:** two sets — *sign-authorized* (may produce new signatures — current key only) vs *accept* (existing
signatures stay valid — includes rotated-out keys until re-signed/expired). The client pins the broker's
publisher-key directory (from concern 03/09) and caches it. Retain the SHA-256 checksum as the content-address
primitive; the signature is additive.

## Cross-Repo Side Effects
The broker signs with the publisher's key; the spec (09) defines the detached-signature envelope.

## Verify
- A pack whose `preview` (or `requiredEnv`/`compatibility`) is altered after signing FAILS verification (proves
  full-manifest coverage) — mutation-proven.
- A tampered byte anywhere fails; the parser is never invoked on a bad-signature pack (assert parse is not reached).
- An unknown top-level key rejects; `extra` no longer absorbs it.
- Rotation: a signature from a rotated-out (accept-set) key still verifies; a NEW signature from it is refused.
- `push.ts` VAPID path untouched (shared crypto helper, no regression).
