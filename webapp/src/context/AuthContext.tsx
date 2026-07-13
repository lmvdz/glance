/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { apiFetch, clearToken } from '../lib/api';
import { authClient, type SocialProvider } from '../lib/auth-client';

// What the server advertises pre-login (GET /api/auth/mode). Drives which auth style the SPA uses and
// which affordances the login screen renders — we only show a button the daemon can actually service.
export interface AuthMode {
  mode: 'file' | 'db';
  allowSignup: boolean;
  socialProviders: SocialProvider[];
  /** WorkOS enterprise SSO configured server-side ⇒ show the "Sign in with SSO" button. */
  sso: boolean;
}

// The authenticated identity (GET /api/me in db mode).
export interface Me {
  mode: 'db';
  user: { id: string; name: string; email: string; image: string | null };
  activeOrganizationId: string | null;
  role: 'viewer' | 'operator' | 'admin';
}

type Status =
  | 'loading' // fetching mode/session
  | 'file' // file mode — a bearer token the daemon actually accepts
  | 'file-anon' // file mode, and the daemon rejects our token (or we have none) — show <FileSignIn/>
  | 'authed' // db mode, valid session
  | 'pending' // db mode, join request awaiting an org admin's approval
  | 'anon'; // db mode, no session — show <Login/>

/** Result of POST /api/workos/sync (onboarding decision). */
type OnboardOutcome =
  | { outcome: 'mapped' | 'joined'; organizationId: string; role: string }
  | { outcome: 'pending'; organizationId: string; organizationName: string }
  | { outcome: 'personal'; organizationId: string }
  | { outcome: 'none' };

interface AuthState {
  status: Status;
  config: AuthMode | null;
  me: Me | null;
  /** When status === 'pending': the org name the user requested to join. */
  pendingOrg: string | null;
  /** Re-check the session (call after a successful sign-in/sign-up). */
  refresh: () => Promise<void>;
  /** End the session and return to the login screen. */
  signOut: () => Promise<void>;
}

/**
 * Does a file-mode daemon accept the token this browser is holding?
 *
 * `/api/auth/mode` is unauthenticated, so learning "this daemon is in file mode" said NOTHING about
 * whether we can talk to it — and the SPA reported 'file' regardless. Every authenticated call then 401'd,
 * and the dashboard rendered an empty roster, zero projects, and an "Add project…" form whose only
 * feedback was the word `unauthorized`. An empty fleet and a rejected token looked identical.
 *
 * `null` means the probe itself failed (no daemon answered). That is not authentication's problem, so it
 * resolves to 'file' and the dashboard's own loading/error states speak — inventing a sign-in screen for a
 * daemon that is simply down would be a second lie.
 */
export function fileModeStatus(probeStatus: number | null): 'file' | 'file-anon' {
  if (probeStatus === 401 || probeStatus === 403) return 'file-anon';
  return 'file';
}

const AuthContext = React.createContext<AuthState | null>(null);

export const useAuth = (): AuthState => {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
};

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [status, setStatus] = React.useState<Status>('loading');
  const [config, setConfig] = React.useState<AuthMode | null>(null);
  const [me, setMe] = React.useState<Me | null>(null);
  const [pendingOrg, setPendingOrg] = React.useState<string | null>(null);
  // Attempt the WorkOS onboarding sync at most once per authenticated session (reset on sign-out).
  const syncAttempted = React.useRef(false);

  // Resolve the current session against a known mode. Returns the next status.
  const resolveSession = React.useCallback(async (mode: AuthMode): Promise<void> => {
    if (mode.mode === 'file') {
      setMe(null);
      // Probe a route that actually requires the bearer token, and believe the answer (see fileModeStatus).
      const probe = await apiFetch('/api/health').catch(() => null);
      setStatus(fileModeStatus(probe ? probe.status : null));
      return;
    }
    // db mode — a valid cookie session yields /api/me; 401 means we need to log in.
    const res = await apiFetch('/api/me');
    if (res.status === 401) {
      setMe(null);
      setStatus('anon');
      return;
    }
    if (!res.ok) throw new Error(`/api/me ${res.status}`);
    let body = (await res.json()) as Me | { mode: 'file' };
    if (body.mode !== 'db') {
      // Server flipped to file mode between calls; treat as file.
      setMe(null);
      setStatus('file');
      return;
    }
    // Onboard an org-less user: WorkOS users map to their org / auto-join / request a domain-matched company
    // org; everyone else (email, GitHub) gets a personal workspace. Run once, then re-read identity.
    if (body.activeOrganizationId === null && !syncAttempted.current) {
      syncAttempted.current = true;
      try {
        const sync = await apiFetch('/api/workos/sync', { method: 'POST' });
        if (sync.ok) {
          const s = (await sync.json()) as OnboardOutcome;
          if (s.outcome === 'pending') {
            setMe(body);
            setPendingOrg(s.organizationName);
            setStatus('pending');
            return;
          }
          if (s.outcome === 'mapped' || s.outcome === 'joined' || s.outcome === 'personal') {
            const again = await apiFetch('/api/me');
            if (again.ok) {
              const b2 = (await again.json()) as Me | { mode: 'file' };
              if (b2.mode === 'db') body = b2;
            }
          }
        }
      } catch {
        // Non-fatal — the user simply stays an org-less viewer until the next sync.
      }
    }
    setMe(body);
    setStatus('authed');
  }, []);

  const load = React.useCallback(async () => {
    try {
      const res = await apiFetch('/api/auth/mode');
      const mode = (await res.json()) as AuthMode;
      setConfig(mode);
      // A stale file-mode bearer token makes a DB-mode daemon answer /api/me with {mode:"file"}
      // (loopback bootstrap), trapping the user in an empty file-mode shell. Drop it before we probe.
      if (mode.mode === 'db') clearToken();
      await resolveSession(mode);
    } catch {
      // If the mode probe itself fails (daemon down, offline), fall back to the legacy tokenless render
      // rather than trapping the operator on a spinner — the app's own fetches will surface the outage.
      setStatus('file');
    }
  }, [resolveSession]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const refresh = React.useCallback(async () => {
    if (config) await resolveSession(config);
    else await load();
  }, [config, resolveSession, load]);

  const signOut = React.useCallback(async () => {
    try {
      await authClient.signOut();
    } finally {
      syncAttempted.current = false;
      setMe(null);
      setPendingOrg(null);
      setStatus('anon');
    }
  }, []);

  const value = React.useMemo<AuthState>(
    () => ({ status, config, me, pendingOrg, refresh, signOut }),
    [status, config, me, pendingOrg, refresh, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
