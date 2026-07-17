# Entitlement client + instance identity (cooperative)
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 03, 09
TOUCHES: src/marketplace/entitlement.ts (new), src/marketplace/instance-identity.ts (new), src/capabilities/index.ts, tests/entitlement.test.ts (new)
MODE: afk

## Goal
An honest instance verifies, displays, and honors licensing — while the design states plainly that this is
cooperative, not crypto-enforced against a root-controlling buyer.

## Approach
**The one enforced control is download gating (broker-side).** Everything on the buyer's box is cooperative:
- **Instance identity:** the instance generates an ES256 keypair at first marketplace connect and registers the
  pubkey with the broker. Entitlements bind to this **instance identity + the purchaser's broker account** — NOT
  `orgId`, which collapses to the operator-controlled constant `"file"` in single-tenant (`index.ts:409`,
  `squad-manager.ts:1994`) and can't identify a licensee. DB-mode orgs layer on later; file-mode works day one.
- **Entitlement token:** broker-signed `{licenseeIdentity, packId, checksum, license, validUntil, seats}`. The
  client verifies (signature + expiry), stores it, **refuses by default to run an unentitled marketplace pack**,
  displays license status, and syncs revocations (concern 05). Offline-verifiable for the honest path.
- **Honesty, in code comments and UI copy:** entitlement verification is cooperative — it makes honest instances
  behave (license display, seat counts, expiry warnings); a root buyer can patch it out, and that's fine, because
  seller protection is download-gating + fingerprint + legal (concern 06), never DRM-on-the-box.

Purchase itself is broker-side (Stripe etc. — the separate program); glance redirects to broker checkout and pulls
the minted entitlement. glance's `payments/` is outbound-only (rewards) and is NOT reused for inbound.

## Cross-Repo Side Effects
The broker mints/serves entitlements (spec 09); inbound payment processing is the broker program's, off every
buyer's instance (keeps PCI scope off single-tenant deployments).

## Verify
- An unentitled marketplace pack is refused at run by default; a valid entitlement permits it.
- Entitlement binds to the instance keypair, not `orgId` (assert `orgId="file"` doesn't grant cross-instance).
- Expiry/seat display works; an expired subscription blocks by default.
- The cooperative posture is stated in the UI copy and the module doc (grep: no "DRM"/"enforced" overclaim).
