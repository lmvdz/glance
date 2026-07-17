# Transcript tool-result cap + offload (deferred to fleet-ide-cockpit)
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts (upsertToolEntry ~6132-6159), src/transcript-delta.ts, webapp cockpit
MODE: hitl

## Goal
Raw `args`/`partial`/`result` objects on TranscriptEntry.tool are stored uncapped (memory, state.json, transcript-delta payloads polled by cockpit/voice). Cap per-entry with recovery-not-archive offload + pointer.

## Approach
DEFERRED — BRIEF concept 3 (plans/research-noisegate/BRIEF.md). Needs "show full output" recovery UX (endpoint + GC + cockpit surface), so it belongs sequenced inside plans/fleet-ide-cockpit where that UX gets designed once, not bolted on here. MODE hitl: Lars decides where it slots into the cockpit plan.

## Cross-Repo Side Effects
Transcript DTO shape change → webapp consumers.

## Verify
n/a until claimed inside the cockpit plan.
