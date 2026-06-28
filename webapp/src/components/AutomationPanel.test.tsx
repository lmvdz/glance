/**
 * AutomationPanel.test.tsx — DOM-free unit tests for the panel's display logic.
 *
 * We don't render the component (it needs fetch + React context). Instead we
 * verify the pure helpers that drive the verdict, anomaly callouts, and
 * spend/budget tiles — the three places where the redesign diverges from the
 * old firehose.
 */

import { expect, test, describe } from 'bun:test';
import { automationDigest, type AutomationRollup, type UsagePayload } from '../lib/insights';

// ─── helpers ─────────────────────────────────────────────────────────────────

function roll(loop: string, p: Partial<AutomationRollup> = {}): AutomationRollup {
  return { loop, events: 0, llmCalls: 0, found: 0, filed: 0, spawned: 0, errors: 0, lastAt: 0, ...p };
}

const emptyUsage: UsagePayload = { runs: [], costUsd: 0 };

// ─── verdict helpers (inline, same logic the panel uses) ─────────────────────

function panelVerdict(rollup: AutomationRollup[], usage: UsagePayload | null): 'healthy' | 'warn' | 'ok' {
  const digest = automationDigest(rollup, usage);
  const hasActivity = rollup.some((r) => r.events > 0);
  const hasOutput = digest.ticketsFiled > 0 || digest.agentsSpawned > 0;
  const hasAnomalies = digest.anomalies.length > 0;

  if (hasAnomalies) return 'warn';
  if (!hasActivity) return 'ok';
  if (hasOutput) return 'healthy';
  return 'ok';
}

// ─── spend formatter (copy of fmtUsd from panel) ─────────────────────────────

function fmtUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('panel verdict', () => {
  test('idle when no activity', () => {
    expect(panelVerdict([], emptyUsage)).toBe('ok');
  });

  test('ok when loops ran but produced nothing (no anomaly)', () => {
    // Observer ticks but files nothing and has no anomaly threshold (found=0)
    const r = roll('observer', { events: 5, found: 0, filed: 0 });
    expect(panelVerdict([r], emptyUsage)).toBe('ok');
  });

  test('healthy when loops produced output', () => {
    const r = roll('scout', { events: 3, llmCalls: 2, filed: 2, found: 3 });
    expect(panelVerdict([r], emptyUsage)).toBe('healthy');
  });

  test('warn when dispatch finds candidates but spawns none', () => {
    // The canonical red-flag scenario: Dispatch found 1770 candidates, spawned 0
    const r = roll('dispatch', { events: 10, found: 1770, spawned: 0, filed: 0 });
    expect(panelVerdict([r], emptyUsage)).toBe('warn');
  });

  test('warn when any loop logs errors', () => {
    const r = roll('scout', { events: 2, llmCalls: 1, errors: 3 });
    expect(panelVerdict([r], emptyUsage)).toBe('warn');
  });

  test('healthy even when spend is non-zero but loops are producing', () => {
    const r = roll('scout', { events: 4, llmCalls: 5, filed: 3, found: 5 });
    expect(panelVerdict([r], { runs: [], costUsd: 0.42 })).toBe('healthy');
  });
});

describe('anomaly callout content', () => {
  test('Dispatch 1770 found / 0 spawned surfaces the right anomaly message', () => {
    const d = automationDigest([roll('dispatch', { events: 10, found: 1770, spawned: 0, filed: 0 })], emptyUsage);
    expect(d.anomalies.length).toBeGreaterThanOrEqual(1);
    const a = d.anomalies.find((x) => x.loop === 'dispatch');
    expect(a).toBeDefined();
    expect(a!.message).toContain('spawned 0');
  });

  test('no anomaly when dispatch both finds and spawns', () => {
    const d = automationDigest([roll('dispatch', { events: 3, found: 2, spawned: 2 })], emptyUsage);
    expect(d.anomalies.filter((a) => a.loop === 'dispatch').length).toBe(0);
  });

  test('scout budget exhaustion surfaces an anomaly', () => {
    const d = automationDigest([roll('scout', { events: 5, llmCalls: 30 })], emptyUsage, 30);
    expect(d.anomalies.some((a) => a.loop === 'scout' && a.message.includes('budget'))).toBe(true);
  });

  test('multiple anomalies accumulate independently', () => {
    const d = automationDigest(
      [
        roll('dispatch', { events: 5, found: 10, spawned: 0, filed: 0 }),
        roll('scout', { events: 3, llmCalls: 30, errors: 1 }),
      ],
      emptyUsage,
      30,
    );
    expect(d.anomalies.length).toBeGreaterThanOrEqual(3); // dispatch anomaly + errors + budget
  });
});

describe('spend & budget tiles', () => {
  test('zero spend formats as $0.00', () => {
    expect(fmtUsd(0)).toBe('$0.00');
  });

  test('sub-cent spend shows <$0.01', () => {
    expect(fmtUsd(0.001)).toBe('<$0.01');
  });

  test('normal spend rounds to 2dp', () => {
    expect(fmtUsd(1.234)).toBe('$1.23');
  });

  test('digest carries spend from usage even when rollup is empty', () => {
    const d = automationDigest([], { runs: [], costUsd: 2.5 });
    expect(d.spentUsd).toBe(2.5);
  });

  test('scout budget: used < cap → remaining count is positive', () => {
    const d = automationDigest([roll('scout', { llmCalls: 10 })], emptyUsage, 30);
    expect(d.scoutBudget.used).toBe(10);
    expect(d.scoutBudget.cap).toBe(30);
    expect(d.scoutBudget.cap - d.scoutBudget.used).toBe(20);
  });

  test('scout budget: used === cap → exhausted', () => {
    const d = automationDigest([roll('scout', { llmCalls: 30 })], emptyUsage, 30);
    expect(d.scoutBudget.used).toBe(30);
    expect(d.scoutBudget.used >= d.scoutBudget.cap).toBe(true);
  });
});

describe('outcome summary cards', () => {
  test('dispatch outcome is spawned count, not filed', () => {
    const d = automationDigest([roll('dispatch', { events: 5, found: 3, spawned: 2 })], emptyUsage);
    expect(d.agentsSpawned).toBe(2);
    expect(d.ticketsFiled).toBe(0);
  });

  test('scout outcome is filed count', () => {
    const d = automationDigest([roll('scout', { events: 4, llmCalls: 3, filed: 2, found: 3 })], emptyUsage);
    expect(d.ticketsFiled).toBe(2);
  });

  test('all loops active: totals aggregate correctly', () => {
    const d = automationDigest(
      [
        roll('scout', { events: 5, llmCalls: 5, filed: 3, found: 4 }),
        roll('observer', { events: 10 }),
        roll('opportunity', { events: 6, found: 2 }),
        roll('dispatch', { events: 3, found: 2, spawned: 1 }),
      ],
      { runs: [], costUsd: 0.8 },
    );
    expect(d.llmCalls).toBe(5);
    expect(d.ticketsFiled).toBe(3);
    expect(d.agentsSpawned).toBe(1);
    expect(d.candidates).toBe(8); // 4 + 0 + 2 + 2
    expect(d.spentUsd).toBe(0.8);
  });
});
