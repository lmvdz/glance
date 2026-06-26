# Public campaign intake API + attachment guardrails

STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/server.ts, src/feedback.ts, .env.example, tests/feedback-api.test.ts (new)
BLOCKED_BY: 01-feedback-domain-persistence.md

## Goal

Let an embedded product submit one screenshot feedback payload to omp-squad without exposing the operator/admin token.

## Approach

### 1. Env/config
Add to `.env.example`:

- `OMP_SQUAD_FEEDBACK=0` — public feedback routes disabled unless set to `1`.
- `OMP_SQUAD_FEEDBACK_MAX_IMAGE_BYTES=2000000` — default 2MB.
- `OMP_SQUAD_FEEDBACK_RATE_LIMIT_PER_MIN=30` — coarse in-process limiter for public intake.

Campaigns carry their own `allowedOrigins` and `tokenHash`; no global public token.

### 2. `src/server.ts` public route placement
Routes must run before the admin auth gate only when `OMP_SQUAD_FEEDBACK=1`:

- `GET /feedback/widget.js` serves the static widget from concern 06.
- `POST /api/feedback/items` accepts public capture payloads.

Everything else under `/api/feedback/*` remains behind normal operator auth.

### 3. Request validation in `src/feedback.ts`
Add `acceptFeedbackSubmission({ campaigns, body, origin, now })`:

- require `campaignId` and `token`;
- constant-time compare `hashCampaignToken(token)` against campaign `tokenHash`;
- require `Origin` to match campaign `allowedOrigins` unless the campaign explicitly has `"*"`;
- accept one screenshot attachment only: `data:image/png;base64,...` or `data:image/jpeg;base64,...`;
- reject attachments over `OMP_SQUAD_FEEDBACK_MAX_IMAGE_BYTES`;
- compute `sha256` for duplicate detection;
- clamp title/description/metadata lengths;
- create `FeedbackItem` with `status: "new"` and `rewardStatus: campaign.rewardCents ? "pending" : "none"`.

Attachment files go under the org/state dir, e.g. `feedback/attachments/<itemId>/<attachmentId>.png`, using durable write. Store the relative path only.

### 4. Rate limiting
Use a tiny in-memory rolling counter keyed by `campaignId + ip`. Ponytail: this resets on daemon restart; acceptable for MVP because campaign token + origin + byte caps are the real controls. Add a `ponytail:` comment naming that ceiling.

## Cross-Repo Side Effects

The public capture route is intentionally narrower than existing admin API routes. It must not accept `repo` directly from the public body unless the campaign maps to that repo.

## Verify

- `tests/feedback-api.test.ts`: route is 404/403 when `OMP_SQUAD_FEEDBACK` is off.
- Valid campaign token + origin creates one `FeedbackItem` and attachment hash.
- Wrong token, wrong origin, oversize image, unknown campaign all fail without writing an item.
- Public route does not accept operator commands or return roster data.

## Resolution

Implemented opt-in public feedback intake, widget serving, campaign token/origin validation, PNG/JPEG byte caps, attachment persistence, in-process rate limiting, env knobs, and focused API tests.
