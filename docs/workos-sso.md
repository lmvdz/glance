# Enterprise SSO via WorkOS

omp-squad adds enterprise-grade multi-tenant SSO through **WorkOS AuthKit**, wired so that
**better-auth stays the owner of users, sessions, and organizations** (and the Postgres RLS `org_id`).
WorkOS is an upstream identity source only: AuthKit sits in front of every customer's IdP
(Okta / Entra / Google Workspace / Ping / generic SAML+OIDC / social) behind a **single OIDC client**,
and better-auth mints the local session on return. Integrate once; keep your tenant model.

## Architecture

```
Browser ──► omp-squad Login ("Sign in with SSO")
              │  authClient.signIn.oauth2({ providerId: "workos" })
              ▼
        better-auth genericOAuth (providerId "workos")
              │  OIDC authorize (discovery: AuthKit .well-known)
              ▼
        WorkOS AuthKit ──► customer IdP (SAML/OIDC/social), email-first detection
              │  redirect back: /api/auth/oauth2/callback/workos
              ▼
        better-auth mints the local cookie session ──► your org / RLS / RBAC
```

- Sign-in path: `genericOAuth` in [`src/db/auth.ts`](../src/db/auth.ts), gated by `WORKOS_CLIENT_ID` + `WORKOS_API_KEY`.
- Directory Sync (SCIM) webhook: `POST /api/workos/webhook` in [`src/server.ts`](../src/server.ts), HMAC-verified in [`src/workos.ts`](../src/workos.ts).
- The login button appears when `/api/auth/mode` reports `sso: true`.

## Setup (WorkOS dashboard)

1. Create a WorkOS account and an **Environment**. Enable **User Management / AuthKit**.
2. Under **Redirects**, add the redirect URI **exactly**:
   `<BETTER_AUTH_URL>/api/auth/oauth2/callback/workos`
   (e.g. `https://squad.example.com/api/auth/oauth2/callback/workos`; for local dev `http://localhost:7878/...`).
3. Grab your **Client ID** (`client_...`) and **API Key** (`sk_...`).
4. Configure at least one **Connection** under an **Organization** — for a first test use WorkOS's
   **Test SSO** connection, or connect a real Okta/Entra.
5. (Directory Sync) Create a **Webhook endpoint** pointing at `<BETTER_AUTH_URL>/api/workos/webhook`,
   subscribe to `dsync.*` events, and copy its **signing secret**.

## Configure omp-squad

Set in `.env` (db mode; requires `DATABASE_URL` + `BETTER_AUTH_SECRET`):

```
WORKOS_CLIENT_ID=client_...
WORKOS_API_KEY=sk_...
WORKOS_WEBHOOK_SECRET=whsec_...   # only for Directory Sync
```

Restart the daemon. The "Sign in with SSO" button appears automatically. No code change is needed to add
more IdPs later — you connect them in the WorkOS dashboard.

## What's implemented vs. deferred

**Implemented and verified against a live WorkOS tenant:**
- SSO sign-in via AuthKit OIDC. WorkOS exposes no userinfo endpoint and its access-token JWT omits email,
  so `workosUserInfo` (src/workos.ts) decodes the token for `sub`/`org_id`/`role` and fetches email/name
  from the WorkOS User API; better-auth then mints the session.
- **JIT org mapping** (src/workos-provision.ts + `POST /api/workos/sync`). On first login the SPA reconciles
  the user's WorkOS Organization memberships → better-auth orgs + members (the WorkOS org id IS the
  better-auth org id; `workosOrgId` also stored in metadata), maps the WorkOS role (admin/owner→admin, else
  member), and sets `session.activeOrganizationId`. The user lands in their tenant with the bridged RBAC
  tier + Postgres RLS `org_id`. Idempotent; runs on every login. Bypasses `allowUserToCreateOrganization`
  by design (that guards user self-minting, not IdP provisioning). Verified: WorkOS "Test Organization" +
  admin membership → better-auth org + admin member + active org.
- The `/api/auth/mode` `sso` advertisement + the login button.
- The Directory Sync webhook **ingress + HMAC signature verification** (valid → 200; tampered / stale /
  unsigned → rejected). See `tests/workos.test.ts`.

## New-user onboarding

On first login an org-less user runs through a decision tree (`onboardWorkosUser`, called by
`POST /api/workos/sync`):

1. **Already a WorkOS org member** → mapped to that better-auth org (admin/member).
2. **Verified email-domain match** → the matched org's **join policy** decides:
   - `auto` → added as a member immediately (lands in the company org).
   - `approval` (default) → a **join request** is recorded; the user sees a "pending approval" screen until
     an admin approves.
3. **No company match** → a **personal workspace** is created (better-auth-native org, user = owner).

Security: only **verified** domains match, and public email providers (gmail, outlook, icloud, …) never map
to a tenant — those users always get a personal workspace. Company orgs live in WorkOS (verified domains);
personal orgs are better-auth-only (we don't mint a WorkOS org per individual).

**Per-org join policy** is stored in the WorkOS Organization's `metadata`:

```
metadata: { "join_policy": "auto" }     # auto-join on verified-domain match
metadata: { "join_policy": "approval" } # or omit entirely → default: require admin approval
```

Admins review pending requests in the account menu (**Join requests** → approve/deny), backed by
`GET /api/workos/join-requests` + `POST /api/workos/join-requests/decide` (admin-only, scoped to the
caller's active org). Approving creates the WorkOS membership and reconciles it into better-auth.

## Deferred — SCIM (Directory Sync) provisioning
The webhook currently verifies and logs each `dsync.*` event; turning them into DB writes is the remaining
piece and needs a live connected directory (SCIM) to validate end to end:

- `dsync.user.created/updated/deleted` and `dsync.group.user_added/removed` → create/deactivate better-auth
  users and add/remove org memberships. The org/member write path already exists (`reconcileWorkosOrgs` in
  src/workos-provision.ts) — SCIM handlers reuse it, keyed by the WorkOS org id. Wire once an enterprise
  IdP directory is connected in WorkOS.

## Cost (verify — WorkOS pricing changes)

- **AuthKit (User Management):** free up to ~1M MAU.
- **Enterprise SSO / Directory Sync:** ~$125 per connection/month with volume discounts (one connection =
  one customer's IdP link). No card required until production.
