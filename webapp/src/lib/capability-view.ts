import type { CapabilityInstallDTO, CapabilityPackDTO } from './dto';

export function installForPack(pack: CapabilityPackDTO, installs: CapabilityInstallDTO[]): CapabilityInstallDTO | undefined {
  return installs.find((install) => install.packId === pack.id && install.state !== 'removed');
}

export function enabledCapabilityCount(installs: CapabilityInstallDTO[]): number {
  return installs.filter((install) => install.state === 'enabled').length;
}
