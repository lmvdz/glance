/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// BetterAuth browser client — the SAME auth stack the daemon runs server-side (src/db/auth.ts), so the
// login/sign-up/social flows hit better-auth's own /api/auth/* endpoints with the exact contracts it
// expects (CSRF, cookie session, social redirect) rather than hand-rolled fetches.
//
// The client is same-origin: baseURL defaults to window.location.origin and the session rides on the
// SameSite cookie better-auth sets, so no token plumbing is needed in db mode. The organizationClient
// plugin mirrors the server's organization() plugin (active-org, member roles) for later org UI.
import { createAuthClient } from 'better-auth/react';
import { organizationClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [organizationClient()],
});

export type SocialProvider = 'github';
