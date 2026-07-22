# ACP spike — feel buzz's layer 1 with the glance fleet behind it
STATUS: open
PRIORITY: p2
REPOS: omp-squad (scratch rig only)
COMPLEXITY: research
TOUCHES: scratchpad rig only; zero product code
MODE: afk

## Goal
Calibrate the room's UX target against the real thing: run buzz's relay + desktop locally, put a
glance-driven agent behind it via buzz-acp (which drives any ACP-speaking agent over stdio
JSON-RPC), and record UX notes — what mention-as-dispatch, branch-as-channel, and card pacing FEEL
like in the app Block dogfoods daily. Time-boxed; findings feed waves 1-3 card/composer polish.

## NON-GOAL (binding)
This is not a relay adoption path and not an integration. The research verdict stands: no Nostr,
no second platform. All spike code is discarded; the deliverable is a notes file in this plan dir
(SPIKE-NOTES.md) with screenshots and a ≤10-line "adopt the feel" list.

## Approach
1. Isolated environment (containerized or scratch dir — respect the scratch-daemon contamination
   scar: never point any agent at the live repo/state).
2. Minimal ACP adapter shim so a buzz @mention prompts a glance-managed agent; if the shim costs
   more than the box allows, downgrade to driving buzz with its own buzz-agent and observing UX
   only — the UX notes are the deliverable, not the bridge.
3. Time box: one day of agent time. Hard stop.

## Cross-Repo Side Effects
None.

## Verify
- SPIKE-NOTES.md exists with the adopt-the-feel list; no product-code diffs; environment torn down.
