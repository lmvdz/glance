/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Mail, KeyRound, User, Loader2, Building2 } from 'lucide-react';
import { authClient } from '../lib/auth-client';
import { useAuth } from '../context/AuthContext';
import loginArt from '../assets/login-art.png';

// Self-contained film-grain (inline SVG feTurbulence, no external asset — CSP-safe). Overlaid faintly to
// echo the artwork's grain and warm the flat form panel.
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E\")";

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
  const hasSso = config?.sso ?? false;

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

  const sso = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      // WorkOS AuthKit (providerId "workos") handles enterprise IdP selection + social; better-auth mints
      // the local session on return via /api/auth/oauth2/callback/workos.
      const res = await authClient.signIn.oauth2({ providerId: 'workos', callbackURL: window.location.origin });
      if (res.error) {
        setError(res.error.message || 'SSO sign-in failed.');
        setBusy(false);
      }
      // On success the browser navigates away to the IdP; leave `busy` set.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'SSO sign-in failed.');
      setBusy(false);
    }
  };

  const inputCls =
    'w-full rounded-lg border border-[#2a2a2e] bg-[#151517] py-2.5 pl-9 pr-3 text-[13px] text-[#e7e7e9] placeholder:text-[#5c5c62] outline-none transition-colors focus:border-[#f0a35a]/50 focus:ring-2 focus:ring-[#f0a35a]/20';
  const socialCls =
    'flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-[#2a2a2e] bg-[#0f0f11] text-[14px] font-medium text-white transition-colors hover:border-[#3b3b42] hover:bg-[#161618] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f0a35a]/40 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0c0c0e] disabled:opacity-60';

  return (
    <div className="fixed inset-0 z-50 flex bg-[#0a0a0b] p-3 text-[#e7e7e9]">
      <div className="relative flex w-full overflow-hidden rounded-2xl border border-[#1c1c20] bg-[#0c0c0e]">
        {/* Left — form */}
        <div className="relative flex w-full flex-col md:max-w-[560px] md:shrink-0">
          {/* Atmosphere: a warm ember glow pulled from the artwork + faint film grain. */}
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute -left-20 -top-24 h-72 w-72 rounded-full bg-[#f0a35a]/10 blur-[110px]" />
            <div className="absolute inset-0 opacity-[0.035] mix-blend-overlay" style={{ backgroundImage: GRAIN, backgroundSize: '130px' }} />
          </div>

          <div className="relative flex flex-1 flex-col justify-center px-8 py-12 sm:px-14">
            <div className="login-rise mx-auto w-full max-w-[320px]">
              {/* Brand lockup */}
              <div className="mb-9 flex items-center gap-2.5">
                <Logo />
                <span className="text-[15px] font-semibold tracking-tight text-[#f4f4f5]">omp-squad</span>
              </div>

              {/* Headline */}
              <div className="mb-7">
                <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-white">
                  {mode === 'signup' ? 'Create your account' : 'Welcome back'}
                </h1>
                <p className="mt-1.5 text-[13.5px] text-[#8a8a90]">
                  {mode === 'signup' ? 'Set up access to your fleet.' : 'Sign in to command your fleet.'}
                </p>
              </div>

              <form onSubmit={submit} className="flex flex-col gap-4">
                {mode === 'signup' && (
                  <div>
                    <label className="mb-1.5 block text-[13px] font-medium text-[#c7c7cc]">Name</label>
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
                  <label className="mb-1.5 block text-[13px] font-medium text-[#c7c7cc]">Email</label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5c5c62]" />
                    <input
                      className={inputCls}
                      type="email"
                      autoComplete="email"
                      required
                      placeholder="you@company.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-[13px] font-medium text-[#c7c7cc]">Password</label>
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5c5c62]" />
                    <input
                      className={inputCls}
                      type="password"
                      autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                      required
                      placeholder="••••••••••••"
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
                  className="mt-1 flex h-11 items-center justify-center rounded-lg bg-white text-[14px] font-semibold text-black shadow-[0_10px_30px_-12px_rgba(240,163,90,0.45)] transition-all hover:shadow-[0_14px_44px_-12px_rgba(240,163,90,0.6)] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f0a35a]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0c0c0e] disabled:opacity-60"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === 'signup' ? 'Create account' : 'Sign in'}
                </button>
              </form>

              {allowSignup && (
                <p className="mt-4 text-[12.5px] text-[#8a8a90]">
                  {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
                  <button
                    type="button"
                    onClick={() => {
                      setMode(mode === 'signin' ? 'signup' : 'signin');
                      setError(null);
                    }}
                    className="font-medium text-[#f0b478] underline-offset-2 transition-colors hover:text-[#f8cfa0]"
                  >
                    {mode === 'signin' ? 'Sign up' : 'Sign in'}
                  </button>
                </p>
              )}

              {(hasSso || hasGithub) && (
                <>
                  <div className="my-5 flex items-center gap-3">
                    <div className="h-px flex-1 bg-[#1f1f23]" />
                    <span className="text-[11px] uppercase tracking-wider text-[#5c5c62]">or</span>
                    <div className="h-px flex-1 bg-[#1f1f23]" />
                  </div>
                  <div className="flex flex-col gap-2.5">
                    {hasSso && (
                      <button type="button" onClick={sso} disabled={busy} className={socialCls}>
                        <Building2 className="h-4 w-4" />
                        Sign in with SSO
                      </button>
                    )}
                    {hasGithub && (
                      <button type="button" onClick={github} disabled={busy} className={socialCls}>
                        <GithubMark className="h-4 w-4" />
                        Continue with GitHub
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="relative px-8 pb-6 sm:px-14">
            <p className="mx-auto max-w-[320px] text-[11px] text-[#4b4b52]">
              Protected by end-to-end encrypted sessions.
            </p>
          </div>
        </div>

        {/* Right — artwork (full-bleed cover; a soft seam gradient blends it into the form panel). */}
        <div className="relative hidden flex-1 overflow-hidden bg-black md:block">
          <img src={loginArt} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover object-center" />
          <div aria-hidden className="absolute inset-y-0 left-0 w-28 bg-gradient-to-r from-[#0c0c0e] to-transparent" />
        </div>
      </div>
    </div>
  );
};
