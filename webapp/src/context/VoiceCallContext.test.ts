/**
 * `shouldEndCallForOrgSwitch` regression tests (plans/voice-db-mode/07-csp-and-org-switch.md).
 *
 * This package has no DOM/hook-render test harness (no `happy-dom`/jsdom, no
 * `@testing-library/react` — see `useVoiceDispatcher.test.ts`'s header for the fuller rationale),
 * so `VoiceCallContext.tsx` factors the org-switch DECISION out as a plain, exported,
 * framework-free function rather than something only observable by rendering the provider. These
 * tests exercise that exact function; the `useEffect` wiring around it (pinning at `startCall`,
 * re-reading `useAuth().me.activeOrganizationId` live, calling `endCall()` + `showToast`) is the
 * untested imperative shell the concern's Verify bullet calls out as needing a LIVE check instead
 * (a real org switch mid-call), not a unit test.
 */
import { describe, expect, test } from 'bun:test';
import { shouldEndCallForOrgSwitch } from './VoiceCallContext';

describe('shouldEndCallForOrgSwitch', () => {
  test('same org throughout: never ends the call', () => {
    expect(shouldEndCallForOrgSwitch('org-a', 'org-a')).toBe(false);
  });

  test('org changes mid-call: ends the call', () => {
    expect(shouldEndCallForOrgSwitch('org-a', 'org-b')).toBe(true);
  });

  test('org disappears mid-call (active org cleared): ends the call', () => {
    // A pinned org going to `null` is still a disagreement with the pinned value — the call was
    // minted against a specific org's key, and that org is no longer the active one.
    expect(shouldEndCallForOrgSwitch('org-a', null)).toBe(true);
  });

  test('file mode (both sides permanently null): never ends the call', () => {
    // File mode has no org concept at all — `me` is always null there, so both the pinned and the
    // live value are `null` for the entire life of the call.
    expect(shouldEndCallForOrgSwitch(null, null)).toBe(false);
  });

  test('no active org at call start, one appears mid-call: does not end the call', () => {
    // A call can only start once the resolver already found a usable key for SOME org (no active
    // org ⇒ no key ⇒ no voice button), so a `null` pinned value is not a state a real call reaches
    // in DB mode — but the function itself stays permissive here rather than guessing, since the
    // real-world trigger this concern cares about (DESIGN.md "Org switch mid-call" row) is a call
    // narrating under org A's token while dispatching into org B's fleet, which requires a
    // non-null pinned org to begin with.
    expect(shouldEndCallForOrgSwitch(null, 'org-a')).toBe(false);
  });
});
