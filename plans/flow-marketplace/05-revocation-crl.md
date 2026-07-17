# Reason-typed revocation — fail-closed security, monotonic epoch
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 03, 09
TOUCHES: src/marketplace/revocation.ts (new), src/capabilities/index.ts, src/squad-manager.ts (run gate), tests/revocation.test.ts (new)
MODE: afk

## Goal
A pack pulled because it exfiltrates data stops running — even on an instance that hasn't polled recently — and a
root buyer can't roll back the revocation list to un-revoke it.

## Approach
A CRL client, fixing the draft's fail-open-on-stale (the "absence of evidence" pattern this repo keeps punishing):
- **Reason-typed revocations.** `reason: security` ⇒ **fail closed**: blocked the moment the revocation syncs; an
  instance whose CRL is staler than a bounded budget (default 72h, operator-**tightenable**, never loosenable past
  7 days) refuses to *run* marketplace-sourced packs until it refreshes (install state untouched — execution
  gated). `reason: license/commercial` ⇒ warn-and-continue (cooperative — blocking buys nothing against root and
  punishes honest offline use).
- **Monotonic signed epoch.** Every CRL carries a signed, strictly increasing epoch; the client persists the
  high-water mark and **rejects any older CRL** (defeats the rollback/pin replay a root buyer could mount).
- **Dedicated revocation key**, offline with the root signing key, distinct from serving/minting keys (spec 09).
- **At import:** revoked ⇒ refuse. **At run for a mid-flight revocation:** disable the install (flip to `disabled`
  via the existing `updateCapabilityInstall` state machine, `index.ts:444-497`) so a running flow finishes but the
  next invocation is blocked.
- Honesty clause: a root buyer can still patch the check — revocation, like entitlement, is cooperative *against
  the operator*; it is real protection for the fleet of honest instances, which is the population a security pull
  targets.

Staleness budget default is a MODE:hitl question (DESIGN.md open q1) — parameterize.

## Cross-Repo Side Effects
The broker publishes the signed, epoch-monotonic CRL (spec 09).

## Verify
- A `security` revocation blocks the pack at run once synced; an instance past the staleness budget refuses to run
  marketplace packs until it refreshes (mutation-proven: a warn-only path for a security reason fails the test).
- Rollback: feeding an older-epoch CRL is rejected; the high-water mark holds.
- A `license` revocation warns but doesn't block.
- Mid-flight: a running flow finishes; the next invocation of a now-revoked install is blocked.
