import { expect, test } from 'bun:test';
import { enabledCapabilityCount, installForPack } from './capability-view';
import type { CapabilityInstallDTO, CapabilityPackDTO } from './dto';

const pack: CapabilityPackDTO = {
  id: 'pack-1',
  sourceId: 'src-1',
  framework: 'workflow',
  slug: 'deep-search',
  version: '1.0.0',
  checksum: 'abc',
  title: 'Deep Search',
  description: 'Research agent',
  requiredEnv: [],
  tools: [],
  skills: [],
  workflows: [],
};

const installs: CapabilityInstallDTO[] = [
  { id: 'old', orgId: 'file', packId: 'pack-1', version: '0.9.0', checksum: 'old', state: 'removed', bindings: [], updatedAt: 1 },
  { id: 'live', orgId: 'file', packId: 'pack-1', version: '1.0.0', checksum: 'abc', state: 'enabled', bindings: [], updatedAt: 2 },
];

test('capability view ignores removed installs and counts enabled packs', () => {
  expect(installForPack(pack, installs)?.id).toBe('live');
  expect(enabledCapabilityCount(installs)).toBe(1);
});
