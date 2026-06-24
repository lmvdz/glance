# Command palette + keyboard navigation
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/palette/*, webapp/src/hooks/*

## Goal
Keyboard-first operation (the HumanLayer/Superhuman feel): a Cmd-K palette for every action and
jump-to target, plus per-agent slash commands and list keyboard nav.

## Approach
- `CommandPalette` (Dialog) with a small fuzzy filter (ponytail: a ~20-line subsequence matcher, no
  dep). Entries: jump to agent / feature / view; global actions (spawn, answer-next-blocked, toggle
  theme); when an agent is open, its **slash commands** from the `commands` event (`CommandInfo`
  `types.ts:427`) → selecting sends `{type:"prompt", message:"/" + name}`.
- Hotkeys: `Cmd/Ctrl-K` open; `j`/`k` move selection in lists; `Enter` open; `n` jump to next blocked
  agent (pairs with the Inbox). Keep handlers scoped so typing in fields isn't hijacked.

## Cross-Repo Side Effects
None. Reads the view router (concern 02) + `useSquad` actions.

## Verify
- `Cmd-K` opens; typing filters fuzzily; selecting a target navigates or fires the action.
- With an agent open, its slash commands appear and send as a prompt.
- `n` jumps to the next `input`/`error` agent.
