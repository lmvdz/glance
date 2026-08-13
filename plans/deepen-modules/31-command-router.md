# applyCommand → CommandRouter — one vocabulary, one dispatch
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/squad-manager.ts 8183–8487 (304 lines: 9 `if (cmd.type === …)` early branches at 8239–8288, then a ~190-line switch at 8292; 40 distinct this. fields; the apology comment at 8285; the silent-no-op postmortem note at 8481), src/schema/client-command.ts (already declares every shape)
MODE: afk

## Goal
The command vocabulary is declared in the schema and dispatched by a hand-written arm per case
in the manager — split across an if-ladder and a switch because "a switch requires the target
to be resident". Seam: `CommandRouter` keyed off the schema's discriminant, each arm
`(rec, cmd, ctx) => …`, with "requires resident target" a per-command declared flag instead of
a positional split. Kills the documented failure mode (switch fall-through silently no-oped a
command) structurally: an unhandled discriminant becomes a compile error.

## Provenance
Round-3 review, daemon agent, new finding 8a.
