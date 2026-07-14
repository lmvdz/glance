/**
 * OrgSettings.test.tsx — the per-org voice card (voice-db-mode/06).
 *
 * SSR-render assertions, this suite's convention (no jsdom): `VoiceKeyCard` is kept pure and
 * prop-driven precisely so its three honest states render standalone here without an AuthProvider /
 * websocket stack (mirrors `TaskProperties`' `CategoryChip`). The one non-render test drives the api
 * wrapper directly to prove the pasted key reaches the server and nothing else.
 */

import { expect, test, describe } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoiceKeyCard } from './OrgSettings';
import { putOrgVoiceKey, type VoiceKeyStatus } from '../lib/api';

// Shared no-op handler props — each test overrides only what it asserts on.
const base = {
  keyInput: '',
  onKeyInput: () => {},
  onSave: () => {},
  saving: false,
  onToggleEnabled: () => {},
  onRemove: () => {},
  busy: false,
  error: null as string | null,
};

const configured: VoiceKeyStatus = { configured: true, last4: 'wxyz', enabled: true, updatedAt: 1_720_000_000_000, updatedBy: 'db:admin-1' };

describe('VoiceKeyCard — three honest states', () => {
  test('unconfigured (admin): a masked key input + Save, no configured affordances', () => {
    const html = renderToStaticMarkup(<VoiceKeyCard isAdmin status={{ configured: false }} {...base} />);
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"'); // masked, no browser autofill of the secret
    expect(html).toContain('OpenAI API key');
    expect(html).toContain('Save');
    // Nothing that belongs only to the configured state.
    expect(html).not.toContain('Remove key');
    expect(html).not.toContain('Disable');
  });

  test('configured (admin): last4 as a rotation check, who/when, and DISTINCT disable + remove', () => {
    const html = renderToStaticMarkup(<VoiceKeyCard isAdmin status={configured} {...base} />);
    expect(html).toContain('wxyz');
    expect(html.toLowerCase()).toContain('rotate'); // last4 labeled as a rotation check, not an id
    expect(html).toContain('db:admin-1');
    // No key field once configured — the key is never re-shown.
    expect(html).not.toContain('type="password"');
    // Disable (kill switch) and Remove (delete) are separate controls with distinct labels.
    expect(html).toContain('aria-label="Disable voice"');
    expect(html).toContain('>Disable</button>');
    expect(html).toContain('aria-label="Remove voice key"');
    expect(html).toContain('Remove key');
    // A disable must not read as a delete: the toggle label is not the word "Remove".
    expect(html).not.toContain('aria-label="Remove voice"'); // (would be the toggle mislabeled)
  });

  test('configured but disabled: kill-switch state is legible and the toggle offers Enable', () => {
    const html = renderToStaticMarkup(<VoiceKeyCard isAdmin status={{ ...configured, enabled: false }} {...base} />);
    expect(html.toLowerCase()).toContain('turned off');
    expect(html).toContain('aria-label="Enable voice"');
    expect(html).toContain('>Enable</button>');
    // Remove is still present and still distinct — disabling did not collapse the two controls.
    expect(html).toContain('aria-label="Remove voice key"');
  });

  test('non-admin: a read-only status line, never a key field', () => {
    const html = renderToStaticMarkup(<VoiceKeyCard isAdmin={false} status={null} {...base} />);
    expect(html).toContain('configured by an organization admin');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('Remove key');
    expect(html).not.toContain('>Save</button>');
  });
});

describe('VoiceKeyCard — copy invariants', () => {
  test('the funding + attribution copy is present, plainly', () => {
    const html = renderToStaticMarkup(<VoiceKeyCard isAdmin status={{ configured: false }} {...base} />).toLowerCase();
    expect(html).toContain('funds every operator-tier member');
    expect(html).toContain('who started a session');
    expect(html).toContain('never what it spent');
  });

  test('NO dollar figure appears in any state (admin or not, error or clean)', () => {
    const states: Array<VoiceKeyStatus | null> = [null, { configured: false }, configured, { ...configured, enabled: false }];
    for (const status of states) {
      for (const isAdmin of [true, false]) {
        for (const error of [null, 'key rejected by provider']) {
          const html = renderToStaticMarkup(<VoiceKeyCard isAdmin={isAdmin} status={status} {...base} error={error} />);
          expect(html).not.toContain('$');
        }
      }
    }
  });
});

describe('VoiceKeyCard — error surfacing', () => {
  test("a rejected key surfaces the server's message and leaves the card in 'not configured'", () => {
    const html = renderToStaticMarkup(<VoiceKeyCard isAdmin status={{ configured: false }} {...base} error="key rejected by provider" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('key rejected by provider');
    // Still the unconfigured state — the input is present so the admin can retry.
    expect(html).toContain('type="password"');
  });
});

describe('putOrgVoiceKey — the key goes to the server and nowhere else', () => {
  test('sends the key in the request body, never to localStorage or the console', async () => {
    const SECRET = 'sk-shouldnotleak-9f3a';

    let capturedBody = '';
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      capturedBody = typeof init?.body === 'string' ? init.body : '';
      return new Response(JSON.stringify({ configured: true, last4: '9f3a', enabled: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const setItemCalls: unknown[][] = [];
    const hadLocalStorage = 'localStorage' in globalThis;
    const origLocalStorage = (globalThis as Record<string, unknown>).localStorage;
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => null,
      setItem: (...a: unknown[]) => setItemCalls.push(a),
      removeItem: () => {},
    };

    const consoleCalls: unknown[][] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const origConsole: Record<string, unknown> = {};
    for (const m of methods) {
      origConsole[m] = console[m];
      (console as unknown as Record<string, (...a: unknown[]) => void>)[m] = (...a: unknown[]) => consoleCalls.push(a);
    }

    try {
      const result = await putOrgVoiceKey(SECRET);
      expect(result.configured).toBe(true);
      // The key reached the server, exactly once, in the request body.
      expect(capturedBody).toContain(SECRET);
      // ...and nowhere else the module could have leaked it.
      for (const call of setItemCalls) expect(JSON.stringify(call)).not.toContain(SECRET);
      for (const call of consoleCalls) expect(JSON.stringify(call)).not.toContain(SECRET);
    } finally {
      globalThis.fetch = origFetch;
      for (const m of methods) (console as unknown as Record<string, unknown>)[m] = origConsole[m];
      if (hadLocalStorage) (globalThis as Record<string, unknown>).localStorage = origLocalStorage;
      else delete (globalThis as Record<string, unknown>).localStorage;
    }
  });
});
