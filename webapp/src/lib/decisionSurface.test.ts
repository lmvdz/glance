import { describe, expect, it } from 'bun:test';
import type { TaskDecision } from '../types';
import {
  splitDecisions,
  isSuperseded,
  shouldCollapseSuperseded,
  SUPERSEDED_INLINE_MAX,
  decisionSourceLabel,
  decisionAge,
  decisionsEmptyState,
  criteriaEmptyState,
  criteriaHeadline,
  validateSupersedeText,
  supersedeFailureMessage,
  submitSupersede,
  runSupersedeSubmit,
  type InFlightRef,
} from './decisionSurface';

function decision(over: Partial<TaskDecision>): TaskDecision {
  return { id: 'd1', text: 'text', ...over };
}

describe('splitDecisions', () => {
  it('puts decisions with no supersededBy in current, the rest in superseded', () => {
    const decisions = [
      decision({ id: 'a', supersededBy: undefined }),
      decision({ id: 'b', supersededBy: 'c' }),
      decision({ id: 'c' }),
    ];
    const { current, superseded } = splitDecisions(decisions);
    expect(current.map((d) => d.id).sort()).toEqual(['a', 'c']);
    expect(superseded.map((d) => d.id)).toEqual(['b']);
  });

  it('sorts each group newest first by createdAt', () => {
    const decisions = [
      decision({ id: 'old', createdAt: 1 }),
      decision({ id: 'new', createdAt: 3 }),
      decision({ id: 'mid', createdAt: 2 }),
    ];
    expect(splitDecisions(decisions).current.map((d) => d.id)).toEqual(['new', 'mid', 'old']);
  });

  it('sinks decisions with no createdAt to the end rather than guessing them as newest', () => {
    const decisions = [
      decision({ id: 'no-date' }),
      decision({ id: 'dated', createdAt: 100 }),
    ];
    expect(splitDecisions(decisions).current.map((d) => d.id)).toEqual(['dated', 'no-date']);
  });

  it('returns empty groups for an empty ledger', () => {
    expect(splitDecisions([])).toEqual({ current: [], superseded: [] });
  });

  // Invariant I2: the split is a partition, never a filter that can lose or duplicate a decision.
  it('partitions every seeded decision exactly once across current+superseded — nothing dropped, nothing duplicated (I2)', () => {
    const decisions = [
      decision({ id: 'a' }),
      decision({ id: 'b', supersededBy: 'z' }),
      decision({ id: 'c', createdAt: 5 }),
      decision({ id: 'd', supersededBy: 'a', createdAt: 1 }),
      decision({ id: 'e', supersededBy: '' }),
    ];
    const { current, superseded } = splitDecisions(decisions);
    const seenIds = [...current, ...superseded].map((d) => d.id).sort();
    expect(seenIds).toEqual(decisions.map((d) => d.id).sort());
    expect(new Set(seenIds).size).toBe(decisions.length);
  });

  // Junk-graph safety: splitDecisions never resolves supersededBy against other decisions' ids, so a
  // dangling or self-referential pointer can neither throw nor make the decision vanish.
  it('does not throw and does not drop a decision whose supersededBy names an id that does not exist on the feature', () => {
    const decisions = [decision({ id: 'orphan', supersededBy: 'ghost-id-not-on-this-feature', createdAt: 1 })];
    expect(() => splitDecisions(decisions)).not.toThrow();
    const { current, superseded } = splitDecisions(decisions);
    expect(current).toHaveLength(0);
    expect(superseded.map((d) => d.id)).toEqual(['orphan']);
  });

  it('does not throw and does not drop a decision with a self-referential supersededBy', () => {
    const decisions = [decision({ id: 'self-ref', supersededBy: 'self-ref', createdAt: 1 })];
    expect(() => splitDecisions(decisions)).not.toThrow();
    const { current, superseded } = splitDecisions(decisions);
    expect(current).toHaveLength(0);
    expect(superseded.map((d) => d.id)).toEqual(['self-ref']);
  });
});

