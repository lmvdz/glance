/**
 * LoopMetersCard.test.tsx + sibling narrative-surface cards — static-render fixture coverage in the
 * DailyPanel.test.tsx idiom: `renderToStaticMarkup` runs no effects, so the pure/prop-driven blocks
 * are proven against fixtures (data, honest-empty, and error states) without any live fetch.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoopMetersCard } from './LoopMetersCard';
import { EpisodesCard } from './EpisodesCard';
import { AfterActionList } from './AfterActionCard';
import { SymptomRows } from './SymptomsCard';
import type { AfterActionWire, SymptomWire } from '../lib/loop-meters';
import type { EpisodeMetaDTO } from '../lib/api';

const NOW = Date.UTC(2026, 6, 21, 12, 0, 0);

describe('LoopMetersCard', () => {
  test('renders on/off flag chips and meter rows with sample counts', () => {
    const html = renderToStaticMarkup(
      <LoopMetersCard
        loop={{
          flags: { failureMemory: 'on', modelOutcomes: 'off' },
          rollup: [{ name: 'first-try-green', count: 8, sum: 6, avg: 0.75 }],
        }}
        loaded
      />,
    );
    expect(html).toContain('Failure memory');
    expect(html).toContain('Model outcomes');
    expect(html).toContain('1/2 on');
    expect(html).toContain('First-try green');
    expect(html).toContain('75%');
    expect(html).toContain('n=8'); // a rate never renders without its sample size
  });

  test('empty rollup is an honest blank, not a zero', () => {
    const html = renderToStaticMarkup(<LoopMetersCard loop={{ flags: { failureMemory: 'on' }, rollup: [] }} loaded />);
    expect(html).toContain('No metric samples');
    expect(html).not.toContain('0%');
  });

  test('error state renders the alert', () => {
    const html = renderToStaticMarkup(<LoopMetersCard loop={null} loaded error="Could not reach the daemon for learning-loop meters." />);
    expect(html).toContain('Could not reach the daemon');
  });
});

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

describe('EpisodesCard', () => {
  test('lists metas with week id, digest count, and the stale-answers badge', () => {
    const html = renderToStaticMarkup(<EpisodesCard episodes={[meta]} loaded now={NOW} />);
    expect(html).toContain('2026-W29');
    expect(html).toContain('12 digests');
    expect(html).toContain('stale answers');
    expect(html).toContain('The fleet landed 4 PRs');
  });

  test('empty state explains where episodes come from', () => {
    const html = renderToStaticMarkup(<EpisodesCard episodes={[]} loaded now={NOW} />);
    expect(html).toContain('No episodes yet');
    expect(html).toContain('one brief per week');
  });
});

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

describe('SymptomRows', () => {
  test('renders the symptom phrasing, where-to-look chips, repo basename, and the fixed-by badge', () => {
    const html = renderToStaticMarkup(<SymptomRows symptoms={[symptom]} now={NOW} />);
    expect(html).toContain('dispatch stalled');
    expect(html).toContain('src/dispatch.ts');
    expect(html).toContain('glance doctor');
    expect(html).toContain('fixed by #42');
    expect(html).toContain('>glance<'); // basename, not the full path, as the visible label
  });
});
