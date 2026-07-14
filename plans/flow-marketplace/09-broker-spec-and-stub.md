# Broker protocol spec + local stub
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: docs/marketplace/broker-spec.md (new), tests/broker-stub.ts (new), src/marketplace/broker-client-types.ts (new)
MODE: afk

## Goal
A versioned, conformance-testable contract the glance client codes against — and a local stub broker so v1
acceptance never requires the production broker to exist. **Write this first; every commerce concern depends on it.**

## Approach
The broker is a **separate program of work** (payments, publisher vetting, fingerprint registry, CRL service).
This plan owns only the *spec* it must satisfy and a stub. Per DESIGN.md, the broker is a **trusted broker that
holds no buyer data** — not "data-neutral" (it holds publisher keys = root of trust, the fingerprint/payload→
licensee registry, CRL+root keys, pack bytes, payments).

The spec MUST mandate:
- **Key separation:** offline root key (publisher-directory attestation + CRL/revocation) ✕ online serving key ✕
  short-lived minting key (L2). An online-key compromise never forges revocations or publisher attestations.
- **Separate trust domain** for the fingerprint registry + payload→licensee map (distinct service/KMS, access-
  audited, not on the catalog/serving path).
- **Transparency log (SHOULD):** append-only Merkle log of manifest hashes + key events; the client verifies
  inclusion proofs when present. Reserve the protocol fields now (open question 4: MUST vs SHOULD).

Client-facing API surface (what the stub implements): publisher directory (keys + vetting status), catalog listing
(signed metadata incl. full signature-covered `preview`), entitlement purchase/issue/verify, entitlement-gated
pack-byte download, epoch-monotonic CRL fetch, L2 mint endpoint, instance-identity registration.

`broker-client-types.ts` is the shared TS contract (request/response shapes, signed-envelope formats). The stub is
an in-process implementation used by every commerce concern's tests — real signatures, real epochs, no network.

## Cross-Repo Side Effects
The broker program (separate) inherits this spec as a binding contract, not a suggestion.

## Verify
- The spec doc enumerates every client-facing endpoint with request/response + signed-envelope schema, and the
  three-key model with which key signs what.
- The stub round-trips: publish → sign → serve → download → verify → entitle → revoke, all with real ES256.
- A conformance test suite runs the client against the stub for each endpoint (the same suite the broker program
  will run against the real service).
