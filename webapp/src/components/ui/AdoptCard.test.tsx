/**
 * AdoptCard (daily-onramp 06) — the "ad-hoc session detected" row. Static-render coverage of the
 * three states that matter: the offer (harness + session + repo + one wired Adopt action), the
 * in-flight disable, and the identity fields the click hands back to the owner.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdoptCard } from './AdoptCard';
import type { AdoptableSession } from '../../lib/adoptPromote';

const session: AdoptableSession = {
  claimId: 'harness-abc123def456abc123def456',
  harness: 'claude',
  sessionId: 'f00dfeed-1234-5678-9abc-def012345678',
  cwd: '/home/u/proj',
  repoName: 'proj',
  branch: 'main',
  operator: 'lars',
  heartbeat: Date.now() - 30_000,
  label: 'claude:f00dfeed-1234-5678-9abc-def012345678',
};

describe('AdoptCard', () => {
  test('names the harness, a short session id, the repo/branch, and one Adopt action', () => {
    const html = renderToStaticMarkup(<AdoptCard session={session} onAdopt={() => {}} />);
    expect(html).toContain('claude session');
    expect(html).toContain('f00dfeed…'); // shortened, not the full UUID
    expect(html).toContain('proj');
    expect(html).toContain('main');
    expect(html).toContain('running outside glance');
    expect(html).toContain('Adopt');
    expect(html).not.toContain('disabled=""');
    // The full label survives for hover/screen-reader identity.
    expect(html).toContain(`Adopt ${session.label} into glance`);
  });

  test('busy disables (not hides) the action and says so', () => {
    const html = renderToStaticMarkup(<AdoptCard session={session} busy onAdopt={() => {}} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain('Adopting…');
  });
});
