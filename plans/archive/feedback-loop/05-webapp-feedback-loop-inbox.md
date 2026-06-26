# Webapp Feedback Loop inbox

STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/App.tsx, webapp/src/components/layout/Sidebar.tsx, webapp/src/components/views/FeedbackLoopView.tsx (new), webapp/src/lib/dto.ts, webapp/src/hooks/useFeedbackLoop.ts (new)
BLOCKED_BY: 02-public-campaign-intake-api.md, 03-plane-promotion.md, 04-validation-reward-ledger.md

## Goal

Give operators a lightweight Feedback Loop control plane inside the existing omp-squad webapp: review new feedback, inspect evidence, accept/reject/promote, and manage reward state.

## Approach

### 1. Route/nav
Add `feedback-loop` to `VIEWS` in `webapp/src/App.tsx` and a sidebar entry in `Sidebar.tsx`.

### 2. Hook + DTOs
Add `useFeedbackLoop()` that fetches:

- `GET /api/feedback/campaigns`
- `GET /api/feedback/items?status=`

and exposes actions for accept/reject/promote/reward updates. Follow existing hooks' fetch style; no new client state library.

### 3. View
`FeedbackLoopView.tsx` should be boring:

- left list: status, title, URL/domain, user, reward badge, Plane badge;
- right detail: screenshot/evidence, description, metadata, validation responses, reward ledger, promotion button;
- filters: `new`, `needs-validation`, `accepted`, `promoted`, `rejected`.

Use existing `Card`, `Button`, `Badge`, `EmptyState`, and `Markdown` components. No custom design system.

### 4. Safety copy
Show explicit text near reward controls: rewards are pending operator review and external payout is manual in MVP.

## Cross-Repo Side Effects

None outside the webapp and existing authenticated API routes.

## Verify

- Component/unit test for status grouping and disabled/enabled action states.
- Manual smoke: with one seeded feedback item, operator can accept, promote, and see Plane issue id appear.
- Existing webapp typecheck remains clean.

## Resolution

Implemented the Feedback Loop webapp route, sidebar entry, DTO mirrors, fetch/action hook, inbox/detail view, filters, evidence/metadata/reward/validation panels, action buttons, and hook tests.
