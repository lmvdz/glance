# NodeStore — reads that secretly migrate
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: simple
TOUCHES: src/memory/nodes.ts (list() :99, get() :104 both await migrateLegacyAgents :166 — memoized PER INSTANCE), src/squad-manager.ts:1442 (this.nodeStore) + :3741 (a SECOND `new NodeStore(this.store)` inside materialiseColdStart), 11 `new NodeStore` sites repo-wide
MODE: afk

## Goal
Every read pays a promise-await; the first read per instance pays a full store.load(); a
corrupt legacy row turns get() into a throw at the read site. And with two instances over the
same Store the "idempotent" migration can run twice concurrently on cold start (safe only
because putNode happens to be idempotent). Seam: `migrateNodes(store)` run once from the
manager's start() materialiser sequence (~3739/3999), leaving list/get as pure reads —
NodeStore becomes genuinely deep (the interface stops leaking "reads may migrate").
materialiseColdStart takes the manager's existing this.nodeStore, dissolving the double-memo.

## Provenance
Round-3 review, daemon agent items 5 + 8b; carried from round-2's candidate inventory.
