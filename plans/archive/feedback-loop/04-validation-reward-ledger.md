# Validation loop + reward ledger

STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/feedback.ts, src/server.ts, tests/feedback-validation.test.ts (new)
BLOCKED_BY: 01-feedback-domain-persistence.md

## Goal

Collect lightweight validation responses and track reward entitlement state before a ticket is promoted or paid.

## Approach

### 1. Validation responses
Add authenticated APIs:

- `POST /api/feedback/items/:id/validation` — operator-created/manual response or imported respondent answer.
- `GET /api/feedback/items/:id/validation` — list responses.

Payload fields:

- respondent id/email or anonymous label;
- `wouldUse: boolean`;
- `pain: 1..5`;
- optional note;
- optional segment metadata.

No email sending in this concern. The first version records answers gathered elsewhere or from a simple link later. This avoids building a survey platform.

### 2. Derived confidence
Add pure `scoreValidation(responses)`:

- count yes/no;
- average pain;
- confidence label: `none | weak | medium | strong` based on response count and yes ratio.

Keep the formula boring and documented in code. No ML.

### 3. Reward ledger
Add APIs:

- `POST /api/feedback/items/:id/reward/approve`
- `POST /api/feedback/items/:id/reward/void`
- `POST /api/feedback/items/:id/reward/mark-paid`

`mark-paid` accepts `{ provider?: "manual" | "stripe" | "tremendous", externalRef?: string }` but does not call those providers. This makes payout reconciliation possible without taking on payment liability in MVP.

State rules:

```txt
none -> pending      only when campaign has reward terms
pending -> approved  operator approval
approved -> paid     manual/provider reference recorded
pending|approved -> void
paid is terminal except metadata note updates
```

### 4. Audit
Append `feedback.accept`, `feedback.reject`, `feedback.promote`, `feedback.reward.approve`, `feedback.reward.paid` to the existing audit stream (`appendAudit`/`store.appendAudit`) so reward decisions are accountable.

## Cross-Repo Side Effects

None. Provider adapters (Stripe/Tremendous/crypto) are intentionally separate future plans.

## Verify

- `tests/feedback-validation.test.ts`: validation score handles zero, weak, medium, and strong cases.
- Reward state machine rejects illegal transitions (`none -> paid`, `void -> paid`, `paid -> void`).
- Reward approval and paid markers append audit entries.

## Resolution

Implemented validation response capture, confidence scoring, reward ledger transitions, audit entries, and focused reward/validation tests. Payout providers remain intentionally manual/deferred.
