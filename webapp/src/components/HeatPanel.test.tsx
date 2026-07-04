/**
 * HeatPanel tests — DOM-free (renderToStaticMarkup) as per project convention.
 *
 * We test the two pure logic functions (detectCollisions, churnHotspots) and
 * then snapshot-check the panel's rendered output for the key surface areas:
 * collision callout, churn callout, calm empty state, heat grid, raw data
 * details. We do NOT test polling or fetch — those are integration concerns.
 */

import { expect, test, describe } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { detectCollisions, churnHotspots, flappingAgents, type UsageRun, type HeatPayload } from '../lib/insights';
import type { AgentDTO } from '../lib/dto';
import { FlappingAgentsCallout } from './HeatPanel';

// ────────────────────────────────── fixtures ──────────────────────────────────

function agent(id: string, status: AgentDTO['status'] = 'working', extra: Partial<AgentDTO> = {}): AgentDTO {
  return {
    id,
    name: `Agent ${id}`,
    status,
    repo: '/repo',
    worktree: '/wt',
    pending: [],
    lastActivity: 0,
    messageCount: 0,
    ...extra,
  } as AgentDTO;
}

function run(agentId: string, files: string[], status = 'working'): UsageRun {
  return { agentId, name: `Agent ${agentId}`, repo: '/repo', status, filesTouched: files };
}

const HEAT_PAYLOAD: HeatPayload = {
  days: ['2026-06-20', '2026-06-21', '2026-06-22', '2026-06-23', '2026-06-24', '2026-06-25', '2026-06-26', '2026-06-27'],
  tree: [
    { id: 'src/auth/token.ts', heat: [0, 1, 3, 2, 4, 5, 6, 2] },
    { id: 'src/api/routes.ts', heat: [1, 0, 0, 1, 2, 0, 3, 1] },
    { id: 'src/db/schema.ts', heat: [2, 1, 0, 0, 0, 1, 0, 0] },
  ],
};

// ────────────────────────────────── detectCollisions ──────────────────────────

