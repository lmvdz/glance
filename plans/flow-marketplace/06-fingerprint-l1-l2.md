# Fingerprint L1 provenance + L2 ledger/marker (honest)
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01, 03, 09
TOUCHES: src/marketplace/fingerprint.ts (new), src/marketplace/pack-signing.ts, docs/marketplace/broker-spec.md, tests/fingerprint.test.ts (new)
MODE: afk

## Goal
The seller's forensic backbone — provenance lineage (L1) and per-licensee traceability (L2) — built honestly,
with the watermark labeled for what it is and no tracing claim it can't back.

## Approach
- **L1 (provenance lineage):** publisher identity, signed version chain, full-raw-byte content hashes (rides
  concern 01's signing). Cheap, robust. The client verifies lineage at import.
- **L2 (per-licensee, re-founded honestly):** the **durable** signal is the broker's **purchase ledger** —
  `payload-hash → licensee` recorded at mint — plus L1 exact/near-copy matching. The embedded watermark
  (variation in behavior-inert degrees of freedom: DOT node ids/comments, profile/skill naming, branch ordering)
  is **labeled "best-effort forensic marker"** — near-zero carrier capacity in NL-prompt / DOT-graph content, dies
  to a formatter or LLM rewrite. **No collusion-resistance / Boneh–Shaw tracing claim anywhere** (the carrier
  can't hold it, per the memo's own honest limit).
- **Mint mechanics (fix the hot-key defect):** preserve the **publisher's signature over the base manifest F** and
  ship it alongside; the broker signs only a small **mint record** (base-hash, licensee, watermark delta) with a
  **separate short-lived minting key**. The buyer verifies publisher-sig-over-base + broker-sig-over-mint-record;
  the offline root/CRL key is never a hot per-purchase signer. Minting compute lives broker-side (spec 09); this
  concern builds the client-side verification + the spec for the mint record.

L3 (behavioral fingerprint + publish-time originality gate) is explicitly deferred to v2 — nothing in v1 depends
on it, and a half-built originality gate that reads "passed" while barely checking is worse than an honest "not
yet."

## Cross-Repo Side Effects
The broker runs the minting + holds the fingerprint registry/ledger in a separate trust domain (spec 09).

## Verify
- L1 lineage verifies; a version chain with a broken link is rejected.
- L2: a licensed copy `F_B` verifies as publisher-sig-over-`F` + broker-sig-over-mint-record; the base publisher
  signature is intact and independently verifiable (not replaced by a broker re-sign).
- The watermark is labeled "best-effort forensic marker" in the API/docs (grep: no "collusion-resistant" or
  "traitor-tracing-guaranteed" wording); the ledger is named the durable signal.
