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

**Implemented and verified locally:**
- SSO sign-in via AuthKit OIDC (better-auth mints the session). New SSO users land as `viewer` (no org)
  until mapped — the same safe default as any new user.
- The `/api/auth/mode` `sso` advertisement + the login button.
- The Directory Sync webhook **ingress + HMAC signature verification** (valid → 200; tampered / stale /
  unsigned → rejected). See `tests/workos.test.ts`.

**Deferred (needs a live WorkOS directory to finalize) — the provisioning seam:**
The webhook currently verifies and logs each `dsync.*` event. Turning those events into DB writes is the
next step, and is deliberately not shipped untested:

- **Org auto-mapping / JIT.** Map a WorkOS Organization → a local better-auth organization (create-if-missing,
  persist the WorkOS org id on org metadata), so an SSO user is placed into the right tenant on first login.
  Whether the WorkOS org id arrives as an OIDC claim on the sign-in profile (path a) or must be fetched via
  the WorkOS SDK `authenticateWithCode` (path b, `@workos-inc/node`) is the open decision — confirm against a
  live AuthKit OIDC claim set.
- **SCIM reconcile.** `dsync.user.created/updated/deleted` and `dsync.group.user_added/removed` →
  create/deactivate better-auth users and add/remove org memberships (with role mapping).

The seam is: `src/server.ts` `/api/workos/webhook` (verified event in hand) → a provisioning module that
calls better-auth's org/admin APIs. Wire it once a WorkOS account + connected directory exist so it can be
validated end to end.

## Cost (verify — WorkOS pricing changes)

- **AuthKit (User Management):** free up to ~1M MAU.
- **Enterprise SSO / Directory Sync:** ~$125 per connection/month with volume discounts (one connection =
  one customer's IdP link). No card required until production.
