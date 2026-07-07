# Provenance schema + proposal UI
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/capabilities/index.ts, src/dal/store.ts, src/server.ts, webapp/src/components (new proposal card)

## Goal
Let a `CapabilityInstall` record where it came from, and surface factory demands as proposal cards a human can act on. Today `CapabilityInstall` has no `origin`/`provenance` field and `recordAudit` logs only `{packId, checksum, state, verification}` — so a factory-authored capability is untraceable back to its demand and proof.

## Approach
- **Schema (red team B#1):** add to `CapabilityInstall` in `src/capabilities/index.ts`:
  ```ts
  origin?: "manual" | "factory";
  provenance?: { demandId: string; evidence: DemandEvidence; acceptanceAssertion?: string; proofId?: string };
  ```
  Thread it through `installCapability`/`updateCapabilityInstall` inputs and the `dal/store.ts` normalize/serialize path (real migration — tolerate installs without the field). `proofId` stays optional/unused in v1 (v2 fills it).
- **Audit:** include `origin` + `provenance.demandId` in every `recordAudit` payload (install/enable/rollback) so the trail is queryable.
- **Proposal UI:** a proposal card in the webapp admin capability surface that lists `proposed` demands (from the queue, exposed via a read route on `src/server.ts`, viewer-readable) showing the demand evidence, the drafted manifest, and the acceptance assertion. An **"Author from this proposal"** action drops the human into the existing capability-install admin flow with the draft manifest pre-filled (`origin:"factory"`, `provenance` attached). The human remains the author and enabler — no autonomous install.
- Reuse the existing capability admin components; do not build a parallel install UI.

## Cross-Repo Side Effects
`CapabilityInstall` shape change touches federation metadata (`capabilityFederationMetadata`) and any `src/schema/` decoder for the snapshot — declare the new optional fields where decoded (`Schema.Struct` strips undeclared keys). Webapp reads a new proposals route.

## Verify
- Install a capability with `origin:"factory"` + provenance → round-trips through `dal/store.ts` and appears in `recordAudit` with `demandId`.
- Proposal card renders a `proposed` demand; "Author from this proposal" pre-fills the install flow with the manifest and provenance.
- Legacy installs without the field still load. `bun test` + webapp build green.
