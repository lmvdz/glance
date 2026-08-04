# Episodes — regenerated projections, not accreted logs
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/memory/weekly-episode.ts (episodeExists :339 blocks rebuild; EpisodeLoop :446–529), src/squad-manager.ts gatherEpisodeInputs (5241–5295)
MODE: needs-design

## Goal
Two defects against POSITION.md Layer 2 rule 1 ("regenerate, never append"): episodes are
write-once (`episodeExists` prevents rebuild — an ACCRETED projection), and the gathering
knowledge lives outside the module (gatherEpisodeInputs stranded in squad-manager while
EpisodeLoop is a shallow timer with a 6-callback interface). Deepen: the episodes module owns
gather + build + save behind one interface; regeneration becomes the contract, gated by the
must-survive-verbatim field list the position paper already specifies.

## Why needs-design
The regeneration gate (what must survive verbatim, when regeneration triggers) needs a design
round before code — flagged Speculative in the review for exactly this reason.
