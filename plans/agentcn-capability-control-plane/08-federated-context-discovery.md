# Federated context sharing and discovery surfaces
STATUS: closed
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: `src/context/*`, `src/fabric*`, `src/server.ts`, `src/capabilities/*`, `docs/*`, `tests/capabilities-context.test.ts`

## Goal

Enable approved capability workflows to publish/consume bounded context across tenants/federated peers, and expose machine-readable discovery for agents.

## Approach

- Add `CapabilityContextPolicy`: namespaces, import scopes, export scopes, redaction profile, retention, allowed peers/orgs, audit mode.
- Context channel identity includes org id, install id, workflow id, pack id, version, checksum, and provenance.
- Integrate with existing context/fabric surfaces so outputs are distilled facts/artifacts, not raw private transcripts by default.
- Add `/llms.txt`, `/openapi.json`, and well-known capability catalog/discovery routes describing supported APIs and installed public metadata.
- UI shows context policy before enablement and per-run context exports afterward.
- Keep default deny: no federated context egress unless policy explicitly allows it.

## Cross-Repo Side Effects

Docs must explain context retention and redaction guarantees before this ships.

## Verify

`bun test tests/capabilities-context.test.ts`

The test must prove context exports are denied by default, redaction runs before federation, namespace boundaries include org/install/version, and discovery endpoints never expose private tenant data.
