# Federated capability metadata distribution
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: `src/federation.ts`, `src/manager-registry.ts`, `src/server.ts`, `src/capabilities/*`, `tests/capabilities-federation.test.ts`
PLANE: OMPSQ-327 — https://app.plane.so/inkwell-finance/browse/OMPSQ-327/

## Goal

Let trusted peers discover capability metadata without sharing tenant runtime state or context by default.

## Approach

- Extend federation seam with capability metadata frames: source id, pack id, version, checksum, title, description, compatibility, trust/provenance, and summary policy. No raw source files or tenant context by default.
- Add local subscribe/import flow: peer-published metadata can be imported as a local source candidate, but install still requires local admin approval.
- Tag every federated capability reference with origin peer/operator and checksum.
- Add allowlist/trust policy for which peers can publish metadata and which orgs can see it.
- Do not add remote execution in this concern.

## Cross-Repo Side Effects

Federation docs should note capability metadata is separate from command steering and leases.

## Verify

`bun test tests/capabilities-federation.test.ts`

The test must prove metadata publish/subscribe excludes raw context/source files, untrusted peers are ignored, imported peer packs still require local approval, and audit records peer provenance.
