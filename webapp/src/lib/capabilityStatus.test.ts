/**
 * capabilityStatus.test.ts — pure capability synthesis. DOM-free (bun:test).
 */

import { expect, test, describe } from 'bun:test';
import { packStatus, summarizeCapabilities } from './capabilityStatus';
import type { CapabilityPackDTO, CapabilityInstallDTO, CapabilityBindingDTO, CapabilityInstallState } from './dto';

function pack(id: string, extra: Partial<CapabilityPackDTO> = {}): CapabilityPackDTO {
  return {
    id,
    sourceId: 's',
    framework: 'omp',
    slug: id,
    version: '1.0.0',
    checksum: 'abc',
    title: id,
    description: '',
    requiredEnv: [],
    tools: [{ name: 't' }],
    skills: [],
    workflows: [],
    ...extra,
  };
}

function binding(type: CapabilityBindingDTO['type'], enabled: boolean): CapabilityBindingDTO {
  return { id: `${type}-${enabled}`, installId: 'i', type, key: 'k', enabled };
}

function install(packId: string, state: CapabilityInstallState, bindings: CapabilityBindingDTO[] = []): CapabilityInstallDTO {
  return { id: `i-${packId}`, orgId: 'o', packId, version: '1.0.0', checksum: 'abc', state, bindings, updatedAt: 0 };
}

describe('packStatus', () => {
  test('no install → available', () => {
    expect(packStatus(pack('a'), []).health).toBe('available');
  });

  test('enabled with a runnable binding → active', () => {
    const s = packStatus(pack('a'), [install('a', 'enabled', [binding('workflow', true)])]);
    expect(s.health).toBe('active');
    expect(s.runnable?.type).toBe('workflow');
    expect(s.detail).toContain('Bound to the runtime');
  });

  test('enabled but NO enabled runnable binding → broken (claims on, does nothing)', () => {
    const s = packStatus(pack('a'), [install('a', 'enabled', [binding('workflow', false), binding('doc', true)])]);
    expect(s.health).toBe('broken');
    expect(s.detail).toContain('nothing is bound');
  });

  test('enabled but empty pack → broken with the empty explanation', () => {
    const s = packStatus(pack('a', { tools: [], skills: [], workflows: [] }), [install('a', 'enabled')]);
    expect(s.health).toBe('broken');
    expect(s.detail).toContain('empty');
  });

  test('failed install → broken', () => {
    expect(packStatus(pack('a'), [install('a', 'failed')]).health).toBe('broken');
  });

  test('disabled → idle', () => {
    expect(packStatus(pack('a'), [install('a', 'disabled')]).health).toBe('idle');
  });

  test('imported/approved (not yet enabled) → pending', () => {
    expect(packStatus(pack('a'), [install('a', 'imported')]).health).toBe('pending');
    expect(packStatus(pack('a'), [install('a', 'approved')]).health).toBe('pending');
  });

  test('a removed install is ignored (treated as available)', () => {
    expect(packStatus(pack('a'), [install('a', 'removed')]).health).toBe('available');
  });
});

describe('summarizeCapabilities', () => {
  const packs = [pack('a'), pack('b'), pack('c'), pack('d')];

  test('broken packs drive a critical verdict and sort first', () => {
    const installs = [
      install('a', 'enabled', [binding('profile', true)]), // active
      install('b', 'enabled', []), // broken (unbound)
      install('c', 'disabled'), // idle
    ];
    const s = summarizeCapabilities(packs, installs);
    expect(s.verdict).toBe('critical');
    expect(s.headline).toBe('1 pack needs attention');
    expect(s.broken).toBe(1);
    expect(s.active).toBe(1);
    expect(s.packs[0].health).toBe('broken'); // attention-first
    expect(s.brokenPacks).toHaveLength(1);
  });

  test('all-active → healthy verdict', () => {
    const installs = packs.map((p) => install(p.id, 'enabled', [binding('driver', true)]));
    const s = summarizeCapabilities(packs, installs);
    expect(s.verdict).toBe('healthy');
    expect(s.active).toBe(4);
    expect(s.broken).toBe(0);
  });

  test('installed-but-none-enabled → warn', () => {
    const s = summarizeCapabilities(packs, packs.map((p) => install(p.id, 'imported')));
    expect(s.verdict).toBe('warn');
    expect(s.headline).toContain('enable a pack');
  });

  test('only catalog entries → healthy, counts available', () => {
    const s = summarizeCapabilities(packs, []);
    expect(s.verdict).toBe('healthy');
    expect(s.available).toBe(4);
  });

  test('null-safe', () => {
    expect(summarizeCapabilities(null, null).packs).toEqual([]);
  });
});
