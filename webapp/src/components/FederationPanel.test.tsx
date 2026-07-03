/**
 * FederationPanel — pure logic tests (DOM-free).
 *
 * The component itself is React and can't be rendered without jsdom. We test
 * the two helper functions extracted from the module directly so we can run
 * them with bun:test and zero DOM overhead.
 */

import { expect, test, describe } from 'bun:test';
import { detectCollisions, type UsageRun } from '../lib/insights';
import type { AgentDTO } from '../lib/dto';

// ── helpers re-implemented here so we can test without importing the whole
//    component (which pulls in React / JSX). These must stay in sync with
//    the component implementation.

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join('/')}`;
}

function shortBase(p?: string): string {
  const parts = String(p ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] || String(p ?? '');
}

interface Lease {
  file: string;
  agentId?: string;
  agentName?: string;
  claimedAt?: number;
}

interface FilesInFlightEntry {
  agentIds: Set<string>;
  agentNames: string[];
  since?: number;
}

function filesInFlight(
  runs: UsageRun[],
  leases: Lease[],
): Map<string, FilesInFlightEntry> {
  const byFile = new Map<string, FilesInFlightEntry>();

  const upsert = (file: string, agentId: string, agentName: string, since?: number) => {
    let entry = byFile.get(file);
    if (!entry) {
      entry = { agentIds: new Set(), agentNames: [], since };
      byFile.set(file, entry);
    }
    if (!entry.agentIds.has(agentId)) {
      entry.agentIds.add(agentId);
      entry.agentNames.push(agentName);
    }
    if (since && (!entry.since || since > entry.since)) entry.since = since;
  };

  for (const run of runs) {
    if (run.status !== 'working') continue;
    for (const file of run.filesTouched ?? []) {
      if (file) upsert(file, run.agentId, run.name, run.startedAt);
    }
  }

  for (const lease of leases) {
    if (lease.file && lease.agentId) {
      upsert(lease.file, lease.agentId, lease.agentName ?? lease.agentId, lease.claimedAt);
    }
  }

  return byFile;
}

// ── fixtures ──────────────────────────────────────────────────────────────────

function agent(id: string, status: AgentDTO['status'] = 'working'): AgentDTO {
  return {
    id,
    name: id,
    status,
    repo: '/repo',
    worktree: '/worktree',
    pending: [],
    lastActivity: Date.now(),
  } as AgentDTO;
}

function run(agentId: string, files: string[], status = 'working', extra: Partial<UsageRun> = {}): UsageRun {
  return {
    agentId,
    name: agentId,
    repo: '/repo',
    status,
    filesTouched: files,
    ...extra,
  };
}

// ── shortPath ─────────────────────────────────────────────────────────────────

describe('shortPath', () => {
  test('short paths pass through unchanged', () => {
    expect(shortPath('src/foo.ts')).toBe('src/foo.ts');
    expect(shortPath('foo.ts')).toBe('foo.ts');
  });

  test('deep paths are truncated to …/parent/file', () => {
    expect(shortPath('a/b/c/d.ts')).toBe('…/c/d.ts');
    expect(shortPath('/home/user/project/src/lib/utils.ts')).toBe('…/lib/utils.ts');
  });
});

// ── shortBase ─────────────────────────────────────────────────────────────────

describe('shortBase', () => {
  test('returns the last path segment', () => {
    expect(shortBase('/home/user/my-repo')).toBe('my-repo');
    expect(shortBase('my-repo')).toBe('my-repo');
  });

  test('handles undefined / empty gracefully', () => {
    expect(shortBase(undefined)).toBe('');
    expect(shortBase('')).toBe('');
  });
});

// ── filesInFlight ─────────────────────────────────────────────────────────────

describe('filesInFlight', () => {
  test('empty runs and leases → empty map', () => {
    const map = filesInFlight([], []);
    expect(map.size).toBe(0);
  });

  test('excludes non-working runs', () => {
    const map = filesInFlight([run('a1', ['src/foo.ts'], 'done')], []);
    expect(map.size).toBe(0);
  });

  test('includes files from working runs', () => {
    const map = filesInFlight([run('a1', ['src/foo.ts', 'src/bar.ts'])], []);
    expect(map.size).toBe(2);
    expect(map.has('src/foo.ts')).toBe(true);
    expect(map.get('src/foo.ts')!.agentNames).toContain('a1');
  });

  test('deduplicates same agent touching same file via multiple runs', () => {
    const map = filesInFlight(
      [run('a1', ['src/foo.ts']), run('a1', ['src/foo.ts'])],
      [],
    );
    expect(map.get('src/foo.ts')!.agentIds.size).toBe(1);
    expect(map.get('src/foo.ts')!.agentNames.length).toBe(1);
  });

  test('accumulates distinct agents on same file', () => {
    const map = filesInFlight(
      [run('a1', ['src/foo.ts']), run('a2', ['src/foo.ts'])],
      [],
    );
    const entry = map.get('src/foo.ts')!;
    expect(entry.agentIds.size).toBe(2);
    expect(entry.agentNames).toContain('a1');
    expect(entry.agentNames).toContain('a2');
  });

  test('picks up files from leases even without matching runs', () => {
    const leases: Lease[] = [{ file: 'src/new.ts', agentId: 'a1', agentName: 'Agent 1' }];
    const map = filesInFlight([], leases);
    expect(map.has('src/new.ts')).toBe(true);
    expect(map.get('src/new.ts')!.agentNames).toContain('Agent 1');
  });

  test('merges run and lease entries for the same file', () => {
    const leases: Lease[] = [{ file: 'src/shared.ts', agentId: 'a2', agentName: 'Agent 2' }];
    const map = filesInFlight([run('a1', ['src/shared.ts'])], leases);
    const entry = map.get('src/shared.ts')!;
    expect(entry.agentIds.size).toBe(2);
  });

  test('uses most-recent startedAt as since', () => {
    const older = run('a1', ['f.ts'], 'working', { startedAt: 1000 });
    const newer = run('a2', ['f.ts'], 'working', { startedAt: 2000 });
    const map = filesInFlight([older, newer], []);
    expect(map.get('f.ts')!.since).toBe(2000);
  });

  test('since falls back to lease claimedAt when no run timestamp', () => {
    const leases: Lease[] = [{ file: 'f.ts', agentId: 'a1', claimedAt: 5000 }];
    const map = filesInFlight([], leases);
    expect(map.get('f.ts')!.since).toBe(5000);
  });
});

// ── detectCollisions integration ──────────────────────────────────────────────

describe('detectCollisions (via insights)', () => {
  test('no collision with a single live agent on a file', () => {
    const agents = [agent('a1')];
    const runs = [run('a1', ['src/foo.ts'])];
    const result = detectCollisions(runs, agents);
    expect(result).toHaveLength(0);
  });

  test('collision detected when two live agents touch the same file', () => {
    const agents = [agent('a1'), agent('a2')];
    const runs = [run('a1', ['src/foo.ts']), run('a2', ['src/foo.ts'])];
    const result = detectCollisions(runs, agents);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('src/foo.ts');
    expect(result[0].agents.map((a) => a.id)).toContain('a1');
    expect(result[0].agents.map((a) => a.id)).toContain('a2');
  });

  test('no collision when one agent is not live (stopped)', () => {
    const agents = [agent('a1', 'working'), agent('a2', 'stopped')];
    const runs = [run('a1', ['src/foo.ts']), run('a2', ['src/foo.ts'])];
    const result = detectCollisions(runs, agents);
    expect(result).toHaveLength(0);
  });

  test('multiple files each with ≥2 agents all appear', () => {
    const agents = [agent('a1'), agent('a2'), agent('a3')];
    const runs = [
      run('a1', ['f1.ts', 'f2.ts']),
      run('a2', ['f1.ts']),
      run('a3', ['f2.ts']),
    ];
    const result = detectCollisions(runs, agents);
    expect(result).toHaveLength(2);
    const files = result.map((c) => c.file);
    expect(files).toContain('f1.ts');
    expect(files).toContain('f2.ts');
  });
});
