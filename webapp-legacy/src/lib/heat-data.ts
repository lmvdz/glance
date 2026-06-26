export type TreeNode = {
  id: string;
  name: string;
  type: "folder" | "file";
  depth: number;
  heat?: number[];
};

export type HeatTag = "CORE HOTSPOT" | "GROWING" | "STEADY";

export type HotArea = {
  rank: number;
  path: string;
  score: number;
  description?: string;
  tag?: HeatTag;
};

export type Insight = { icon?: "modularize" | "extract" | "tests"; title: string; detail: string };

export type HeatData = {
  days: string[];
  tree: TreeNode[];
  hotAreas: HotArea[];
  insights: Insight[];
  source?: string;
  generatedAt?: number;
};

const MAGMA: [number, number, number][] = [
  [12, 8, 38],
  [54, 18, 88],
  [114, 31, 109],
  [183, 55, 95],
  [229, 92, 72],
  [248, 148, 65],
  [252, 200, 90],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function heatArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const heat = value
    .map((item) => (typeof item === "number" && Number.isFinite(item) ? Math.max(0, item) : null))
    .filter((item): item is number => item !== null);
  return heat.length > 0 ? heat : undefined;
}

function normalizeHeatScale(tree: TreeNode[]): TreeNode[] {
  const max = Math.max(1, ...tree.flatMap((node) => node.heat ?? []));
  if (max <= 1) return tree;
  return tree.map((node) => node.heat ? { ...node, heat: node.heat.map((value) => value / max) } : node);
}

function normalizeTree(value: unknown): TreeNode[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): TreeNode[] => {
    if (!isRecord(item)) return [];
    const id = typeof item.id === "string" ? item.id : "";
    const name = typeof item.name === "string" ? item.name : id.split("/").filter(Boolean).at(-1) ?? id;
    const type = item.type === "folder" || item.type === "file" ? item.type : null;
    const depth = typeof item.depth === "number" && Number.isFinite(item.depth) ? Math.max(0, Math.floor(item.depth)) : 0;
    if (!id || !type) return [];
    const heat = heatArray(item.heat);
    return [{ id, name, type, depth, ...(heat ? { heat } : {}) }];
  });
}

function normalizeHotAreas(value: unknown): HotArea[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index): HotArea[] => {
    if (!isRecord(item)) return [];
    const path = typeof item.path === "string" ? item.path : "";
    const rank = typeof item.rank === "number" && Number.isFinite(item.rank) ? item.rank : index + 1;
    const score =
      typeof item.score === "number" && Number.isFinite(item.score)
        ? item.score
        : typeof item.heat === "number" && Number.isFinite(item.heat)
          ? item.heat
          : 0;
    if (!path) return [];
    const tag = item.tag === "CORE HOTSPOT" || item.tag === "GROWING" || item.tag === "STEADY" ? item.tag : undefined;
    const description = typeof item.description === "string" ? item.description : undefined;
    return [{ path, rank, score, ...(description ? { description } : {}), ...(tag ? { tag } : {}) }];
  });
}

function normalizeInsights(value: unknown): Insight[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Insight[] => {
    if (typeof item === "string") return [{ title: item, detail: "Reported by /api/heat." }];
    if (!isRecord(item) || typeof item.title !== "string" || typeof item.detail !== "string") return [];
    const icon = item.icon === "modularize" || item.icon === "extract" || item.icon === "tests" ? item.icon : undefined;
    return [{ title: item.title, detail: item.detail, ...(icon ? { icon } : {}) }];
  });
}

export function normalizeHeatData(value: unknown): HeatData {
  if (!isRecord(value)) return { days: [], tree: [], hotAreas: [], insights: [] };
  const tree = normalizeHeatScale(normalizeTree(value.tree));
  return {
    days: stringArray(value.days),
    tree,
    hotAreas: normalizeHotAreas(value.hotAreas),
    insights: normalizeInsights(value.insights),
    source: typeof value.source === "string" ? value.source : undefined,
    generatedAt: typeof value.generatedAt === "number" && Number.isFinite(value.generatedAt) ? value.generatedAt : undefined,
  };
}

export function magma(t: number): string {
  const v = Math.max(0, Math.min(1, t));
  const scaled = v * (MAGMA.length - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  const a = MAGMA[i];
  const b = MAGMA[Math.min(i + 1, MAGMA.length - 1)];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r}, ${g}, ${bl})`;
}
