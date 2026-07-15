# Output-compaction product contract

The maintainer checklist for `src/output-reduce.ts` and its call sites (pattern borrowed from
noisegate's `docs/product-contract.md`; design record: `plans/noisegate-compaction/DESIGN.md`,
research provenance: `plans/research-noisegate/BRIEF.md`). Compaction exists to improve context
value, not to make output shorter at any cost. A change that cannot satisfy this checklist stays
out of the reducer or documents its deliberate boundary here first.

## 1. Exactly four classes

- [ ] The class list is `test`, `diagnostics`, `install`, `generic` — adding a fifth requires
      updating THIS DOC first, with the preservation table written from captured real output
      (never hand-imagined regexes; see the bun ANSI/plain fixtures in `tests/output-reduce.test.ts`).
- [ ] Unknown or unclassifiable output falls through to `generic` (head/tail) — classification
      failure fails CLOSED to the least-clever behavior, never to a guessed class.
- [ ] The CRITICAL tier (unioned into every class) is the misclassification safety net: a wrong
      class degrades to "kept slightly more", never to "lost the failure line".

## 2. The budget is a hard cap

- [ ] `classifyAndReduce`/`reduceOutput` return text ≤ the caller's budget on EVERY path — fit,
      reduced, no-gain, zero-priority-match, and exception all land on bounded output. Noisegate's
      "no-gain → return the original" is deliberately NOT adopted: every glance call site enforces
      a hard cap (prompt slots, checkpoint fields, detail strings).
- [ ] Fail-open means degrading to `headTail` (bounded), never returning unbounded text, and never
      throwing — a throw on the land path fails-CLOSED a land.
- [ ] Marker overhead (`[N lines omitted]`, the offload pointer) is counted inside the budget,
      never appended on top of it.

## 3. Protected surfaces — never wire the reducer into these

- [ ] `budgetedExcerpt`'s judge-prompt call sites (`validator.ts`, `land.ts` `excerptForDetail`,
      `land-pr.ts`) — changing what land judges see is its own reviewed change, never a drive-by.
- [ ] Diffs — `kind:"diff"`'s whole-hunk packing owns them; line-ranked reduction of a diff shows
      phantom deletions to a regression-hunting lens.
- [ ] `fenceUntrusted` bodies, fabric-search/KB snippets, digest content, authored specs.
- [ ] Transcript tool payloads (`upsertToolEntry`), voice `truncateForVoice`, `answers.ts` bodies,
      `reflection.ts`'s own output slice.
- [ ] Prose fields (rationales, claims, agent `lastText`) use plain `truncate`/`headTail` — shape
      classification on prose mangles quoted error text.

## 4. Markers are forgeable — treat them as claims, not proof

- [ ] Gate output is unit-authored text on a prompt channel: input lines matching the omission/
      pointer grammar are neutralized (`> ` prefix) before reconstruction, and the steer injection
      is fenced (`fenceUntrusted`), so a forged `[N bytes omitted — full: /etc/passwd]` can never
      pose as a reducer-generated pointer.
- [ ] Any tool or UI that FOLLOWS a pointer path must validate it resolves under `gateLogRoot`
      before reading.

## 5. Redaction at persistence boundaries only

- [ ] `writeGateLog` and the checkpoint's `lastOutput`/`lastText` fields persist `redact()`ed text;
      the gate-log's "full" file is lossless EXCEPT secret-shaped substrings.
- [ ] Excerpts returned to prompts/judges are built from unredacted input — excerpt-side redaction
      changes judge evidence and requires its own reviewed change gated on the corpus test
      (`tests/redact.test.ts` proves zero false positives over `src/**` + `tests/**`).
- [ ] `redact()` patterns stay same-line and bounded-span (the O(n²) BEGIN-bomb and the
      newline-crossing bearer eat were both measured, real defects — see DESIGN.md).

## 6. Every decision is auditable

- [ ] Every non-`fit` decision (reduced / headtail-fallback / error) is appended to
      `compaction.jsonl` with `class`, `classes`, `reason`, `originalChars`, `charsSaved`,
      `preservedLines`, and the offload `path` when one exists — `preservedLines: 0` on a
      classified input is the "flagship class silently degraded" alarm.
- [ ] `compaction.jsonl` is bounded recent-history diagnostics (ring + rotation), NOT a forensic
      archive — the gate-log files are the durable record.
- [ ] The log root follows the org state dir (`setCompactionLogRoot`, called beside
      `setGateLogRoot`) — never resolved at module scope.
- [ ] Honesty: the compaction log root is last-writer-wins across managers in one process — exact
      parity with `setGateLogRoot`/`setProofRoot` today, not a regression specific to this module. A
      multi-org process (multiple `SquadManager`s sharing one Node/Bun process) commingles decision
      records into whichever org's root was set most recently; there is no per-call org tag that
      routes a record back to its own org's log. This is a known seam, not a silent one — the fix
      belongs alongside the gate-log/proof-root fix as one shared change, not patched here in
      isolation.

## 7. Identity surfaces stay pointer-free

- [ ] Anything that compares or hashes output across runs to detect "same failure again"
      (`noProgressRoute`, reflexion refutation) goes through `identityNormalize` — offload pointers
      carry a fresh ts+nonce per write and would otherwise defeat the comparison on every visit.

## 8. Determinism

- [ ] No LLM summarization, ever. No semantic memory writes. Same input + same budget ⇒ same
      output (modulo the offload pointer's ts+nonce).
