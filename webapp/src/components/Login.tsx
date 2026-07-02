/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Mail, KeyRound, User, Loader2 } from 'lucide-react';
import { authClient } from '../lib/auth-client';
import { useAuth } from '../context/AuthContext';
import { ColumnsArt } from './ColumnsArt';

// GitHub wordmark glyph (lucide dropped brand icons in v1), inlined so the social button matches the mark.
const GithubMark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden className={className}>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

// The omp-squad mark — a stylized orbit (circle + ring), echoing the login reference.
const Logo = () => (
  <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden>
    <circle cx="17" cy="17" r="11" stroke="#e7e7e9" strokeWidth="1.5" />
    <ellipse cx="17" cy="17" rx="15.2" ry="6" stroke="#e7e7e9" strokeWidth="1.5" transform="rotate(-28 17 17)" />
  </svg>
);

type Mode = 'signin' | 'signup';

export const Login = () => {
  const { config, refresh } = useAuth();
  const [mode, setMode] = React.useState<Mode>('signin');
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const allowSignup = config?.allowSignup ?? false;
  const hasGithub = (config?.socialProviders ?? []).includes('github');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res =
        mode === 'signup'
          ? await authClient.signUp.email({ name: name || email.split('@')[0], email, password })
          : await authClient.signIn.email({ email, password });
      if (res.error) {
        setError(res.error.message || 'Authentication failed.');
        return;
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const github = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      // better-auth performs the browser redirect to GitHub and returns via /api/auth/callback/github.
      const res = await authClient.signIn.social({ provider: 'github', callbackURL: window.location.origin });
      if (res.error) {
        setError(res.error.message || 'GitHub sign-in failed.');
        setBusy(false);
      }
      // On success the browser navigates away; leave `busy` set.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GitHub sign-in failed.');
      setBusy(false);
    }
  };

  const inputCls =
    'w-full rounded-md bg-[#161618] border border-[#2a2a2e] pl-9 pr-3 py-2.5 text-[13px] text-[#e7e7e9] placeholder:text-[#5c5c62] outline-none focus:border-[#54545c] focus:ring-1 focus:ring-[#54545c]/60 transition-colors';

  return (
    <div className="fixed inset-0 z-50 flex bg-[#0a0a0b] p-3 text-[#e7e7e9]">
      <div className="flex w-full overflow-hidden rounded-xl border border-[#1c1c20] bg-[#0d0d0f]">
        {/* Left — form */}
        <div className="flex w-full max-w-[520px] shrink-0 flex-col justify-center px-10 sm:px-16">
          <div className="mx-auto w-full max-w-[300px]">
            <div className="mb-12">
              <Logo />
            </div>

            <form onSubmit={submit} className="flex flex-col gap-4">
              {mode === 'signup' && (
                <div>
                  <label className="mb-1.5 block text-[13px] font-semibold text-[#e7e7e9]">Name</label>
                  <div className="relative">
                    <User className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5c5c62]" />
                    <input
                      className={inputCls}
                      type="text"
                      autoComplete="name"
                      placeholder="Ada Lovelace"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-[#e7e7e9]">Email</label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5c5c62]" />
                  <input
                    className={inputCls}
                    type="email"
                    autoComplete="email"
                    required
                    placeholder="hello@0.email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-[13px] font-semibold text-[#e7e7e9]">Password</label>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5c5c62]" />
                  <input
                    className={inputCls}
                    type="password"
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    required
                    placeholder="Your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              </div>

              {error && (
                <p className="text-[12px] leading-snug text-[#f87171]" role="alert">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="mt-2 flex h-11 items-center justify-center rounded-md bg-white text-[14px] font-medium text-black transition-colors hover:bg-[#e9e9ea] disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === 'signup' ? 'Sign up' : 'Login'}
              </button>
            </form>

            {allowSignup && (
              <p className="mt-4 text-center text-[12px] text-[#8a8a90]">
                {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
                <button
                  type="button"
                  onClick={() => {
                    setMode(mode === 'signin' ? 'signup' : 'signin');
                    setError(null);
                  }}
                  className="text-[#e7e7e9] underline underline-offset-2 hover:text-white"
                >
                  {mode === 'signin' ? 'Sign up' : 'Login'}
                </button>
              </p>
            )}

            {hasGithub && (
              <>
                <div className="my-5 flex items-center gap-3">
                  <div className="h-px flex-1 bg-[#1f1f23]" />
                  <span className="text-[11px] text-[#5c5c62]">or</span>
                  <div className="h-px flex-1 bg-[#1f1f23]" />
                </div>
                <button
                  type="button"
                  onClick={github}
                  disabled={busy}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-md border border-[#2a2a2e] bg-black text-[14px] font-medium text-white transition-colors hover:bg-[#161618] disabled:opacity-60"
                >
                  <GithubMark className="h-4 w-4" />
                  Login with Github
                </button>
              </>
            )}
          </div>
        </div>

        {/* Right — dissolving columns */}
        <div className="relative hidden flex-1 overflow-hidden border-l border-[#1c1c20] bg-[#0b0b0d] md:block">
          <ColumnsArt />
        </div>
      </div>
    </div>
  );
};
