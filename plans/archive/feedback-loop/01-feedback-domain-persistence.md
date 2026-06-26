# Feedback domain + persistence seam

STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/feedback.ts (new), src/dal/store.ts, src/db/schema.ts, src/db/migrations.ts, tests/feedback-store.test.ts (new)
BLOCKED_BY: —

## Goal

Add the durable Feedback Loop data model without changing execution behavior: campaigns, feedback items, attachments, validation responses, and reward ledger entries must persist in both file mode and DB mode.

## Approach

### 1. `src/types.ts`
Add wire/domain interfaces near the existing DTO types:

```ts
export type FeedbackStatus = "new" | "needs-validation" | "accepted" | "promoted" | "rejected";
export type FeedbackKind = "bug" | "feature" | "friction";
export type FeedbackRewardStatus = "none" | "pending" | "approved" | "paid" | "void";

export interface FeedbackCampaign {
  id: string;
  name: string;
  repo: string;
  tokenHash: string;
  allowedOrigins: string[];
  rewardCents?: number;
  rewardCurrency?: string;
  createdAt: number;
  archived?: boolean;
}

export interface FeedbackAttachment {
  id: string;
  kind: "screenshot";
  contentType: "image/png" | "image/jpeg";
  bytes: number;
  path?: string;
  sha256: string;
}

export interface FeedbackItem {
  id: string;
  campaignId: string;
  repo: string;
  kind: FeedbackKind;
  title: string;
  description: string;
  url?: string;
  userId?: string;
  userEmail?: string;
  browser?: string;
  viewport?: string;
  metadata: Record<string, string>;
  attachment?: FeedbackAttachment;
  status: FeedbackStatus;
  rewardStatus: FeedbackRewardStatus;
  planeIssue?: IssueRef;
  createdAt: number;
  updatedAt: number;
}

export interface FeedbackValidationResponse { /* feedbackId, respondent, vote, pain, note, createdAt */ }
export interface FeedbackReward { /* feedbackId, amount, currency, status, provider?, externalRef?, reviewer?, updatedAt */ }
```

Keep strings/JSON primitives only. No `File`, `Blob`, class instances, or provider SDK objects in stored data.

### 2. `src/feedback.ts`
Create pure helpers first:

- `newFeedbackId()` / `newCampaignId()` monotonic-ish opaque ids.
- `hashCampaignToken(token)` using Node crypto SHA-256.
- `normalizeFeedbackInput(input)` validates title/description/kind/metadata limits.
- `summarizeFeedback(item, validations, reward)` returns the compact evidence summary used by UI and promotion.

### 3. `src/dal/store.ts`
Extend `StateSnapshot` and `Store`:

```ts
feedback?: FeedbackSnapshot;
loadFeedback(): Promise<FeedbackSnapshot>;
saveFeedback(snapshot: FeedbackSnapshot): Promise<void>;
```

`FileStore` writes `feedback.json` via `writeFileDurable`. Do not bloat `state.json` with screenshots.

### 4. DB mode
Add app tables to `src/db/schema.ts` and `src/db/migrations.ts`:

- `feedback_campaigns`
- `feedback_items`
- `feedback_validation_responses`
- `feedback_rewards`

Every table carries `org_id`, gets RLS via `APP_TABLES`, and stores a `data` JSON text column for the full object. Add lookup columns only for common filters: `id`, `campaign_id`, `repo`, `status`, `created_at`.

## Cross-Repo Side Effects

None. This only extends omp-squad internal persistence and public wire types.

## Verify

- `tests/feedback-store.test.ts`: FileStore round-trips campaigns/items/rewards and survives empty/missing file.
- DB-mode test with sqlite `DATABASE_URL=sqlite::memory:` verifies `DbStore` persists feedback for one org and does not return another org's rows.
- `bun test tests/feedback-store.test.ts`.

## Resolution

Implemented feedback domain types, pure helpers, file/DB Store persistence, org-scoped feedback tables, RLS inclusion, and focused persistence tests.
