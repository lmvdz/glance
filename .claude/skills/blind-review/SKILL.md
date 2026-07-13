---
name: blind-review
description: Run ONE adversarial reviewer over a diff with zero inherited framing — no narrative, no implementer claims, no known-accepted list, no "the fixer says". Use as the last gate before any PR, alongside (never instead of) /code-review and a composition audit. Invoke when a diff is about to ship, when a review cycle has already produced findings (its blind spots are now baked in), or when the orchestrator wrote the fix instructions themselves.
---

# blind-review

A reviewer that inherits your framing inherits your blind spots. This skill runs one
reviewer that inherits nothing.

## Why this exists

On 2026-07-10 a `/plan` execution shipped 15 fail-closed checker fixes through four gates:
per-batch review, a cross-batch composition audit, a 30-agent `/code-review high` (31
candidates, 24 verifiers, 0 refuted), and a native re-verification pass that drove real git
repos. All four passed the diff. A foreign-lineage reviewer (grok-4.5), handed only the two
commits and no story about them, then found:

- `land-risk.ts` returning `undefined` ("genuinely safe") for an **unknowable** blast radius —
  a fail-open the orchestrator's own fix-list had *caused*, by telling the fixer to apply the
  stale-gate's discrimination to a risk gate.
- The transplant probe **permanently parking** a branch on a transient pruned ref.
- `landFailureCount` gated on `!result.retryable`, so retryable refusals had **no bounded
  escalation at all** — the exact shape of an interlock that once swallowed 1,381 of 1,708
  land attempts.

The native re-verifier had scored the same commits SHIP, no-new-defects. It wasn't worse; it
answered the question it was given — *"is the hole closed?"* — while nobody asked *"what did
the fix open?"* And one finding was invisible to every native pass because **the orchestrator's
suppression list named it as a known-accepted minor and told reviewers not to report it.**

A suppression list is a premise. So is "the fixer claims", "per-batch review passed", and a
summary of what the change is supposed to do. Each one narrows the search.

## The protocol

Spawn exactly one agent. Give it:

- the repo path and the diff command (`git show <sha>`, or `git diff <base>..HEAD`)
- the invariants the *system* must hold, stated as properties, not as a description of the change
- an explicit adversarial mandate

Give it **none** of:

- what the change is trying to do, or the plan/concern/design docs
- what previous reviewers found, passed, or accepted
- any "known-accepted" / "do not re-report" list
- the implementer's or fixer's report
- the orchestrator's fix instructions (these are the likeliest source of the defect)

Prefer a **foreign lineage** (grok-4.5 or gpt-5.6 — see the model policy) precisely because it
cannot have read the conversation. When that isn't available, a native agent still works: what
matters is the empty prompt, not the vendor. Never reuse an agent that already reviewed this
diff — its context is the contamination.

## Prompt shape

```
Adversarially review <diff command> in <repo>. <One sentence: what the system IS —
"a daemon that autonomously merges agent-written code to main" — never what the diff does.>

Hunt, with file:line evidence and a concrete failure scenario each:
1. Any NEW fail-open: a gate that now allows where it should block.
2. Any NEW permanent wedge: a refusal that can never clear on retry and never escalates.
3. <Domain semantics the diff reasons about — e.g. "these fixes read git exit codes;
   are those readings correct? is there a repo state where the discrimination is wrong?">
4. Can a legitimate case now be falsely refused? Can the bad case still slip through?
5. TOCTOU between a check and the action it guards.

Rank by severity. A finding is a hypothesis — state your confidence and the exact evidence.
If a claimed fix is actually correct, say so explicitly rather than inventing a problem.
```

That last line matters. Without it a blind reviewer under-primed on context will manufacture
findings to look useful. With it, grok explicitly certified five fixes as correct and produced
a git-semantics truth table — which is what made its three real findings credible.

## Rules

- **One agent, one pass.** This is a cheap gate (~1 agent) bolted to the end of an expensive
  one. If it finds nothing, that is a real signal, not a wasted call.
- **Ask what the change opened, not whether it closed.** A fix is a new gate. New gates deserve
  the scrutiny of the hole they replace. Over-correction wedges a factory as surely as a
  fail-open ships bad code.
- **Adjudicate, never tally.** When the blind pass and a briefed pass disagree, read the code and
  decide. Do not average, and do not defer to the reviewer that saw more context — that reviewer
  saw more *framing*. Both times these two disagreed, the blind one was right.
- **Findings are hypotheses.** Confirm each against the code before acting; grok's own review
  correctly refuted an obvious "the escalation lane is a black hole" worry that a briefed
  reviewer had raised.

## Where it belongs

Last gate before a PR, after `/code-review` and any composition audit — late enough that the
other passes' blind spots exist to be caught, early enough to fix before shipping. In
`/execute-plan` it is part of Phase 3's audit gauntlet, run in parallel with the others.
