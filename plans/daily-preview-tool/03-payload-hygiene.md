# Preview snapshot payload hygiene

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: concern 01's handler (tool result shape), state-dir artifact storage, transcript JSONL append path
BLOCKED_BY: 01

## Goal

A screenshot of a preview under test can contain rendered secrets (an API key printed on a debug page, a session token in a URL bar mock, PII in seed data) and can be arbitrarily large (a full-page capture of a long page). Two hygiene requirements, both because a host-tool response flows into TWO places that both persist and both feed model context: it goes back to the calling agent (into its live context window) AND it gets appended to the persisted transcript JSONL (every tool call/response is logged, the same way `onHostTool`'s `pending`/`system` entries already are — see `truncate(JSON.stringify(call.arguments ?? {}), 200)` at the existing tool-call log line, `squad-manager.ts` `onHostTool`). A base64 PNG in either path is both a context-budget problem and a durable-secrets-at-rest problem.

## Approach

**Caps on the captured image.** Bound both dimensions and byte size of whatever `agent-browser screenshot` produces before it goes anywhere: cap viewport/capture dimensions at call time (pass explicit viewport bounds to `agent-browser` rather than trusting the target page's natural size — `agent-browser set viewport <w> <h>` exists per its `--help` output) and re-check the resulting file's byte size after capture, rejecting (not silently truncating — silent truncation of image bytes produces a corrupt, misleading PNG) anything over the cap with a clear error back to the calling agent.

**File reference, not base64, in both the tool response and the transcript.** Save the PNG to a state-dir artifact path (same directory class the vision pass already writes screenshots to under a vision-run dir, `src/vision.ts`'s `collect()`/`dir` parameter) and return a REFERENCE (path, or a served URL if the daemon already serves state-dir artifacts for the webapp) in the tool result — never the base64-encoded bytes. This keeps the payload that flows into the agent's context window and into the persisted transcript JSONL small and stable regardless of image size, and means a screenshot containing a rendered secret sits in one file at a known path (subject to the daemon's existing state-dir access controls) rather than being duplicated into a JSONL log line that gets read, grepped, and potentially exported/shared far more casually than a single artifact file.

**Redaction note in the tool description itself.** `HostToolDef.description` is what the calling agent reads before deciding to call the tool — add an explicit line: screenshots of an app under test may capture rendered secrets, API keys, or PII if the target page displays them; the calling agent should avoid navigating to pages known to render sensitive data, and should treat the returned artifact as potentially sensitive when deciding what to do with it (e.g. don't paste its contents into an unrelated report). This is documentation-as-mitigation, matching the codebase's existing pattern of putting trust-boundary reasoning directly in the description/docstring the consumer reads (e.g. `KB_SEARCH_TOOL`'s description already says "scoped to what you may see").

## Cross-Repo Side Effects

None — omp-squad only. If the webapp ever renders these artifacts (out of scope for this epic, per 00-overview.md), it would need to fetch by the same reference path this concern establishes — noted for whoever builds that later, not built here.

## Verify

- Unit: a synthetic oversized capture (mock `agent-browser` output exceeding the byte/dimension cap) is rejected with a clear error, not silently truncated into a corrupt image.
- Unit: the tool result object contains a file-reference field and NEVER a base64/binary field, for both success and (capped) near-limit cases.
- Unit: grep the transcript JSONL append path for this tool call — confirm the appended entry's size is bounded (reference-sized, not image-sized) regardless of the underlying PNG's dimensions.
- Live (scratch-daemon): call `preview_snapshot` against a real registered origin (concern 02), confirm the artifact lands on disk at the expected state-dir path, the tool response references it by path, and the calling agent's transcript entry for the call stays small.
