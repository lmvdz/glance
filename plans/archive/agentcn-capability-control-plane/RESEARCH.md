# Research: agentcn

Source: `agent://AgentcnResearch` plus primary docs at `https://github.com/shadcn-labs/agentcn`, `https://www.agentcn.run/llms.txt`, and `https://www.agentcn.run/llms-full.txt`.

## Facts

- agentcn is a MIT TypeScript/Next/Fumadocs registry site for complete AI agent recipes.
- Recipes are source bundles installed through the shadcn registry format.
- Recipes target Eve and Flue runtimes; agentcn is not itself a runtime.
- Registry build reads `registry/<framework>/<slug>/registry.json`, inlines file contents, emits `/r/<framework>/<name>.json`, and publishes `/r/registry.json`.
- Recipe bundles include agent code, instructions, tools, skills, workflows, dependencies, docs, and preview metadata.
- Docs expose `llms.txt`, `llms-full.txt`, OpenAPI/API catalog, well-known agent skills, and live previews.
- Live preview emits typed events such as tool calls/results, text deltas, artifacts, done, and error.

## Patterns to use

- Source-owned recipe packs, not opaque runtime dependencies.
- Registry manifest as the durable contract.
- Manifest-driven install UI and command copy UX.
- Typed operational events and artifact tabs for previews/runs.
- Machine-readable discovery endpoints for agent clients.

## Decision

Use agentcn as a production pattern, not as an app dependency. `omp-squad` needs a control-plane-native capability registry because tenancy, federation, runtime execution, context sharing, and audit must bind to existing manager/org boundaries.