describe('isSuperseded', () => {
  it('treats undefined and empty-string supersededBy as NOT superseded', () => {
    expect(isSuperseded({ supersededBy: undefined })).toBe(false);
    expect(isSuperseded({ supersededBy: '' })).toBe(false);
  });

  it('treats any non-empty supersededBy as superseded, including a dangling or self-referential id', () => {
    expect(isSuperseded({ supersededBy: 'some-id' })).toBe(true);
    expect(isSuperseded({ supersededBy: 'ghost-id-not-on-this-feature' })).toBe(true);
  });
});

describe('shouldCollapseSuperseded', () => {
  it('does not collapse a small history', () => {
    expect(SUPERSEDED_INLINE_MAX).toBe(2);
    expect(shouldCollapseSuperseded(0)).toBe(false);
    expect(shouldCollapseSuperseded(2)).toBe(false);
  });

  it('collapses once history grows past the inline max', () => {
    expect(shouldCollapseSuperseded(3)).toBe(true);
    expect(shouldCollapseSuperseded(10)).toBe(true);
  });
});

describe('decisionSourceLabel', () => {
  it('labels each known source', () => {
    expect(decisionSourceLabel('plan')).toBe('plan');
    expect(decisionSourceLabel('human')).toBe('human');
    expect(decisionSourceLabel('agent')).toBe('agent');
    expect(decisionSourceLabel('model-delta')).toBe('model delta');
  });

  it('reads an absent source as "recorded", never a fabricated one', () => {
    expect(decisionSourceLabel(undefined)).toBe('recorded');
  });
});

