import { describe, expect, test } from 'bun:test';
import {
  finalizeVoiceTurn,
  bindingBannerText,
  errorToastMessage,
  estimateCallCostUsd,
  formatCallCost,
  formatElapsed,
  nextPttUiState,
  reconnectNoticeText,
  shouldEndCall,
  shouldEndCallForIdle,
  shouldEndCallForMaxDuration,
  shouldForceReleaseForWatchdog,
  shouldShowPushNudge,
  voiceStateLabel,
  CALL_IDLE_TIMEOUT_MS,
  MAX_CALL_DURATION_MS,
  MAX_PTT_HOLD_MS,
  PUSH_NUDGE_TEXT,
  VOICE_COST_PER_MINUTE_USD_ESTIMATE,
  PTT_MIN_TURN_MS,
  PTT_TAP_THRESHOLD_MS,
} from './callHud';

describe('formatElapsed', () => {
  test('renders mm:ss, zero-padded seconds', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7_000)).toBe('0:07');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(3_661_000)).toBe('61:01');
  });

  test('never goes negative on a stale/skewed clock', () => {
    expect(formatElapsed(-500)).toBe('0:00');
  });
});

describe('estimateCallCostUsd / formatCallCost', () => {
  test('one minute at the default rate equals the rate itself', () => {
    expect(estimateCallCostUsd(60_000)).toBeCloseTo(VOICE_COST_PER_MINUTE_USD_ESTIMATE, 6);
  });

  test('scales linearly with elapsed time', () => {
    expect(estimateCallCostUsd(120_000)).toBeCloseTo(VOICE_COST_PER_MINUTE_USD_ESTIMATE * 2, 6);
  });

  test('formatCallCost prefixes a tilde — the "this is an estimate" signal', () => {
    expect(formatCallCost(0.15)).toBe('~$0.15');
    expect(formatCallCost(0)).toBe('~$0.00');
  });
});

describe('voiceStateLabel', () => {
  test('labels every phase, including the pre-connection pseudo-state', () => {
    expect(voiceStateLabel('connecting')).toBe('Connecting…');
    // "Listening" would be a lie — the mic is MUTED at idle (hot-mic privacy). The copy must not
    // teach the mute-toggle mental model that had operators talking into a dead mic.
    expect(voiceStateLabel('idle')).toBe('Muted — hold or tap to talk');
    expect(voiceStateLabel('userRecording')).toBe('Recording…');
    expect(voiceStateLabel('awaitingResponse')).toBe('Thinking…');
    expect(voiceStateLabel('speaking')).toBe('Speaking…');
    expect(voiceStateLabel('toolPending')).toBe('Working…');
  });
});

describe('finalizeVoiceTurn (spoken back-and-forth → durable chat Messages)', () => {
  test('an assistant turn persists as role:model', () => {
    expect(finalizeVoiceTurn({ speaker: 'assistant', text: 'On it — deploying now.' }, false)).toEqual({
      role: 'model',
      text: 'On it — deploying now.',
    });
  });

  test('a user turn persists as role:user, trimmed', () => {
    expect(finalizeVoiceTurn({ speaker: 'user', text: '  stop the deploy  ' }, false)).toEqual({ role: 'user', text: 'stop the deploy' });
  });

  test('a user turn already claimed by a prompt_agent dispatch persists NOTHING (the dispatcher wrote the clientTurnId-stamped copy)', () => {
    expect(finalizeVoiceTurn({ speaker: 'user', text: 'tell the agent to run the tests' }, true)).toBeNull();
  });

  test('a claimed turn only suppresses the USER side — the assistant still persists', () => {
    expect(finalizeVoiceTurn({ speaker: 'assistant', text: 'Telling the agent now.' }, true)).toEqual({
      role: 'model',
      text: 'Telling the agent now.',
    });
  });

  test('null and whitespace-only turns persist nothing', () => {
    expect(finalizeVoiceTurn(null, false)).toBeNull();
    expect(finalizeVoiceTurn({ speaker: 'user', text: '   ' }, false)).toBeNull();
  });
});

describe('bindingBannerText', () => {
  test('names the pinned session', () => {
    expect(bindingBannerText('Fix the flaky test')).toBe('voice → Fix the flaky test');
  });

  test('falls back to a generic label for an untitled/blank session', () => {
    expect(bindingBannerText('')).toBe('voice → this session');
    expect(bindingBannerText(undefined)).toBe('voice → this session');
    expect(bindingBannerText('   ')).toBe('voice → this session');
  });
});

