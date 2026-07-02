/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { apiFetch } from '../lib/api';
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
  | 'file' // file mode — no login page, legacy bearer-token behavior
  | 'authed' // db mode, valid session
  | 'anon'; // db mode, no session — show <Login/>

interface AuthState {
  status: Status;
  config: AuthMode | null;
  me: Me | null;
  /** Re-check the session (call after a successful sign-in/sign-up). */
  refresh: () => Promise<void>;
  /** End the session and return to the login screen. */
  signOut: () => Promise<void>;
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

  // Resolve the current session against a known mode. Returns the next status.
  const resolveSession = React.useCallback(async (mode: AuthMode): Promise<void> => {
    if (mode.mode === 'file') {
      setMe(null);
      setStatus('file');
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
    const body = (await res.json()) as Me | { mode: 'file' };
    if (body.mode !== 'db') {
      // Server flipped to file mode between calls; treat as file.
      setMe(null);
      setStatus('file');
      return;
    }
    setMe(body);
    setStatus('authed');
  }, []);

  const load = React.useCallback(async () => {
    try {
      const res = await apiFetch('/api/auth/mode');
      const mode = (await res.json()) as AuthMode;
      setConfig(mode);
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
      setMe(null);
      setStatus('anon');
    }
  }, []);

  const value = React.useMemo<AuthState>(
    () => ({ status, config, me, refresh, signOut }),
    [status, config, me, refresh, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
