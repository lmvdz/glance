/**
 * File mode's signed-out state.
 *
 * `/api/auth/mode` needs no token. So the SPA learned "this daemon is in file mode", concluded it was
 * signed in, and rendered the whole dashboard against a daemon that answered 401 to every authenticated
 * call. The operator saw an empty roster, zero projects, and an "Add project…" form whose only feedback
 * was the raw word `unauthorized`.
 *
 * An empty fleet and a rejected token look identical from the outside, and they are opposite problems. A
 * glance user's first question is "is anything running?" — the dashboard answering "nothing" when it means
 * "I can't see" is the worst answer it can give. Reported live: two registered projects, and the UI showed
 * none.
 */

import { expect, test } from 'bun:test';
import { fileModeStatus } from './AuthContext';

test('a token the daemon rejects is a signed-out state, not an empty fleet', () => {
  expect(fileModeStatus(401)).toBe('file-anon');
  expect(fileModeStatus(403)).toBe('file-anon');
});

test('a token the daemon accepts signs us in', () => {
  expect(fileModeStatus(200)).toBe('file');
});

/**
 * A daemon that is DOWN is not an authentication problem, and showing a sign-in screen for it would be a
 * second lie. The dashboard's own loading/error states own that case.
 */
test('an unreachable daemon does not masquerade as a sign-in problem', () => {
  expect(fileModeStatus(null)).toBe('file');
  expect(fileModeStatus(500)).toBe('file');
  expect(fileModeStatus(404)).toBe('file');
});