describe('reconnectNoticeText', () => {
  test('pins the exact concern-doc wording when a recap rode along', () => {
    expect(reconnectNoticeText(true)).toBe('Reconnected — recapping context.');
  });

  test('is honest when there was nothing to recap', () => {
    expect(reconnectNoticeText(false)).toBe('Reconnected.');
  });
});

describe('shouldShowPushNudge (voice-loop concern 05: notification-permission nudge)', () => {
  test('pins the exact nudge copy so this file and the concern doc can never quietly drift apart', () => {
    expect(PUSH_NUDGE_TEXT).toBe('Enable notifications to get pinged when agents finish');
  });

  test('shows only for "default" (never asked) permission, undismissed', () => {
    expect(shouldShowPushNudge('default', false)).toBe(true);
  });

  test('a per-call dismiss hides it even while permission is still "default"', () => {
    expect(shouldShowPushNudge('default', true)).toBe(false);
  });

  test('granted permission hides it — nothing left to nudge toward', () => {
    expect(shouldShowPushNudge('granted', false)).toBe(false);
    expect(shouldShowPushNudge('granted', true)).toBe(false);
  });

  test('denied permission hides it — the browser said no, don\'t re-prompt', () => {
    expect(shouldShowPushNudge('denied', false)).toBe(false);
    expect(shouldShowPushNudge('denied', true)).toBe(false);
  });

  test('unsupported (no Notification API) hides it — nothing to ask', () => {
    expect(shouldShowPushNudge('unsupported', false)).toBe(false);
    expect(shouldShowPushNudge('unsupported', true)).toBe(false);
  });
});

describe('errorToastMessage', () => {
  test('every known error code gets a distinct, human message', () => {
    const messages = new Set([
      errorToastMessage('mic-denied'),
      errorToastMessage('mint-failed'),
      errorToastMessage('mint-rate-limited'),
      errorToastMessage('connect-failed'),
      errorToastMessage('reconnect-failed'),
    ]);
    expect(messages.size).toBe(5); // no two codes collapse to the same copy
    expect(errorToastMessage('mic-denied')).toContain('Microphone');
    expect(errorToastMessage('reconnect-failed')).toContain('falling back to text');
    // The org mint-cap message must name the limit, not read as a generic transient failure.
    expect(errorToastMessage('mint-rate-limited')).toContain('limit');
    expect(errorToastMessage('mint-rate-limited')).not.toBe(errorToastMessage('mint-failed'));
  });
});

