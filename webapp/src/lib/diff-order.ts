/**
 * Deterministic "story order" for the Intervene diff spine (plans/comprehension/08-intervene-teaching.md,
 * plans/research-ndrstnd/BRIEF.md pattern 3: "Deterministic suggested reading order").
 *
 * Adaptation — not a verbatim port — of the evidence-ordering algorithm shape from ndrstnd
 * (https://github.com/truizlop/ndrstnd, `src/server/evidence-ordering.ts`, commit `9215970`,
 * Apache-2.0), reimplemented from scratch against this project's `AgentFileDiff[]` wire shape
 * (their source operates on a richer analysis document this codebase doesn't have). Same shape:
 * a cheap token scan for symbol definitions vs uses (minus a keyword set) yields definition-before-
 * use edges; files are bucketed into architectural layers (config/schema -> lib -> server/manager
 * -> UI) emitted in that fixed order; WITHIN each layer, a topological sort applies the edges —
 * deliberately never a whole-graph O(n^2) constraint set (the complexity call their own source
 * makes) since cross-layer order is already forced by the bucketing. Any cycle (or a layer whose
 * sort can't fully resolve) falls back to the ORIGINAL input order for just that layer's files —
 * graceful, never thrown, never a silently-reordered surprise.
 *
 * @license Apache-2.0 portions adapted from ndrstnd (truizlop/ndrstnd). See module doc above for
 * the exact source commit and what was reimplemented vs. reused.
 */

import type { AgentFileDiff } from '../components/chat/DiffReviewPanel';

export type DiffOrderMode = 'story' | 'path';

/** Order `diffs` per `mode` — `'path'` is a plain lexical sort by file path (the traditional diff-
 *  viewer default); `'story'` is the definition-before-use + layer-precedence order below. Both are
 *  pure and total: every input file appears exactly once in the output, in some order, always. */
export function orderDiffs(diffs: AgentFileDiff[], mode: DiffOrderMode): AgentFileDiff[] {
  return mode === 'path' ? pathOrder(diffs) : storyOrder(diffs);
}

/** Plain lexical order by file path. */
export function pathOrder(diffs: AgentFileDiff[]): AgentFileDiff[] {
  return [...diffs].sort((a, b) => a.file.localeCompare(b.file));
}

// =================================================================================================
// Layer precedence: config/schema (0) -> lib (1) -> server/manager (2) -> UI (3). Classified from
// the file PATH alone (diff text carries no layer signal) — cheap, deterministic, and testable
// without any project-specific import graph.
// =================================================================================================

export const LAYER_CONFIG_SCHEMA = 0;
export const LAYER_LIB = 1;
export const LAYER_SERVER_MANAGER = 2;
export const LAYER_UI = 3;

/** Number of layer buckets `classifyLayer` can return — `storyOrder` allocates exactly this many
 *  groups, so a new layer must be added to BOTH `classifyLayer` and this constant together. */
export const LAYER_COUNT = 4;

/**
 * Classify one file path into a layer bucket. Order of checks matters — a path can match more than
 * one pattern (e.g. `webapp/src/lib/attention.ts` contains both `webapp` and `lib`), so the MOST
 * SPECIFIC signal wins: config/schema and UI (component/page) shapes are checked first since they're
 * the narrowest patterns, `lib` next (a `/lib/` directory is unambiguous), and anything left over —
 * a bare top-level module like `src/attention.ts` — defaults to `LAYER_LIB`, the safe "plain module"
 * middle bucket, never the more consequential server/manager or UI tiers by accident.
 */
export function classifyLayer(file: string): number {
  const f = file.toLowerCase();
  if (/(^|\/)(config|schema|migrations?)(\/|[._-]|$)/.test(f) || /\.(json|ya?ml)$/.test(f)) return LAYER_CONFIG_SCHEMA;
  if (/(^|\/)(components|pages|views)\//.test(f) || /\.(tsx|jsx)$/.test(f)) return LAYER_UI;
  if (/(^|\/)(server|squad-manager|manager)\.tsx?$/.test(f) || /(^|\/)server\//.test(f)) return LAYER_SERVER_MANAGER;
  if (/(^|\/)lib\//.test(f)) return LAYER_LIB;
  return LAYER_LIB;
}

// =================================================================================================
// Definition-before-use: a token scan over each file's diff text, minus a keyword set, finds
// unambiguous symbol definitions (function/class/interface/type/enum/const/let/var declarations)
// and every identifier token used anywhere in the diff. A symbol defined in exactly one file and
// used (without also being defined) in another creates a "definer before user" edge.
// =================================================================================================

const KEYWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'to', 'for', 'and', 'or', 'is', 'as', 'if', 'else', 'return',
  'import', 'export', 'default', 'function', 'class', 'interface', 'type', 'const', 'let', 'var',
  'new', 'this', 'true', 'false', 'null', 'undefined', 'void', 'async', 'await', 'from', 'extends',
  'implements', 'public', 'private', 'protected', 'readonly', 'static', 'abstract', 'enum',
  'namespace', 'declare', 'module', 'require', 'typeof', 'instanceof', 'delete', 'try', 'catch',
  'finally', 'throw', 'switch', 'case', 'break', 'continue', 'while', 'do', 'yield', 'super', 'with',
  'get', 'set', 'of', 'keyof', 'never', 'unknown', 'any', 'string', 'number', 'boolean', 'object',
  'symbol', 'bigint', 'satisfies', 'in', 'is',
]);

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const DEF_TYPE_RE = /\b(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const DEF_VAR_RE = /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]/g;

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IDENTIFIER_RE)) {
    const tok = m[0];
    if (tok.length > 1 && !KEYWORDS.has(tok)) out.push(tok);
  }
  return out;
}

