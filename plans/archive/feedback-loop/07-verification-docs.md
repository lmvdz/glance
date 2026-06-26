# Verification + docs

STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: README.md, docs/operations.md, .env.example, affected Feedback Loop tests
BLOCKED_BY: 02-public-campaign-intake-api.md, 03-plane-promotion.md, 04-validation-reward-ledger.md, 05-webapp-feedback-loop-inbox.md, 06-embeddable-screenshot-widget.md

## Goal

Prove the Feedback Loop path works end to end and document how to operate it safely.

## Approach

### 1. Targeted verification
Run only the relevant tests added by this plan, plus existing checks affected by touched files:

- `bun test tests/feedback-store.test.ts`
- `bun test tests/feedback-api.test.ts`
- `bun test tests/feedback-promotion.test.ts`
- `bun test tests/feedback-validation.test.ts`
- widget static test
- webapp test/typecheck for the new view
- root `bun run check` after all TypeScript changes

Do not run `dev` or `build` unless explicitly requested; repo instructions prohibit routine dev/build commands.

### 2. README
Document:

- what Feedback Loop is inside omp-squad;
- enablement env vars;
- campaign creation/token model;
- widget embed snippet;
- Plane promotion flow;
- reward ledger semantics and the fact that MVP does not pay automatically;
- security limits: origins, token secrecy, screenshot PII, size caps.

### 3. Operations docs
Add operator notes to `docs/operations.md`:

- public endpoint exposure requires HTTPS;
- put behind a trusted reverse proxy/tunnel;
- set campaign origin allowlists;
- monitor attachment disk growth;
- manual reward payout reconciliation.

### 4. Final smoke scenario
Seed or create one campaign, submit one feedback item, accept it, add one validation response, approve reward, promote to Plane, and confirm the created issue appears through `/api/plane/issues` for the repo.

## Cross-Repo Side Effects

None.

## Verify

- All targeted tests pass.
- Documentation mentions every new env var in `.env.example`.
- Manual smoke creates one Plane issue from one feedback item without spawning an agent directly.

## Resolution

Updated README and operations docs for Feedback Loop enablement, widget embedding, campaign security, Plane promotion, manual reward ledger semantics, and operational limits. Ran targeted tests and typechecks.