describe('nextPttUiState', () => {
  test('a real hold: press on down, release on up', () => {
    const down = nextPttUiState('idle', 'down', 0);
    expect(down).toEqual({ mode: 'holding', action: 'press' });
    const up = nextPttUiState(down.mode, 'up', PTT_TAP_THRESHOLD_MS + 50);
    expect(up).toEqual({ mode: 'idle', action: 'release' });
  });

  test('a quick tap locks recording on without releasing', () => {
    const down = nextPttUiState('idle', 'down', 0);
    const up = nextPttUiState(down.mode, 'up', PTT_TAP_THRESHOLD_MS - 50);
    expect(up).toEqual({ mode: 'locked', action: 'none' });
  });

  test('a second tap while locked (after a plausibly-spoken engagement) releases and returns to idle', () => {
    const secondDown = nextPttUiState('locked', 'down', PTT_MIN_TURN_MS + 700);
    expect(secondDown).toEqual({ mode: 'idle', action: 'release' });
  });

  // Empty-turn rule (live bug, 2026-07-15): a released engagement too short to contain speech must
  // ABORT (discard) rather than commit room tone + response.create — the model would answer thin
  // air by re-answering the PREVIOUS context ("it immediately said the same thing again"), with the
  // mic freshly re-muted under the operator mid-sentence.
  test('empty-turn rule: a double-click — the second down landing on locked inside the min-turn window — aborts, never sends', () => {
    const secondDown = nextPttUiState('locked', 'down', PTT_MIN_TURN_MS - 100);
    expect(secondDown).toEqual({ mode: 'idle', action: 'abort' });
  });

  test('an "up" while idle or locked (pointerleave echo) is a no-op', () => {
    expect(nextPttUiState('idle', 'up', 1_000)).toEqual({ mode: 'idle', action: 'none' });
    expect(nextPttUiState('locked', 'up', 1_000)).toEqual({ mode: 'locked', action: 'none' });
  });

  test('a stray "down" while already holding is a no-op (not a double-press)', () => {
    expect(nextPttUiState('holding', 'down', 10)).toEqual({ mode: 'holding', action: 'none' });
  });

  test('exactly at the tap threshold reads as a real hold (boundary is inclusive of "hold")', () => {
    const down = nextPttUiState('idle', 'down', 0);
    const up = nextPttUiState(down.mode, 'up', PTT_TAP_THRESHOLD_MS);
    expect(up).toEqual({ mode: 'idle', action: 'release' });
  });

  // MINOR-6: pointerleave (finger/mouse sliding off the button mid-press) must always END the
  // engagement from 'holding' — never a potential tap-to-lock, even when the elapsed time is short
  // (a quick press-then-slide-off looks identical, in timing terms, to a genuine quick tap).
  // Empty-turn rule refinement: a slide-off inside the min-turn window (pointer drift during a
  // click) aborts — committing it would send room tone and make the model repeat itself.
  describe('"leave" event (MINOR-6: ends the engagement, never a lock)', () => {
    test('a quick slide-off while holding ends the engagement as an ABORT, NOT a lock and NOT a send', () => {
      const down = nextPttUiState('idle', 'down', 0);
      expect(down).toEqual({ mode: 'holding', action: 'press' });
      const leave = nextPttUiState(down.mode, 'leave', PTT_MIN_TURN_MS - 50);
      expect(leave).toEqual({ mode: 'idle', action: 'abort' });
    });

    test('a slow slide-off while holding releases (mid-dictation drift still sends what was said)', () => {
      const leave = nextPttUiState('holding', 'leave', PTT_MIN_TURN_MS + 500);
      expect(leave).toEqual({ mode: 'idle', action: 'release' });
    });

    test('"leave" while already locked is a no-op — a locked recording is a deliberate toggle that must survive the pointer moving away', () => {
      expect(nextPttUiState('locked', 'leave', 1_000)).toEqual({ mode: 'locked', action: 'none' });
    });

    test('"leave" while idle is a no-op', () => {
      expect(nextPttUiState('idle', 'leave', 1_000)).toEqual({ mode: 'idle', action: 'none' });
    });
  });

  // HIGH-3: 'forceRelease' (pointercancel / window blur / document visibilitychange / the watchdog)
  // must release from BOTH 'holding' and 'locked' — unlike 'leave', which deliberately leaves a
  // locked recording alone. A locked recording surviving the pointer sliding off the button is the
  // point of "lock"; surviving the operator tabbing away entirely (or the OS cancelling the
  // gesture) is a hot mic with nobody watching the HUD.
  describe('"forceRelease" event (HIGH-3: forces the engagement closed out of locked too)', () => {
    test('ends a short "holding" engagement as an abort (blur right after press — nothing was said)', () => {
      expect(nextPttUiState('holding', 'forceRelease', 10)).toEqual({ mode: 'idle', action: 'abort' });
    });

    test('forces a release from "locked" past the min-turn window — unlike "leave", which is a no-op here', () => {
      expect(nextPttUiState('locked', 'forceRelease', 10_000)).toEqual({ mode: 'idle', action: 'release' });
    });

    test('the 60s watchdog fires well past the min-turn window, so it always commits (never silently discards a dictation)', () => {
      expect(nextPttUiState('locked', 'forceRelease', MAX_PTT_HOLD_MS)).toEqual({ mode: 'idle', action: 'release' });
    });

    test('a no-op from "idle" (nothing engaged to release)', () => {
      expect(nextPttUiState('idle', 'forceRelease', 10)).toEqual({ mode: 'idle', action: 'none' });
    });
  });
});

