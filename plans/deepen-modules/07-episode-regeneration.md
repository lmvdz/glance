# Episodes — regenerated projections, not accreted logs
STATUS: in-progress
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/memory/weekly-episode.ts (episodeExists :339 blocks rebuild; EpisodeLoop :446–529), src/squad-manager.ts gatherEpisodeInputs (5241–5295)
MODE: afk

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

## DESIGN (2026-08-04, iteration 15 — red-teamed below)

**Episodes are Layer-2 projections over durable exhaust — regeneration loses nothing
unrecoverable, by construction.** Every input (receipts, digests, symptoms, answers, decisions)
persists independently; the episode is a derived view. That is POSITION.md's own definition of
recoverable compaction, and it is what makes this design safe to ship at all.

**1. The gather moves in.** `gatherEpisodeInputs` (~55 lines in squad-manager) becomes the
module's own gather over an `EpisodeSources` port (thunks: receipts/digests/symptoms/answers/
decisions readers — the fabric-deps pattern, already proven in FabricDeps). `EpisodeLoop`'s
6-callback interface collapses to `{ sources, onBuilt }` — the shallow timer dissolves into
the deep module.

**2. Regeneration trigger: input fingerprint, not a timer decision.** The `.json` sidecar
gains `sourceFingerprint`: counts + max-timestamp per input class for the episode's ISO week.
Each loop tick recomputes the fingerprint for recent weeks (current + previous); differs ⇒
rebuild and overwrite the pair. `episodeExists` (write-once) retires. Late-arriving exhaust —
the common case the write-once design silently dropped — regenerates the week it belongs to.

**3. The verbatim gate is EMPTY today, and that is the design.** POSITION.md gates regeneration
against a declared must-survive-verbatim list. Nothing human-authored lives inside an episode
file today (episodes are fully machine-derived; operator annotations do not exist as a
feature). Therefore v1's verbatim set is the empty set — regeneration is unconditionally safe —
and the module REFUSES to regenerate any file whose content hash differs from its sidecar's
`builtHash` (evidence of out-of-band editing): a hand-edited episode is treated as
human-authored verbatim content and left untouched, loudly logged. The gate mechanism ships
with the feature; its list grows the day annotations do.

**4. History: the previous build is kept as `<week>.prev.md` (one generation).** Not for
recoverability (the exhaust provides that) but for OPERATOR DIFF LEGIBILITY — "what changed in
this week's story" is itself a teaching signal, and a silently morphing document is the exact
comprehension failure this lane exists to prevent.

## DESIGN v2 amendments (red-team round, 2026-08-04 — codex 5 + grok 3 survived; both
reviewers' leading findings were lost to output truncation and are NOT recorded)

1. **Fingerprint must catch equal-count mutation:** counts + max-ts + a stable hash of the
   input ID SET per class. Deletion/rotation lowers counts (caught); same-count same-max-ts
   substitution changes the ID-set hash (caught).
2. **Snapshot coherence + pair atomicity (codex):** gather ONE snapshot; fingerprint and
   episode both derive from it; the pair publishes md-then-sidecar with the sidecar carrying
   builtHash of the exact md written — readers validate hash and retry once on mismatch.
3. **Hand-edit = explicit QUARANTINE state (codex):** on builtHash mismatch the sidecar is
   rewritten with `editedAt` + `quarantined: true` (its stale excerpt/fingerprint removed);
   fabric skips quarantined episodes; the loop logs once. Never a silently-lying pair.
4. **Failed gathers are not drift (codex):** EpisodeSources readers return
   `{ ok: true, items } | { ok: false }` — any not-ok class aborts the rebuild for that week,
   keeping the healthy projection. Authoritative-empty is `ok:true, items:[]`.
5. **Live-state inputs are excluded from the evidence claim (grok):** staleAnswers/fog-like
   annotations are computed AT BUILD and stamped `asOfBuild` — they are commentary, not
   exhaust; the fingerprint covers durable inputs only. "Loses nothing by construction" is
   claimed ONLY for the durable classes.
6. **.prev rotation:** rotate only when builtHash actually changes, under the loop's
   single-writer discipline (one EpisodeLoop per manager stateDir — assumption documented);
   rapid same-week rebuilds collapse .prev to the last DIFFERENT generation, not each
   intermediate.
7. **episodeExists retirement is an interface change (codex+grok):** barrel export removed
   deliberately (allowlist/tests updated in the same commit); pre-fingerprint legacy pairs
   regenerate once and get stamped (migration is one rebuild, not thrash).
8. **Reference-not-restate (grok, out of scope, named):** episodes still quote atoms rather
   than reference them; that is POSITION Layer-2 rule 2 debt, tracked as its own future
   concern rather than smuggled into this one.

## Implementation slice (after red-team): per DESIGN v2 — EpisodeSources ok-typed port +
gather move + snapshot-coherent fingerprint (ID-set hash) + quarantine state + .prev
rotate-on-change + barrel/test updates + legacy one-shot migration; EpisodeLoop dissolves.
