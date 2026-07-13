/**
 * FileSignIn — the file-mode "you are not signed in" screen.
 *
 * It did not exist, and its absence was a lie. `/api/auth/mode` needs no token, so the SPA learned "this
 * daemon is in file mode" and concluded it was signed in. Every authenticated call then answered 401, and
 * the dashboard rendered exactly as though the fleet were empty: no projects, no agents, and an "Add
 * project…" form whose only feedback was the raw word `unauthorized`.
 *
 * An empty fleet and a rejected token look identical from the outside. They are opposite problems, and the
 * UI must never confuse them — a glance user's first question is "is anything running?", and the dashboard
 * answering "nothing" when it means "I can't see" is the worst answer it can give.
 *
 * File mode's credential is a bearer token the daemon prints at boot. The dashboard URL carries it as
 * `?token=…`, which `captureToken()` moves into localStorage. Open the bare origin in a fresh browser —
 * or one whose storage was cleared — and there is nothing to send.
 */

import React from 'react';
import { apiFetch, setToken } from '../lib/api';
import { useAuth } from '../context/AuthContext';

export const FileSignIn = (): React.ReactElement => {
  const { refresh } = useAuth();
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const candidate = value.trim();
    if (!candidate) return;
    setBusy(true);
    setError(null);

    // Verify BEFORE persisting. A wrong token stored is a dashboard that silently shows an empty fleet
    // forever — the exact failure this screen exists to end.
    const probe = await apiFetch('/api/health', { headers: { Authorization: `Bearer ${candidate}` } }).catch(() => null);
    if (!probe || probe.status === 401 || probe.status === 403) {
      setBusy(false);
      setError(probe ? 'That token was rejected by the daemon.' : 'No daemon answered on this address.');
      return;
    }
    setToken(candidate);
    await refresh();
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-5">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">Not signed in</h1>
          <p className="text-sm opacity-80">
            This daemon runs in file mode, which authenticates with a bearer token. Your browser doesn&apos;t have one,
            so the dashboard can&apos;t read your fleet — <em>this is not an empty fleet</em>.
          </p>
        </div>

        <div className="space-y-2 rounded-md border border-current/15 p-4">
          <p className="text-sm font-medium">Where to find the token</p>
          <p className="text-sm opacity-80">
            The daemon printed a sign-in link when it started. Otherwise, read the token and paste it below:
          </p>
          {/* Deliberately NOT `glance open` or any other CLI verb. The package declares both a `glance` and
              an `omp-squad` bin, and an install predating the rename has only the latter — the first draft
              of this screen told the operator to run a command that did not exist on their machine. A
              recovery screen that prescribes a broken command is worse than no screen. `cat` always works. */}
          <pre className="overflow-x-auto rounded bg-current/5 p-3 text-xs">
            <code>cat ~/.glance/access-token</code>
          </pre>
          <p className="text-xs opacity-60">Older installs keep it at ~/.omp/squad/access-token.</p>
        </div>

        <form onSubmit={submit} className="space-y-2">
          <label htmlFor="glance-token" className="text-sm font-medium">
            …or paste the token
          </label>
          <div className="flex gap-2">
            <input
              id="glance-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="access token"
              className="flex-1 rounded border border-current/20 bg-transparent px-3 py-2 text-sm"
            />
            <button type="submit" disabled={busy || !value.trim()} className="rounded border border-current/20 px-4 py-2 text-sm disabled:opacity-50">
              {busy ? 'Checking…' : 'Sign in'}
            </button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-red-500">
              {error}
            </p>
          ) : null}
        </form>
      </div>
    </div>
  );
};
