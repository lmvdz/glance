# Import trust pipeline — default-untrusted + structural-verify relabel
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01, 09
TOUCHES: src/capabilities/index.ts, src/server.ts, src/marketplace/import.ts (new), tests/marketplace-import.test.ts (new)
MODE: afk

## Goal
A marketplace pack enters through a fail-closed pipeline that treats it as untrusted third-party code and never
lets structural verification read as behavioral safety.

## Approach
Sequence the import (each stage fail-closed):
1. **Fetch** raw bytes + detached sig + publisher key id (download entitlement-gated broker-side, concern 04).
2. **Verify signature over raw bytes** (concern 01) against the pinned publisher directory. Fail ⇒ discard unparsed.
3. **Parse** under the top-level allowlist (concern 01); unknown keys reject.
4. **Structural verification** (`verifyCapabilityPack`, `:236-270` — identity/schema/compat/path-escape). **Relabel
   it everywhere — API field, UI badge, audit string — as "structural verification": provenance + well-formedness
   only, NEVER behavioral safety.** It has no content/behavior scan and the design forbids implying one.
5. **Record `sourceKind:"marketplace"` and `trusted:false` UNCONDITIONALLY.** Today `importCapabilitySource` sets
   `trusted: input.trusted !== false` (`index.ts:348`) — trusted-OPEN by default, and catalog imports inherit it.
   Marketplace imports hard-set untrusted regardless of input. The `sourceKind` marker is NOT operator-editable
   through the normal API (the run-gate keys off it).
6. **No run-gate at import** — gating happens at execution (concern 08), so it reflects the instance's *current*
   containment capability, not its capability at install time.

Reuse `parseCapabilityManifest`/`sanitizeRepoProfile`/`verifyCapabilityPack` — but re-sequenced behind signature
verification. `sanitizeRepoProfile` (`agent-profiles.ts:111-124`) applies to every profile in a marketplace pack
(a marketplace pack IS the untrusted "repo" trust class): `bin` dropped, `harness` rejected unless verified, `mcp`
dropped.

## Cross-Repo Side Effects
The webapp install UI shows the structural-verify badge (relabeled) + the capability declaration for buyer grant.

## Verify
- A marketplace import records `trusted:false` + `sourceKind:"marketplace"` even if the input says `trusted:true`
  (mutation-proven: force `trusted:true` in the body → still recorded untrusted).
- A bad-signature pack never reaches parse/verify (assert ordering).
- The structural-verify result is labeled "structural" in the API/audit output (grep the response — no "safe"/
  "verified-safe" wording).
- `sanitizeRepoProfile` fires on marketplace-pack profiles (bin/mcp dropped, unverified harness rejected).
