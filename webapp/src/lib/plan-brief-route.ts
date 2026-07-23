import type { FeatureDTO } from "./dto";

export interface PlanBriefLocation {
  name: string;
}

export function planBriefNameFromDir(planDir: string | undefined): string | undefined {
  const clean = planDir?.trim().replace(/^\/+|\/+$/g, "");
  if (!clean) return undefined;
  return clean.startsWith("plans/") ? clean.slice("plans/".length) : clean;
}

export function parsePlanBriefHash(hash: string): PlanBriefLocation | undefined {
  const m = /^#\/plans\/([^/?#]+)\/brief$/.exec(hash);
  return m?.[1] ? { name: decodeURIComponent(m[1]) } : undefined;
}

export function buildPlanBriefHash(location: PlanBriefLocation): string {
  return `#/plans/${encodeURIComponent(location.name)}/brief`;
}

export function planBriefFeatures(features: FeatureDTO[]): FeatureDTO[] {
  return features.filter((f) => !!planBriefNameFromDir(f.planDir));
}