describe('detectCollisions', () => {
  test('returns empty when no live agents', () => {
    const runs = [run('a1', ['foo.ts']), run('a2', ['foo.ts'])];
    expect(detectCollisions(runs, [])).toEqual([]);
  });

  test('returns empty when only one live agent touches a file', () => {
    const runs = [run('a1', ['foo.ts'])];
    const agents = [agent('a1', 'working')];
    expect(detectCollisions(runs, agents)).toEqual([]);
  });

  test('detects two live agents on the same file', () => {
    const runs = [run('a1', ['src/auth.ts', 'src/db.ts']), run('a2', ['src/auth.ts'])];
    const agents = [agent('a1', 'working'), agent('a2', 'working')];
    const result = detectCollisions(runs, agents);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('src/auth.ts');
    expect(result[0].agents.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
  });

  test('ignores stopped agents', () => {
    const runs = [run('a1', ['foo.ts'], 'stopped'), run('a2', ['foo.ts'])];
    const agents = [agent('a1', 'stopped'), agent('a2', 'working')];
    expect(detectCollisions(runs, agents)).toEqual([]);
  });

  test('handles three-way collision, sorted by agent count desc', () => {
    const runs = [run('a1', ['hot.ts', 'cold.ts']), run('a2', ['hot.ts']), run('a3', ['hot.ts', 'cold.ts'])];
    const agents = [agent('a1'), agent('a2'), agent('a3')];
    const result = detectCollisions(runs, agents);
    // hot.ts has 3 agents, cold.ts has 2 → hot.ts comes first
    expect(result[0].file).toBe('hot.ts');
    expect(result[0].agents).toHaveLength(3);
    expect(result[1].file).toBe('cold.ts');
  });
});

// ────────────────────────────────── churnHotspots ─────────────────────────────

describe('churnHotspots', () => {
  test('returns empty for null heat', () => {
    expect(churnHotspots(null, null)).toEqual([]);
  });

  test('returns empty when all heat values are zero', () => {
    const h: HeatPayload = { days: ['2026-06-27'], tree: [{ id: 'src/foo.ts', heat: [0] }] };
    expect(churnHotspots(h, [])).toEqual([]);
  });

  test('sorts by total heat descending', () => {
    const result = churnHotspots(HEAT_PAYLOAD, []);
    expect(result[0].path).toBe('src/auth/token.ts'); // sum=23
    expect(result[1].path).toBe('src/api/routes.ts'); // sum=8
    expect(result[2].path).toBe('src/db/schema.ts');  // sum=4
  });

  test('enriches agentCount from usage runs', () => {
    const runs = [
      run('a1', ['src/auth/token.ts']),
      run('a2', ['src/auth/token.ts']),
      run('a3', ['src/auth/token.ts']),
    ];
    const result = churnHotspots(HEAT_PAYLOAD, runs);
    expect(result[0].path).toBe('src/auth/token.ts');
    expect(result[0].agentCount).toBe(3);
  });

  test('respects limit', () => {
    expect(churnHotspots(HEAT_PAYLOAD, [], 2)).toHaveLength(2);
  });

  test('daily array is aligned to heat.tree[].heat', () => {
    const result = churnHotspots(HEAT_PAYLOAD, []);
    expect(result[0].daily).toEqual([0, 1, 3, 2, 4, 5, 6, 2]);
  });
});

// ────────────────────────────────── HeatPanel rendering ───────────────────────

// We can't render HeatPanel itself (it imports TaskContext + fetch), so we
// test the sub-components that make up the panel's surface.

import { Callout } from './ui';

describe('Callout rendering', () => {
  test('critical callout renders with role=alert and title', () => {
    const html = renderToStaticMarkup(
      <Callout tone="critical" title="2 files being edited by multiple live agents">
        Check the collision list below.
      </Callout>,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('2 files being edited by multiple live agents');
    expect(html).toContain('Check the collision list below.');
  });

  test('warn callout uses role=status', () => {
    const html = renderToStaticMarkup(
      <Callout tone="warn" title="Churn hotspot detected" />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('Churn hotspot detected');
  });

  test('action button renders when provided', () => {
    const html = renderToStaticMarkup(
      <Callout tone="critical" title="Collision" action={{ label: 'View agents', onClick: () => {} }} />,
    );
    expect(html).toContain('View agents');
    expect(html).toContain('<button');
  });
});

// ────────────────────────────── FlappingAgentsCallout ──────────────────────────
//
// flappingAgents() (lib/insights.ts) had full unit coverage but was never rendered
// anywhere — the HeatPanel ("Activity & hotspots") now wires it in as an agent-level
// hotspot signal alongside the file-churn hotspots. These tests cover the rendering
// half; flappingAgents()'s own ranking/threshold logic is covered in insights.test.ts.

describe('FlappingAgentsCallout', () => {
  test('renders nothing for an empty flapping list', () => {
    const html = renderToStaticMarkup(<FlappingAgentsCallout agents={[]} onView={() => {}} />);
    expect(html).toBe('');
  });

  test('renders each flapping agent with its hourly error rate and a View action', () => {
    const rows = flappingAgents([
      agent('a1', 'error', { errorTransitions1h: 5 }),
      agent('a2', 'idle', { errorTransitions1h: 3 }), // recovered but still flagged
    ]);
    const html = renderToStaticMarkup(<FlappingAgentsCallout agents={rows} onView={() => {}} />);

    expect(html).toContain('2 agents flapping in the last hour');
    expect(html).toContain('Agent a1');
    expect(html).toContain('5x/hr');
    expect(html).toContain('Agent a2');
    expect(html).toContain('3x/hr');
    expect((html.match(/View</g) ?? []).length).toBe(2);
  });

  test('singular copy for exactly one flapping agent', () => {
    const rows = flappingAgents([agent('a1', 'error', { errorTransitions1h: 4 })]);
    const html = renderToStaticMarkup(<FlappingAgentsCallout agents={rows} onView={() => {}} />);
    expect(html).toContain('1 agent flapping in the last hour');
  });
});

import { HeatGrid } from './ui';

describe('HeatGrid rendering', () => {
  test('renders day headers and file rows', () => {
    const html = renderToStaticMarkup(
      <HeatGrid
        days={['2026-06-26', '2026-06-27']}
        rows={[{ label: 'src/auth/token.ts', daily: [3, 5], note: '3 agents' }]}
      />,
    );
    expect(html).toContain('06-26');
    expect(html).toContain('06-27');
    expect(html).toContain('src/auth/token.ts');
    expect(html).toContain('3 agents');
  });

  test('shows empty label when rows array is empty', () => {
    const html = renderToStaticMarkup(
      <HeatGrid days={['2026-06-27']} rows={[]} emptyLabel="No hot files in the last window." />,
    );
    expect(html).toContain('No hot files in the last window.');
  });

  test('applies heat cell colour classes based on relative intensity', () => {
    // Row max = 10; value 8 → r = 0.8 → should be the hottest class
    const html = renderToStaticMarkup(
      <HeatGrid
        days={['d1', 'd2']}
        rows={[{ label: 'hot.ts', daily: [8, 10] }]}
      />,
    );
    // Both cells should have orange class (orange-600 for the hottest)
    expect(html).toContain('bg-orange-600');
  });
});

import { VerdictBadge } from './ui';

describe('VerdictBadge', () => {
  test('critical badge has role=status and red pill classes', () => {
    const html = renderToStaticMarkup(<VerdictBadge verdict="critical">2 collision risks</VerdictBadge>);
    expect(html).toContain('role="status"');
    expect(html).toContain('2 collision risks');
    // Should contain red pill styling
    expect(html).toContain('bg-red-100');
  });

  test('healthy badge contains emerald styling', () => {
    const html = renderToStaticMarkup(<VerdictBadge verdict="healthy">No contention</VerdictBadge>);
    expect(html).toContain('bg-emerald-100');
    expect(html).toContain('No contention');
  });

  test('warn badge contains amber styling', () => {
    const html = renderToStaticMarkup(<VerdictBadge verdict="warn">1 churn hotspot</VerdictBadge>);
    expect(html).toContain('bg-amber-100');
  });
});

// ────────────────────────────────── shortPath helper ──────────────────────────

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join('/')}`;
}

describe('shortPath', () => {
  test('passes through short paths unchanged', () => {
    expect(shortPath('src/auth.ts')).toBe('src/auth.ts');
    expect(shortPath('foo.ts')).toBe('foo.ts');
  });

  test('truncates long paths to last two segments', () => {
    expect(shortPath('src/auth/token.ts')).toBe('…/auth/token.ts');
    expect(shortPath('a/b/c/d/e.ts')).toBe('…/d/e.ts');
  });

  test('handles empty string', () => {
    expect(shortPath('')).toBe('');
  });
});