/** Symbols DEFINED in one file's diff text (function/class/interface/type/enum/const/let/var). */
function definedSymbols(text: string): Set<string> {
  const out = new Set<string>();
  for (const re of [DEF_TYPE_RE, DEF_VAR_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const tok = m[1];
      if (!KEYWORDS.has(tok)) out.add(tok);
    }
  }
  return out;
}

interface FileSymbols {
  file: string;
  defs: Set<string>;
  uses: Set<string>;
}

function scanFiles(diffs: AgentFileDiff[]): FileSymbols[] {
  return diffs.map((d) => {
    const text = d.diff ?? '';
    return { file: d.file, defs: definedSymbols(text), uses: new Set(tokenize(text)) };
  });
}

/**
 * Topologically sort one layer's files by definition-before-use edges, falling back to the
 * ORIGINAL relative order for that group whenever a cycle prevents a full resolution (Kahn's
 * algorithm: if fewer nodes get scheduled than exist, something cycles — bail to input order
 * rather than emit a partial/arbitrary ordering).
 */
function topoSortGroup(group: FileSymbols[]): string[] {
  const files = group.map((g) => g.file);
  if (files.length <= 1) return files;

  const indexOf = new Map(files.map((f, i) => [f, i]));
  // Which file (if any) is the SOLE definer of each symbol, restricted to this group.
  const soleDefiner = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const { file, defs } of group) {
    for (const sym of defs) {
      if (ambiguous.has(sym)) continue;
      if (soleDefiner.has(sym) && soleDefiner.get(sym) !== file) {
        ambiguous.add(sym);
        soleDefiner.delete(sym);
      } else {
        soleDefiner.set(sym, file);
      }
    }
  }

  const adjacency = new Map<string, Set<string>>(files.map((f) => [f, new Set<string>()]));
  const inDegree = new Map<string, number>(files.map((f) => [f, 0]));
  for (const { file: userFile, uses, defs } of group) {
    for (const sym of uses) {
      const definer = soleDefiner.get(sym);
      if (!definer || definer === userFile) continue; // no unambiguous definer, or self-use
      if (defs.has(sym)) continue; // this file also defines the same-named symbol independently
      const edgesFromDefiner = adjacency.get(definer);
      if (edgesFromDefiner && !edgesFromDefiner.has(userFile)) {
        edgesFromDefiner.add(userFile);
        inDegree.set(userFile, (inDegree.get(userFile) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm, ties broken by ORIGINAL input order so an unconstrained pair never reorders
  // for no reason.
  const ready = files.filter((f) => (inDegree.get(f) ?? 0) === 0).sort((a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0));
  const remaining = new Map(inDegree);
  const out: string[] = [];
  const queue = [...ready];
  while (queue.length > 0) {
    // Always pull the earliest-input-order ready node — keeps output deterministic and stable.
    queue.sort((a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0));
    const next = queue.shift();
    if (next === undefined) break;
    out.push(next);
    for (const dependent of adjacency.get(next) ?? []) {
      const d = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, d);
      if (d === 0) queue.push(dependent);
    }
  }

  if (out.length !== files.length) return files; // cycle: graceful fallback to input order
  return out;
}

/**
 * The "story order": files bucketed into architectural layers (ascending), each layer internally
 * topologically sorted by definition-before-use edges (falling back to input order on a cycle).
 * Layer precedence is absolute — edges are only ever considered WITHIN a layer, so a symbol defined
 * in a later layer (e.g. a UI component) never pulls an earlier-layer file (e.g. a lib helper) out
 * of its forced position.
 */
export function storyOrder(diffs: AgentFileDiff[]): AgentFileDiff[] {
  if (diffs.length <= 1) return [...diffs];
  const byFile = new Map(diffs.map((d) => [d.file, d]));
  const symbols = scanFiles(diffs);
  const groups: FileSymbols[][] = Array.from({ length: LAYER_COUNT }, () => []);
  for (const sym of symbols) groups[classifyLayer(sym.file)].push(sym);

  const orderedFiles: string[] = [];
  for (const group of groups) orderedFiles.push(...topoSortGroup(group));
  return orderedFiles.map((f) => byFile.get(f)).filter((d): d is AgentFileDiff => d !== undefined);
}
