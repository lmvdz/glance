# hub-shell — t3code's two-pane thread client as the DEFAULT shell

STATUS: open
PRIORITY: p0
REPOS: glance-desktop (primary); omp-squad daemon (H7 companion fields)

## Why
Lars compared the app to t3code twice ("doesn't look or feel like it at all"). Root cause: the
t3-face program (concerns 01–13) reskinned WITHIN terax's IDE frame. t3code is a thread client with
NO visible file tree/editor/terminal. Decision (Lars, 2026-07-18): "Full t3 client" — the app boots
into a two-pane [projects→threads rail | conversation + hub composer]; terax's IDE is demoted to an
on-demand mode. See DIRECTION.md (terax = substrate, not chrome).

## The encouraging ground truth (from a fable Plan pass over the live code)
- The fleet surface is ALREADY the right two-pane shape (`spine/FleetLayout.tsx`) — it's just mounted
  inside a `fleet`-kind TAB in terax's frame. The fix is a frame swap, not a rebuild.
- The transcript ALREADY folds turns; the raw `bash {"command":…}` blob Lars saw is ONE component
  (`timeline/TimelineRowView.tsx` ToolLine doing `JSON.stringify(args)`). Fixable in isolation.
- The rail already groups project→daemon→rows and classifies console threads; what's missing is t3's
  calmer grammar (search top, settings bottom, one dot + relative time), projects that outlive units,
  and real thread titles (daemon names every console unit "chat").
- Cost/token for the composer ring already ride the roster (`receipt`, `contextPct`). Model/effort/
  access do NOT — daemon gaps (H7).
- The IDE-as-mode door already exists (`worktreeOpener` C06 → opens a Space).

## Concerns
| # | Title | Size | Parallel? | Trust/taste |
|---|---|---|---|---|
| H0 | hub-shell root: two stacked shells, hub default | M | SERIALIZED (the root) | taste: cold-boot first frame |
| H1 | projects→threads rail (search/settings/calm rows) | M | parallel | taste: row density |
| H2 | conversational tool rendering (kill the JSON blob) | S | parallel | taste: read a thread |
| H3 | "Changed files" card as a first-class turn | M | parallel | taste: the card |
| H4 | hub composer + thread top bar | M | parallel | taste: composer footer |
| H5 | IDE-as-mode: entries/exits/what-survives | S | after H0 | — |
| H6 | upstream-rebase ledger + drift script (Epic M) | S | after H0 | — |
| H7 | daemon gaps (omp-squad): thread title, lastActivity, projects, model/effort/access, land, per-turn diff | — | anytime | — |

## Order & the milestone
H0 first and alone (everything rebases onto its App.tsx). H1/H2/H3/H4 in parallel worktrees
(fleet-module-local; mergeable even in the old frame meanwhile). H5/H6 after H0. **Recommended
milestone: H0+H2 — the two-pane frame + a readable conversation moves the needle most per line.**
H2/H3 are safe to land first for immediate feel improvement.

## What Lars reviews (taste-critical live surfaces)
Cold-boot first frame (H0), rail rows (H1), one full thread read-through (H2), the Changed-files
card (H3), the composer footer + cost ring (H4).

## Reuse (nothing is rebuilt)
FleetLayout → hub body; ThreadSpine/SpineRow → rail (calmer); IntervenePane → conversation pane
(header→top bar, diff→card); ConversationView/timeline → reading surface (ToolLine re-presented);
ComposerShell → hub composer; diffs/* → inside the card; worktreeOpener → the hub↔IDE door;
FleetPane/FleetStack → deleted. Genuinely new: HubShell + shellModeStore, rail chrome, toolPresenter,
ChangedFilesCard, hub composer controls + cost ring.

## Provenance
Designed 2026-07-18 by a fable Plan pass over App.tsx, WorkspaceSurface, useTabs, the fleet module
(spine/timeline/diffs/composer), the ai module, worktreeOpener, fleetClient/roster. Reuses R2
components re-parented. Companion HTML review digest published for Lars.
