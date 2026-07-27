/**
 * LoopMetersCard.test.tsx + sibling narrative-surface cards — static-render fixture coverage in the
 * DailyPanel.test.tsx idiom: `renderToStaticMarkup` runs no effects, so the pure/prop-driven blocks
 * are proven against fixtures (data, honest-empty, and error states) without any live fetch.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
// LoopMetersCard and EpisodesCard were rendered by the Daily panel and by nothing else. The weekly
// episode moved into MondaySurface under 05-first-week's own heading — WHAT IT NOW KNOWS THAT IT DID
// NOT ON MONDAY — because that is literally what an episode is; the loop meters did not, and their
// signal is now unrendered rather than mis-rendered. Said here so it is findable.
import { AfterActionList } from './AfterActionCard';
import type { AfterActionWire, SymptomWire } from '../lib/loop-meters';

const NOW = Date.UTC(2026, 6, 21, 12, 0, 0);


const meta: EpisodeMetaDTO = {
  id: '2026-W29',
  repo: '/srv/app',
  isoWeek: '2026-W29',
  windowStart: NOW - 7 * 86_400_000,
  windowEnd: NOW,
  generatedAt: NOW - 3_600_000,
  excerpt: 'The fleet landed 4 PRs and lost one to a gate flake.',
  digestCount: 12,
  hasStaleAnswers: true,
};


const aar: AfterActionWire = {
  id: 'ompsq-449-abc',
  name: 'ompsq-449',
  repo: '/srv/app',
  branch: 'feat/spine',
  terminalReason: 'CATASTROPHE: node "escalate" exceeded its visit cap (2)',
  terminalAt: NOW - 7_200_000,
  classification: 'environment',
  commitsAhead: 3,
  dirtyFiles: -1,
  markdown: '# What happened\nThe gate image was stale.',
  createdAt: NOW - 7_200_000,
};

describe('AfterActionList', () => {
  test('renders classification, terminal reason, and honest unknown dirty-state', () => {
    const html = renderToStaticMarkup(<AfterActionList reports={[aar]} now={NOW} />);
    expect(html).toContain('environment');
    expect(html).toContain('exceeded its visit cap');
    expect(html).toContain('3 commits ahead');
    expect(html).toContain('dirty state unknown'); // -1 never renders as a number
    expect(html).toContain('1 report');
  });
});

const symptom: SymptomWire = {
  id: 's1',
  symptom: 'daemon healthy but dispatch stalled',
  whereToLook: ['src/dispatch.ts', 'glance doctor'],
  repo: '/home/u/glance',
  landedAt: NOW - 60_000,
  fixedBy: { prNumber: 42 },
};

// The SymptomRows tests went with SymptomsCard, which was rendered by exactly one mount (the old Fog
// view) and by nothing after it was replaced. The symptom signal itself is still recorded and still
// worth a face — 03-machinery's "THE TWO TIMES HE SHOULD HAVE SPOKEN AND DID NOT" is the shape it
// wants — but a component nothing renders is not that face, and keeping it would have meant keeping
// a screen the designs replaced.
