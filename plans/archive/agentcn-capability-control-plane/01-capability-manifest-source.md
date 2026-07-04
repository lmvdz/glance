# Capability manifest and source ingestion
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: `src/capabilities/*`, `src/types.ts`, `tests/capabilities-manifest.test.ts`
PLANE: OMPSQ-321 — https://app.plane.so/inkwell-finance/browse/OMPSQ-321/

## Goal

Define the normalized agentcn-style capability manifest contract and ingest trusted registry sources into checksum-pinned pack records.

## Approach

- Add `src/capabilities/schema.ts` with named types for `CapabilitySource`, `CapabilityPack`, `CapabilityFile`, profile/workflow/tool/skill specs, preview metadata, compatibility, and context declarations.
- Add parser/validator for shadcn registry item JSON and agentcn-style manifests.
- Compute stable identity: `sourceId + framework + slug + version + checksum`.
- Preserve raw source content separately from normalized metadata.
- Validation must fail closed for unknown executable/runtime fields; display-only unknown metadata can be preserved under `extra` if needed.
- Add fixtures modeled after agentcn `/r/flue/deep-search.json` and malformed manifests.

## Cross-Repo Side Effects

None.

## Verify

`bun test tests/capabilities-manifest.test.ts`

The test must prove valid fixtures normalize deterministically, checksums change with file content, unsupported runtime declarations fail, and display metadata survives round-trip.
