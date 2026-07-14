# Marketplace client — discover / fetch against a broker URL
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 09
TOUCHES: src/marketplace/client.ts (new), src/server.ts, webapp/src/components/Marketplace.tsx (new), webapp/src/lib/api.ts, tests/marketplace-client.test.ts (new)
MODE: afk

## Goal
A glance instance can browse a broker's catalog and pull a pack — the cross-org distribution channel that doesn't
exist today (federation is operator-host-only, NullBus per-org, `manager-registry.ts:119`).

## Approach
An **outbound-only** marketplace client, parallel to `src/capabilities/`, matching the outbound-only shape of
`src/payments/`. No inbound: the broker never calls into a buyer's instance (buyer instances are usually not
internet-reachable, and inbound would recreate a trust inversion).
- `discoverPacks(brokerUrl, query)` → browse signed catalog metadata (incl. the now-signature-covered `preview`).
- `pullPack(packId)` → fetch raw bytes + sig + key id, hand to the import pipeline (concern 02).
- `pinnedPublisherDirectory()` → fetch + cache the broker's publisher-key directory (concern 01 verifies against
  it).
- New API routes (`/api/marketplace/*`, admin tier — mirrors capability routes `authz.ts:77`) that proxy the
  client for the webapp; a `Marketplace.tsx` catalog surface (browse, view provenance/declaration, purchase→install)
  reusing the OrgSettings/CapabilityPanel idioms.
- The buyer-grant step (present the pack's capability declaration from concern 07; buyer grants a subset) lives
  here in the install flow.

Tested entirely against the local stub broker (concern 09) — no production broker needed.

## Cross-Repo Side Effects
The broker (separate program) serves the endpoints this client calls; the spec (09) is the contract.

## Verify
- Against the stub: discover lists signed packs; pull fetches bytes+sig; a tampered catalog entry (bad sig) is
  rejected at display, not just at install.
- The publisher directory is pinned and cached; a key not in the directory fails verification.
- The webapp catalog renders provenance (publisher, structural-verify-labeled badge) + the capability declaration,
  and the buyer-grant step gates install.
- Outbound-only: assert no route lets the broker initiate a call into the instance.
