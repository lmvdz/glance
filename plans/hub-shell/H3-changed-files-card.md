# "Changed files" card as a first-class turn

STATUS: open
PARENT: hub-shell

ChangedFilesCard: header 'Changed files (N) · +x/−y' (aggregate from parseDiff hunks), nested file tree, per-file diffstat, Collapse all / View diff (expands existing DiffFile inline, split/unified preserved). Renders IN the conversation flow after the latest settled turn with a subtle timestamp; replaces IntervenePane's buried Changes collapsible. Keep quote-lines→composer steer draft. Data: client.diff(unit.id) (whole-worktree; per-turn attribution = H7 gap). TOUCHES: new diffs/ChangedFilesCard.tsx + fileTree.ts(+tests), diffs/parseDiff.ts (expose counts), IntervenePane.tsx, ConversationView.tsx. SIZE M. Reuses DiffFile/DiffViewToggle/parseUnifiedDiff. VERIFY: parse/tree tests; scratch daemon multi-file unit. Taste-critical (the card is the centerpiece of the reference).
