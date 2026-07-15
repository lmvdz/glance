# Design: deterministic signal-preserving output compaction

Borrowed patterns from noisegate (see `plans/research-noisegate/BRIEF.md`). Adversarial design: 1 designer draft, 2 red-team passes (contracts lens + security/drift lens), arbitrated 2026-07-15.

## Approach

A new pure-sync reducer core (`src/output-reduce.ts`) with an async offload wrapper, consumed at the verify-loop steer path, checkpoint persistence, and land detail strings. The existing `gate-logs.ts` offload/pointer machinery is reused, not duplicated; `budgetedExcerpt`'s six judge-prompt call sites are deliberately untouched. Redaction happens at persistence boundaries only, after hardening `redact.ts`'s patterns.

## Key decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Module shape | New `output-reduce.ts`: sync core + async wrapper reusing `writeGateLog` | Extend `budgetedExcerpt` with a new kind; standalone store | Keeps judge-prompt primitive frozen (blast radius), reuses proven offload, sync core lets checkpoint path avoid I/O |
| Budget contract | Output ≤ budget by construction; marker cost counted during fill; no-gain → headTail fallback, never return-original | Noisegate's return-original no-gain | Every converted call site enforces a hard cap; returning over-budget originals violates their whole contract (red team, both lenses) |
| ANSI + patterns | stripAnsi step 0; preserve patterns written from captured real bun 1.3.14 output; fixtures with ANSI included | Hand-written FAIL/✗ regexes | Measured: bun colorizes even piped (FORCE_COLOR in env), colorless mode prints `(fail)` — draft regexes matched nothing real |
| Misclassification | Global CRITICAL tier unioned into every class; compound commands union all matched classes | Single-class winner-takes-all | `tsc && bun test` classified "test" would drop `error TS` lines; union degrades to keeping more, never losing the failure |
| Identity safety | `identityNormalize()` (strip pointer lines, `[N.NNms]` timings, ANSI) used by `noProgressRoute` + reflexion `hashOutput` | Pointer-free lastOutput; strip at one site only | Unique ts+nonce pointer would make identical failures hash differently — kills the no-progress and refutation detectors silently |
| Redaction | Persistence boundaries only (`writeGateLog`, checkpoint fields), after hardening `redact.ts` (same-line bearer, bounded private-key window) | Redact-first in `budgetedExcerpt` and the reducer | Measured 47 false-positive lines on this repo's own source + newline-crossing eats = judge-evidence corruption; O(n²) private-key pattern = unit-controlled DoS |
| Diagnostics | `CompactionDecision` (+`preservedLines`) to a lazy `JsonlLog` with `setCompactionLogRoot()` mirroring `setGateLogRoot` | Module-scope log at `resolveStateDir()`; AutomationRecorder | Module-scope freezes the wrong root in multi-tenant DB mode; AutomationEvent is loop-bound |
| Budget headroom | Executor reduces body at 3800 (< MAX_CONTEXT_OUTPUT 4000) so text+pointer+prefix ≤ checkpoint's 4096 | Reduce at 4000 | Post-fix output would be ≥ ~4110 → guaranteed re-reduction at checkpoint that can amputate the pointer |
| Marker integrity | Marker/pointer grammars are top-tier preserve patterns; forged marker lines in input neutralized; steer injection wrapped in `fenceUntrusted` | Trust input text | Gate output is unit-authored; forgeable `[N bytes omitted — full: /etc/passwd]` misdirects operators; fencing matches the adjacent reflection-note discipline |

## Risks

- Preservation tables rot as tool output formats change — mitigated by real-output fixtures, the CRITICAL tier safety net, and generic headTail degradation; contract doc caps classes at four.
- Steer-prompt shape changes (fence + markers) alter what fixup agents see — flagged for blind review; strictly more signal than today's head-cut.
- `land.ts:652` green path now offloads full suite output per land — accepted (TTL-swept, forensically useful); test pins pointer survival through proof-detail cap.
- Decision log is bounded recent-history (ring + rotation), not a forensic archive — stated in contract doc.

## Red team concerns addressed

| Concern | Severity | Resolution |
|---|---|---|
| Marker cost uncounted / no-gain returns over-budget original (RT1-1, RT2-4) | critical | Marker-aware fill; headTail fallback; ≤-budget asserted in tests |
| Regexes miss real bun output in both color modes (RT1-2, RT2-3) | critical | stripAnsi step 0; patterns from captured output; `preservedLines` in decision log |
| Module-scope log wrong-rooted in DB mode (RT1-3) | critical | Lazy singleton + `setCompactionLogRoot` beside `setGateLogRoot` |
| Pointer nonce poisons identity detectors (RT2-1) | critical | `identityNormalize` at both consumers + two-identical-oversized-failures test |
| redact-first corrupts judge evidence; O(n²) DoS (RT2-2, RT2-5) | critical | No excerpt-side redaction; harden patterns (same-line, bounded window); corpus + perf regression tests |
| Double-reduction amputates pointer (RT1-4, RT2-9) | significant | 3800 headroom; pointer grammar top-tier preserve; lastText → headTail only |
| Async wrapper throw fails-closed a land (RT1-5) | significant | Wrapper never throws; degrades to core text, best-effort logging |
| Tier ordering dead spec (RT1-6) | significant | Fill tiers ascending, doc-order within tier; summary-vs-frames test |
| Compound-command misclassification (RT2-6) | significant | Class union + CRITICAL tier |
| Marker forgery on unfenced channel (RT2-7) | significant | Input marker neutralization; fenceUntrusted steer; contract requires pointer-path validation under gateLogRoot |
| Under-declared test breakage (RT2-8) | significant | checkpoint-log test rewrite in scope; land test audit; land-ledger 600-cap explicitly untouched |
| Accounting inconsistencies (RT1-7) | minor | originalChars = caller input; charsSaved recomputed on final text |
| Sync-core decisions unlogged (RT1-8) | minor | Core logs (sync fire-and-forget append); wrapper enriches with path |
| Ring is recent-history not audit (RT1-9) | minor | Contract wording + raised maxBytes |

## Open questions

None — all red-team criticals resolved by design changes above.
