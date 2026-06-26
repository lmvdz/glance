# Design: Feedback Loop inside omp-squad

## Approach

Make Feedback Loop an **ingress + validation + ticket-promotion lane** inside omp-squad.

The daemon already knows how to turn Plane issues into work: Plane backlog -> `Dispatcher` -> routed agent -> verify -> land -> close. Feedback Loop should feed that loop, not bypass it. The first version lives in omp-squad as:

1. a public, origin-allowlisted capture widget/API for product users;
2. an operator-reviewed feedback inbox in the existing webapp;
3. a promotion path that turns accepted feedback into a Plane issue with evidence, validation results, reward terms, and agent-ready acceptance criteria;
4. a reward ledger that tracks entitlement state but defers actual cash/crypto payout rails.

MVP deliberately skips video recording, crypto rewards, marketplace discovery, and native Jira/Linear. Plane is first because `src/plane.ts`, `src/server.ts`, `src/squad-manager.ts`, and the dispatcher already make Plane the autonomous-work handoff.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Product shape | omp-squad module, not standalone SaaS | Separate Feedback Loop app | Keeps the wedge sharp: feedback becomes work the squad can execute. Avoids duplicating auth, dashboard, and issue-dispatch systems. |
| First tracker | Plane only | Jira/Linear/GitHub first | Plane is already integrated (`createPlaneIssue`, `listPlaneIssues`, dispatcher, task detail). Linear/Jira can be adapters after the core loop proves useful. |
| First capture mode | Screenshot + annotation + text + metadata | Video editor, session replay, always-on recording | Browser capture already has hard permission/UX limits. A screenshot payload is enough to create high-signal tickets and is much cheaper to store/review. |
| Public API auth | Per-campaign public token + origin allowlist + size caps | Reuse admin bearer token; anonymous open endpoint | Public capture cannot use the operator token. Campaign-scoped tokens make embedding possible without exposing fleet control. |
| Persistence | Extend `Store` with feedback snapshot methods; FileStore JSON + DbStore tables | In-memory only; Plane-only storage | Operators need review/reward state before promotion. DB mode must stay tenant-isolated; file mode must keep working. |
| Rewards | Internal ledger: pending/approved/paid/external_ref; no provider call in MVP | Stripe/Tremendous/crypto immediately | Ledger proves incentive workflow without cash liability. Later adapters can consume approved ledger entries idempotently. |
| Validation | Lightweight follow-up votes attached to a feedback item | Full roadmap board | Existing roadmap products are crowded. The useful part is targeted validation evidence that travels with the ticket. |
| Agent handoff | Promote feedback to Plane issue with evidence packet and Tier-2-style sections | Spawn agent directly from feedback | Plane remains the durable queue and status sync source. Dispatcher then uses existing WIP caps, routing, verify, land, and close. |

## Risks

- **Spam and fraud:** public capture endpoints attract junk. Mitigate with origin allowlist, campaign token, payload caps, duplicate hashing, per-IP/per-user rolling limits, and manual approval before rewards.
- **Secret leakage in screenshots:** screenshots can include tokens or PII. Store attachments as operator-private; add redaction warning in widget; never expose attachment URLs without admin auth.
- **Storage blow-up:** video/session replay would explode local state. MVP only accepts one image attachment under a strict byte cap; video is a later concern with external object storage.
- **Tenant isolation:** DB mode is multi-org. Feedback tables must carry `org_id`, use `withOrg`, and get the same RLS backstop as existing app tables.
- **Plane body format drift:** promoted tickets need predictable agent sections. Keep formatting in one pure renderer with tests; do not inline markdown templates in server route code.
- **Reward liability:** ledger state is not money. UI copy must say "reward pending review" and provider adapters must be explicit later.

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| Public feedback endpoint could become an unauthenticated upload hole. | critical | Campaign token + origin allowlist + strict content type + byte limits + no video in MVP. |
| Directly spawning agents from user feedback bypasses product-manager review and WIP controls. | critical | Feedback promotes to Plane only after operator acceptance; existing dispatcher owns execution. |
| DB-mode org isolation can be broken if feedback is stored beside global state. | critical | Add feedback persistence to the `Store` abstraction and app migrations, not ad-hoc global files. |
| A reward feature without fraud controls pays spammers. | significant | Ledger only; `pending -> approved -> paid` requires operator approval and dedup/quality metadata. |
| Another roadmap/voting board is wasted effort. | significant | Build validation responses tied to feedback items, not a generic board. |
| Browser capture promises may exceed web platform limits. | significant | First widget is user-initiated screenshot capture only; video/voiceover are explicitly later. |

## Open Questions

None blocking the plan. The implementation can ship as an internal omp-squad module with Plane-only promotion and manual rewards first.