describe('decisionAge', () => {
  const now = 1_700_000_000_000;

  it('returns undefined when there is no createdAt to read', () => {
    expect(decisionAge(undefined, now)).toBeUndefined();
  });

  it('reads sub-minute ages as "moments ago"', () => {
    expect(decisionAge(now - 5_000, now)).toBe('moments ago');
  });

  it('reads minutes, hours, and days at the right thresholds', () => {
    expect(decisionAge(now - 5 * 60_000, now)).toBe('5m ago');
    expect(decisionAge(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(decisionAge(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});

describe('decisionsEmptyState', () => {
  it('states a first visit, not a quiet stretch, matching the house voice', () => {
    const text = decisionsEmptyState();
    expect(text).toContain('first visit');
    expect(text).toContain('ever removed, only superseded');
  });
});

describe('criteriaEmptyState / criteriaHeadline', () => {
  it('names the empty case as an absence, not a bare 0-of-0', () => {
    expect(criteriaHeadline([])).toBe(criteriaEmptyState());
    expect(criteriaEmptyState()).toContain('absence');
  });

  it('rolls up partial completion plainly', () => {
    expect(criteriaHeadline([{ completed: true }, { completed: false }, { completed: false }])).toBe('1 of 3 met.');
  });

  it('says "all" once everything is complete', () => {
    expect(criteriaHeadline([{ completed: true }, { completed: true }])).toBe('All 2 met.');
  });

  it('reads zero-of-N through the same "N of M met" shape, not a special case', () => {
    expect(criteriaHeadline([{ completed: false }, { completed: false }])).toBe('0 of 2 met.');
  });
});

describe('validateSupersedeText', () => {
  it('refuses empty text with a reason', () => {
    expect(validateSupersedeText('')).toBeDefined();
    expect(validateSupersedeText('')).toContain('replacement');
  });

  it('refuses whitespace-only text with a reason', () => {
    expect(validateSupersedeText('   \n\t  ')).toBeDefined();
  });

  it('accepts real text', () => {
    expect(validateSupersedeText('use postgres instead')).toBeUndefined();
  });
});

describe('supersedeFailureMessage', () => {
  // The route's own text already IS the "steer to what's current" copy — surfaced verbatim, not
  // collapsed into a generic conflict message.
  it('surfaces a 409 "already superseded" server message verbatim, steering to the current decision', () => {
    const serverText = 'decision "abc123" was already superseded — supersede the current decision instead';
    expect(supersedeFailureMessage(409, serverText)).toBe(serverText);
  });

  it('surfaces a 409 "supersedes target not found" server message verbatim', () => {
    const serverText = 'supersedes target "ghost" not found on this feature';
    expect(supersedeFailureMessage(409, serverText)).toBe(serverText);
  });

  it('surfaces a 409 "duplicate" server message verbatim', () => {
    const serverText = 'an identical decision is already current — no change';
    expect(supersedeFailureMessage(409, serverText)).toBe(serverText);
  });

  it('falls back to an honest specific 409 message only when the server sent no text', () => {
    expect(supersedeFailureMessage(409, '')).toContain('reload');
    expect(supersedeFailureMessage(409, undefined)).toContain('reload');
  });

  it('surfaces the route\'s actual 404 body ("no such feature") verbatim', () => {
    expect(supersedeFailureMessage(404, 'no such feature')).toBe('no such feature');
  });

  it('falls back to an honest specific 404 message only when the server sent no text', () => {
    expect(supersedeFailureMessage(404, undefined)).toContain('could not be found');
  });

  it('surfaces the route\'s actual 400 body verbatim', () => {
    expect(supersedeFailureMessage(400, 'text and supersedes (decision id) required')).toBe('text and supersedes (decision id) required');
  });

  it('falls back to an honest specific 400 message only when the server sent no text', () => {
    expect(supersedeFailureMessage(400, undefined)).toContain('replacement');
  });

  it('gives an honest fallback for an unrecognized/network failure', () => {
    expect(supersedeFailureMessage(undefined, undefined)).toContain('not recorded');
  });
});

describe('submitSupersede', () => {
  function decision(over: Partial<TaskDecision>): TaskDecision {
    return { id: 'd1', text: 'text', ...over };
  }

  it('never calls postSupersede for empty text — refused before any request', async () => {
    let called = false;
    const result = await submitSupersede({
      text: '',
      decisionId: 'd1',
      postSupersede: async () => {
        called = true;
        return decision({ id: 'new' });
      },
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toBeDefined();
  });

  it('never calls postSupersede for whitespace-only text — refused before any request', async () => {
    let called = false;
    const result = await submitSupersede({
      text: '   ',
      decisionId: 'd1',
      postSupersede: async () => {
        called = true;
        return decision({ id: 'new' });
      },
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('trims text before sending it to postSupersede', async () => {
    let sentText: string | undefined;
    await submitSupersede({
      text: '  use postgres  ',
      decisionId: 'd1',
      postSupersede: async (input) => {
        sentText = input.text;
        return decision({ id: 'new', text: input.text });
      },
    });
    expect(sentText).toBe('use postgres');
  });

  it('returns ok:true with the SERVER-returned decision on success — never a locally-fabricated one', async () => {
    const serverDecision = decision({ id: 'server-minted', text: 'use postgres' });
    const result = await submitSupersede({
      text: 'use postgres',
      decisionId: 'd1',
      postSupersede: async () => serverDecision,
    });
    expect(result.ok).toBe(true);
    expect(result.decision).toBe(serverDecision);
  });

  it('maps a rejected postSupersede carrying a 409 status into that status\'s specific message', async () => {
    const apiLikeError = Object.assign(new Error('decision "d1" was already superseded — supersede the current decision instead'), { status: 409 });
    const result = await submitSupersede({
      text: 'use postgres',
      decisionId: 'd1',
      postSupersede: async () => {
        throw apiLikeError;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('decision "d1" was already superseded — supersede the current decision instead');
  });

  it('maps a rejected postSupersede carrying a 404 status into the server\'s "no such feature" message', async () => {
    const apiLikeError = Object.assign(new Error('no such feature'), { status: 404 });
    const result = await submitSupersede({
      text: 'use postgres',
      decisionId: 'd1',
      postSupersede: async () => {
        throw apiLikeError;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('no such feature');
  });

  it('never throws — a network failure with no status still resolves to an ok:false result', async () => {
    const result = await submitSupersede({
      text: 'use postgres',
      decisionId: 'd1',
      postSupersede: async () => {
        throw new Error('network down');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBeDefined();
  });
});

describe('runSupersedeSubmit (double-submit guard)', () => {
  function decision(over: Partial<TaskDecision>): TaskDecision {
    return { id: 'd1', text: 'text', ...over };
  }

  /** Records every value each setter was called with, in order — so a test can assert not just
   *  the FINAL state but the exact sequence a real re-render would have driven the UI through. */
  function recordingDeps() {
    const submittingCalls: boolean[] = [];
    const succeededCalls: boolean[] = [];
    const errorCalls: (string | undefined)[] = [];
    let reloadCount = 0;
    return {
      submittingCalls,
      succeededCalls,
      errorCalls,
      getReloadCount: () => reloadCount,
      setSubmitting: (v: boolean) => submittingCalls.push(v),
      setSucceeded: (v: boolean) => succeededCalls.push(v),
      setError: (v: string | undefined) => errorCalls.push(v),
      onSuperseded: () => {
        reloadCount++;
      },
    };
  }

  it('a second call issued before the first resolves never reaches postSupersede — only ONE network call is ever made', async () => {
    let calls = 0;
    let resolveFirst: (d: TaskDecision) => void = () => {};
    const postSupersede = () =>
      new Promise<TaskDecision>((resolve) => {
        calls++;
        resolveFirst = resolve;
      });
    const inFlightRef: InFlightRef = { current: false };
    const deps = recordingDeps();

    // Simulates a rapid double-click (or Enter held): the second call happens synchronously,
    // before the first request has resolved — the exact race a `submitting` STATE check alone
    // cannot close, since both calls would read `submitting`'s stale pre-update value.
    const first = runSupersedeSubmit({ text: 'use postgres', decisionId: 'd1', postSupersede, inFlightRef, ...deps });
    const second = runSupersedeSubmit({ text: 'use postgres', decisionId: 'd1', postSupersede, inFlightRef, ...deps });

    expect(calls).toBe(1);
    expect(inFlightRef.current).toBe(true);
    // The second call returned synchronously without ever touching `setSubmitting` again.
    expect(deps.submittingCalls).toEqual([true]);
    expect(second).toBeUndefined();

    resolveFirst(decision({ id: 'new' }));
    await first;

    expect(calls).toBe(1);
    expect(deps.getReloadCount()).toBe(1);
    expect(deps.succeededCalls).toEqual([true]);
    expect(deps.errorCalls).toEqual([]);
  });

  it('releases the guard on failure so a genuine retry can go through', async () => {
    const inFlightRef: InFlightRef = { current: false };
    let calls = 0;
    const deps = recordingDeps();
    const failOnce = () => {
      calls++;
      return calls === 1
        ? Promise.reject(Object.assign(new Error('an identical decision is already current — no change'), { status: 409 }))
        : Promise.resolve(decision({ id: 'new' }));
    };

    await runSupersedeSubmit({ text: 'use postgres', decisionId: 'd1', postSupersede: failOnce, inFlightRef, ...deps });
    expect(inFlightRef.current).toBe(false);
    expect(deps.errorCalls).toEqual(['an identical decision is already current — no change']);
    expect(deps.getReloadCount()).toBe(0);

    // The retry is a genuinely NEW call, not blocked by a guard left over from the failed attempt.
    await runSupersedeSubmit({ text: 'use postgres', decisionId: 'd1', postSupersede: failOnce, inFlightRef, ...deps });
    expect(calls).toBe(2);
    expect(deps.succeededCalls).toEqual([true]);
    expect(deps.getReloadCount()).toBe(1);
  });

  it('never releases the guard on success — it stays set for the life of the caller, not just through the await', async () => {
    const inFlightRef: InFlightRef = { current: false };
    const deps = recordingDeps();
    await runSupersedeSubmit({
      text: 'use postgres',
      decisionId: 'd1',
      postSupersede: async () => decision({ id: 'new' }),
      inFlightRef,
      ...deps,
    });
    expect(inFlightRef.current).toBe(true);
    // A THIRD call after the guard is set post-success still never reaches the network.
    let calledAgain = false;
    const result = runSupersedeSubmit({
      text: 'use postgres',
      decisionId: 'd1',
      postSupersede: async () => {
        calledAgain = true;
        return decision({ id: 'newer' });
      },
      inFlightRef,
      ...deps,
    });
    expect(result).toBeUndefined();
    expect(calledAgain).toBe(false);
  });

  it('never calls postSupersede for empty text — the guard is still released so the person can correct it and retry', async () => {
    const inFlightRef: InFlightRef = { current: false };
    let called = false;
    const deps = recordingDeps();
    await runSupersedeSubmit({
      text: '   ',
      decisionId: 'd1',
      postSupersede: async () => {
        called = true;
        return decision({ id: 'new' });
      },
      inFlightRef,
      ...deps,
    });
    expect(called).toBe(false);
    expect(inFlightRef.current).toBe(false);
    expect(deps.errorCalls.length).toBe(1);
  });
});
