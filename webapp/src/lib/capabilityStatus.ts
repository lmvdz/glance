/**
 * capabilityStatus.ts — pure synthesis for the capability (agent-recipe) panel.
 *
 * The old panel showed every pack as an equal card whose hero was three vanity
 * counts (tools / skills / workflows). Nobody decides anything from "4 tools."
 * What a person needs to know is STATE: which packs are actually bound to the
 * runtime, which are installed-but-doing-nothing, and — above all — which are
 * BROKEN (failed, or enabled yet bound to nothing). This module derives that and
 * leads with it.
 *
 * Honest by construction: "broken" is computed from real install state +
 * bindings, not asserted. An enabled pack with no enabled runnable binding is
 * surfaced as broken precisely because it claims to be on but can't do anything.
 *
 * Mirrors insights.ts / heatmap.ts / taskStatus.ts: no React, no fetch, testable.
 */

import type { CapabilityPackDTO, CapabilityInstallDTO, CapabilityBindingDTO } from './dto';

/** active = bound & running · pending = installed, not enabled · idle = disabled · broken = failed/unbound · available = catalog-only. */
export type PackHealth = 'active' | 'pending' | 'idle' | 'broken' | 'available';

export interface PackStatus {
  pack: CapabilityPackDTO;
  install?: CapabilityInstallDTO;
  health: PackHealth;
  /** one-line, human explanation of the state. */
  detail: string;
  /** the enabled runnable binding (profile/workflow/driver), if any. */
  runnable?: CapabilityBindingDTO;
  toolCount: number;
  skillCount: number;
  workflowCount: number;
}

export interface CapabilitySummary {
  verdict: 'critical' | 'warn' | 'healthy';
  headline: string;
  active: number;
  broken: number;
  pending: number;
  idle: number;
  available: number;
  /** sorted broken → active → pending → idle → available, then title. */
  packs: PackStatus[];
  /** just the broken ones, for the lead callout. */
  brokenPacks: PackStatus[];
}

const RUNNABLE = new Set<CapabilityBindingDTO['type']>(['profile', 'workflow', 'driver']);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const HEALTH_RANK: Record<PackHealth, number> = { broken: 0, active: 1, pending: 2, idle: 3, available: 4 };

function installFor(pack: CapabilityPackDTO, installs: CapabilityInstallDTO[]): CapabilityInstallDTO | undefined {
  return installs.find((i) => i.packId === pack.id && i.state !== 'removed');
}

/** Classify one pack from its install + bindings. */
export function packStatus(pack: CapabilityPackDTO, installs: CapabilityInstallDTO[]): PackStatus {
  const install = installFor(pack, installs);
  const toolCount = pack.tools.length;
  const skillCount = pack.skills.length;
  const workflowCount = pack.workflows.length;
  const empty = toolCount + skillCount + workflowCount === 0;
  const runnable = install?.bindings.find((b) => b.enabled && RUNNABLE.has(b.type));

  let health: PackHealth;
  let detail: string;

  if (!install) {
    health = 'available';
    detail = empty ? 'In the catalog · empty pack' : 'In the catalog — not installed';
  } else if (install.state === 'failed') {
    health = 'broken';
    detail = 'Install failed — re-import or check the manifest';
  } else if (install.state === 'enabled') {
    if (runnable) {
      health = 'active';
      detail = `Bound to the runtime (${runnable.type})`;
    } else {
      health = 'broken';
      detail = empty ? 'Enabled but the pack is empty — nothing to bind' : 'Enabled but nothing is bound to the runtime';
    }
  } else if (install.state === 'disabled') {
    health = 'idle';
    detail = 'Installed but disabled';
  } else {
    // imported | validated | approved
    health = 'pending';
    detail = `Installed (${install.state}) — enable to bind it`;
  }

  return { pack, install, health, detail, runnable, toolCount, skillCount, workflowCount };
}

/** Roll the packs up into a verdict + counts + a sorted, attention-first list. */
export function summarizeCapabilities(
  packs: CapabilityPackDTO[] | null | undefined,
  installs: CapabilityInstallDTO[] | null | undefined,
): CapabilitySummary {
  const list = (packs ?? []).map((p) => packStatus(p, installs ?? []));
  const count = (h: PackHealth): number => list.filter((s) => s.health === h).length;
  const active = count('active');
  const broken = count('broken');
  const pending = count('pending');
  const idle = count('idle');
  const available = count('available');

  const sorted = [...list].sort(
    (a, b) => HEALTH_RANK[a.health] - HEALTH_RANK[b.health] || a.pack.title.localeCompare(b.pack.title),
  );
  const brokenPacks = sorted.filter((s) => s.health === 'broken');

  let verdict: CapabilitySummary['verdict'];
  let headline: string;
  if (broken > 0) {
    verdict = 'critical';
    headline = `${plural(broken, 'pack')} ${broken === 1 ? 'needs' : 'need'} attention`;
  } else if (active > 0) {
    verdict = 'healthy';
    headline = pending > 0 ? `${plural(active, 'pack')} active · ${pending} waiting to enable` : `${plural(active, 'pack')} active`;
  } else if (pending + idle > 0) {
    verdict = 'warn';
    headline = 'Nothing bound to the runtime yet — enable a pack';
  } else {
    verdict = 'healthy';
    headline = available > 0 ? `${plural(available, 'pack')} in the catalog` : 'No packs imported yet';
  }

  return { verdict, headline, active, broken, pending, idle, available, packs: sorted, brokenPacks };
}