describe('shouldForceReleaseForWatchdog (HIGH-3: max-hold backstop)', () => {
  test('never fires from idle, regardless of elapsed time', () => {
    expect(shouldForceReleaseForWatchdog('idle', 10 * MAX_PTT_HOLD_MS)).toBe(false);
  });

  test('does not fire before the max hold duration, from either engaged mode', () => {
    expect(shouldForceReleaseForWatchdog('holding', MAX_PTT_HOLD_MS - 1)).toBe(false);
    expect(shouldForceReleaseForWatchdog('locked', MAX_PTT_HOLD_MS - 1)).toBe(false);
  });

  test('fires at/after the max hold duration, from either engaged mode', () => {
    expect(shouldForceReleaseForWatchdog('holding', MAX_PTT_HOLD_MS)).toBe(true);
    expect(shouldForceReleaseForWatchdog('locked', MAX_PTT_HOLD_MS + 5_000)).toBe(true);
  });

  test('honors a custom threshold', () => {
    expect(shouldForceReleaseForWatchdog('holding', 5_000, 10_000)).toBe(false);
    expect(shouldForceReleaseForWatchdog('holding', 10_000, 10_000)).toBe(true);
  });
});

describe('shouldEndCall (MEDIUM-4: honor fallbackToText, plus always-terminal codes)', () => {
  test('mic-denied always ends the call, even without an explicit fallbackToText flag', () => {
    expect(shouldEndCall({ code: 'mic-denied' })).toBe(true);
    expect(shouldEndCall({ code: 'mic-denied', fallbackToText: false })).toBe(true);
  });

  test('reconnect-failed always ends the call (belt-and-braces — every call site also sets fallbackToText)', () => {
    expect(shouldEndCall({ code: 'reconnect-failed' })).toBe(true);
  });

  test('mint-failed / connect-failed do NOT end the call unless fallbackToText is explicitly set', () => {
    expect(shouldEndCall({ code: 'mint-failed' })).toBe(false);
    expect(shouldEndCall({ code: 'connect-failed' })).toBe(false);
  });

  test('an explicit fallbackToText ends the call regardless of code', () => {
    expect(shouldEndCall({ code: 'connect-failed', fallbackToText: true })).toBe(true);
    expect(shouldEndCall({ code: 'mint-failed', fallbackToText: true })).toBe(true);
  });
});

describe('shouldEndCallForMaxDuration / shouldEndCallForIdle (MEDIUM-6: idle/max-duration spend cap)', () => {
  test('max duration: does not fire before the cap, fires at/after it', () => {
    expect(shouldEndCallForMaxDuration(MAX_CALL_DURATION_MS - 1)).toBe(false);
    expect(shouldEndCallForMaxDuration(MAX_CALL_DURATION_MS)).toBe(true);
    expect(shouldEndCallForMaxDuration(MAX_CALL_DURATION_MS + 60_000)).toBe(true);
  });

  test('max duration honors a custom cap', () => {
    expect(shouldEndCallForMaxDuration(59 * 60_000, 60 * 60_000)).toBe(false);
    expect(shouldEndCallForMaxDuration(60 * 60_000, 60 * 60_000)).toBe(true);
  });

  test('idle: does not fire before the timeout, fires at/after it', () => {
    expect(shouldEndCallForIdle(CALL_IDLE_TIMEOUT_MS - 1)).toBe(false);
    expect(shouldEndCallForIdle(CALL_IDLE_TIMEOUT_MS)).toBe(true);
  });

  test('idle honors a custom timeout', () => {
    expect(shouldEndCallForIdle(4 * 60_000, 5 * 60_000)).toBe(false);
    expect(shouldEndCallForIdle(5 * 60_000, 5 * 60_000)).toBe(true);
  });
});

  // Audit finding (voice-loop branch): the 60s watchdog ABORTS — a forgotten lock must never
  // transmit a minute of ambient room audio; committing is for interactive force-releases only.
  describe('"watchdogExpire" event (privacy backstop: always abort, never commit)', () => {
    test('aborts from "holding" and "locked" regardless of engagement length', () => {
      expect(nextPttUiState('holding', 'watchdogExpire', MAX_PTT_HOLD_MS)).toEqual({ mode: 'idle', action: 'abort' });
      expect(nextPttUiState('locked', 'watchdogExpire', MAX_PTT_HOLD_MS)).toEqual({ mode: 'idle', action: 'abort' });
    });

    test('a no-op from "idle"', () => {
      expect(nextPttUiState('idle', 'watchdogExpire', MAX_PTT_HOLD_MS)).toEqual({ mode: 'idle', action: 'none' });
    });
  });
