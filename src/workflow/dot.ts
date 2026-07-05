/**
 * DOT parser — a focused subset of Graphviz, matching the dialect fabro's
 * `.fabro` workflow files use. We parse only what the engine executes; full
 * Graphviz (subgraphs, default-attribute statements, ports) is intentionally
 * out of scope and rejected with a clear error rather than mis-parsed.
 *
 * Handles the parts that actually bite:
 *   - quoted attribute values that contain `[`, `]`, `;`, `&&`, regexes, and
 *     newlines (e.g. a multi-line `script` or `model_stylesheet`);
 *   - `\"` / `\\` escapes and `\<newline>` line continuation inside strings;
 *   - edge chains `a -> b -> c [attrs]`;
 *   - `//`, `#`, and `/* *​/` comments outside strings.
 */

import type { NodeKind, Workflow, WorkflowEdge, WorkflowNode } from "./types.ts";

export class WorkflowParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowParseError";
	}
}

const SHAPE_KIND: Record<string, NodeKind> = {
	Mdiamond: "start",
	Msquare: "exit",
	box: "agent",
	tab: "prompt",
	parallelogram: "command",
	hexagon: "human",
	diamond: "conditional",
	component: "parallel",
	tripleoctagon: "merge",
	insulator: "wait",
};

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse a DOT workflow source into a typed graph. */
export function parseWorkflow(src: string): Workflow {
	const { name, body } = extractDigraph(src);

	const graphAttrs: Record<string, string> = {};
	const nodes = new Map<string, WorkflowNode>();
	const edges: WorkflowEdge[] = [];

	for (const stmt of splitStatements(body)) {
		const kind = classify(stmt);
		if (kind === "graph") {
			Object.assign(graphAttrs, parseGraphStatement(stmt));
		} else if (kind === "edge") {
			edges.push(...parseEdgeStatement(stmt));
		} else if (kind === "node") {
			const node = parseNodeStatement(stmt);
			nodes.set(node.id, node);
		} else if (kind === "assign") {
			const eq = stmt.indexOf("=");
			const raw = stmt.slice(eq + 1).trim();
			graphAttrs[stmt.slice(0, eq).trim()] = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
		} else if (kind === "reserved") {
			throw new WorkflowParseError(
				`unsupported statement (subgraphs and default node/edge attributes are not supported yet): ${preview(stmt)}`,
			);
		}
		// kind === "empty": skip
	}

	// Edges may reference nodes that were never given an explicit attribute block
	// (rare, but valid DOT). Materialize them as default agent nodes.
	for (const e of edges) {
		for (const id of [e.from, e.to]) {
			if (!nodes.has(id)) nodes.set(id, { id, kind: "agent", attrs: {} });
		}
	}

	const start = findUnique(nodes, "start");
	const exit = findUnique(nodes, "exit");

	return {
		name,
		goal: graphAttrs.goal,
		maxNodeVisits: graphAttrs.max_node_visits ? toInt(graphAttrs.max_node_visits, "max_node_visits") : undefined,
		modelStylesheet: graphAttrs.model_stylesheet,
		nodes,
		edges,
		start,
		exit,
	};
}

function findUnique(nodes: Map<string, WorkflowNode>, kind: NodeKind): string {
	const matches = [...nodes.values()].filter((n) => n.kind === kind);
	if (matches.length !== 1) {
		throw new WorkflowParseError(`a workflow must have exactly one ${kind} node, found ${matches.length}`);
	}
	return matches[0]!.id;
}

// ── digraph extraction ───────────────────────────────────────────────────────

function extractDigraph(src: string): { name: string; body: string } {
	const open = src.indexOf("{");
	const close = src.lastIndexOf("}");
	if (open < 0 || close < 0 || close < open) throw new WorkflowParseError("missing `{ … }` graph body");
	const header = src.slice(0, open);
	const m = header.match(/\b(?:strict\s+)?(?:di)?graph\s+([A-Za-z_][A-Za-z0-9_]*)?/);
	const name = m?.[1] ?? "workflow";
	return { name, body: src.slice(open + 1, close) };
}

// ── statement splitting (quote/bracket/comment aware) ──────────────────────────

/** Split a graph body into statements, honoring strings, `[ ]` blocks, and comments. */
function splitStatements(body: string): string[] {
	const out: string[] = [];
	let cur = "";
	let i = 0;
	let inString = false;
	let bracket = 0;
	const n = body.length;
	while (i < n) {
		const c = body[i]!;
		if (inString) {
			if (c === "\\" && i + 1 < n) {
				const next = body[i + 1]!;
				if (next === "\n") {
					i += 2; // line continuation: drop backslash + newline
					continue;
				}
				cur += c + next; // keep escapes verbatim (\" , \\ , \b , …)
				i += 2;
				continue;
			}
			if (c === '"') inString = false;
			cur += c;
			i++;
			continue;
		}
		// not in a string
		if (c === '"') {
			inString = true;
			cur += c;
			i++;
			continue;
		}
		// comments
		if (c === "/" && body[i + 1] === "/") {
			while (i < n && body[i] !== "\n") i++;
			continue;
		}
		if (c === "#") {
			while (i < n && body[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && body[i + 1] === "*") {
			i += 2;
			while (i < n && !(body[i] === "*" && body[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		if (c === "[") bracket++;
		if (c === "]") bracket = Math.max(0, bracket - 1);
		// terminator
		if ((c === ";" || c === "\n") && bracket === 0) {
			if (cur.trim()) out.push(cur.trim());
			cur = "";
			i++;
			continue;
		}
		cur += c;
		i++;
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
}

type StmtKind = "graph" | "edge" | "node" | "assign" | "reserved" | "empty";

function classify(stmt: string): StmtKind {
	if (!stmt) return "empty";
	const head = stmt.match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0] ?? "";
	if (head === "subgraph" || head === "cluster") return "reserved";
	if (head === "graph") return "graph";
	if (head === "node" || head === "edge") {
		// `node` / `edge` followed by `[` is a default-attribute statement (unsupported);
		// otherwise it's an ordinary node/edge that merely starts with those letters
		// (our ID regex would not produce exactly "node"/"edge" as a head unless it is).
		if (/^(?:node|edge)\s*\[/.test(stmt)) return "reserved";
	}
	if (scanTopLevel(stmt, (s, i) => s[i] === "-" && s[i + 1] === ">")) return "edge";
	// An UNQUOTED `[` opens a node's attribute block. `stmt.includes("[")` matched a `[` inside a quoted
	// value too (e.g. a graph attr `label="Release [beta]"`), misclassifying it as a node — parseNode then
	// slices the id at that `[` and throws "invalid node id", failing the whole DOT parse on valid input.
	if (containsUnquoted(stmt, "[")) return "node";
	if (scanTopLevel(stmt, (s, i) => s[i] === "=")) return "assign";
	return "empty";
}

/** True if `ch` appears outside any double-quoted string in `s` (respecting `\` escapes). */
function containsUnquoted(s: string, ch: string): boolean {
	let inString = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!;
		if (inString) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === ch) return true;
	}
	return false;
}

/** True if `pred` matches at any index outside strings and `[ ]` blocks. */
function scanTopLevel(s: string, pred: (s: string, i: number) => boolean): boolean {
	let inString = false;
	let bracket = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!;
		if (inString) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
			continue;
		}
		if (c === "[") bracket++;
		else if (c === "]") bracket = Math.max(0, bracket - 1);
		else if (bracket === 0 && pred(s, i)) return true;
	}
	return false;
}

// ── node statement ─────────────────────────────────────────────────────────

function parseNodeStatement(stmt: string): WorkflowNode {
	const open = stmt.indexOf("[");
	const close = stmt.lastIndexOf("]");
	const id = stmt.slice(0, open).trim();
	if (!ID_RE.test(id)) throw new WorkflowParseError(`invalid node id ${preview(id)} in: ${preview(stmt)}`);
	if (close < open) throw new WorkflowParseError(`unbalanced [ ] in: ${preview(stmt)}`);
	const attrs = parseAttrs(stmt.slice(open + 1, close));
	return nodeFromAttrs(id, attrs);
}

function nodeFromAttrs(id: string, attrs: Record<string, string>): WorkflowNode {
	const shape = attrs.shape;
	let kind: NodeKind = "agent";
	if (shape) {
		const mapped = SHAPE_KIND[shape];
		if (!mapped) throw new WorkflowParseError(`unknown node shape "${shape}" for node "${id}"`);
		kind = mapped;
	}
	return {
		id,
		kind,
		label: attrs.label,
		prompt: attrs.prompt,
		script: attrs.script,
		model: attrs.model,
		reasoningEffort: attrs.reasoning_effort,
		goalGate: attrs.goal_gate === "true",
		retryTarget: attrs.retry_target,
		maxVisits: attrs.max_visits ? toInt(attrs.max_visits, "max_visits") : undefined,
		overflow: attrs.overflow,
		attrs,
	};
}

// ── edge statement ───────────────────────────────────────────────────────────

function parseEdgeStatement(stmt: string): WorkflowEdge[] {
	const open = stmt.indexOf("[");
	const chain = (open >= 0 ? stmt.slice(0, open) : stmt).trim();
	const attrs = open >= 0 ? parseAttrs(stmt.slice(open + 1, stmt.lastIndexOf("]"))) : {};
	const ids = chain.split("->").map((s) => s.trim());
	for (const id of ids) {
		if (!ID_RE.test(id)) throw new WorkflowParseError(`invalid node id ${preview(id)} in edge: ${preview(stmt)}`);
	}
	const label = attrs.label;
	const condition = attrs.condition;
	const edges: WorkflowEdge[] = [];
	for (let i = 0; i + 1 < ids.length; i++) {
		edges.push({ from: ids[i]!, to: ids[i + 1]!, label, condition });
	}
	if (edges.length === 0) throw new WorkflowParseError(`edge needs two endpoints: ${preview(stmt)}`);
	return edges;
}

// ── graph statement ──────────────────────────────────────────────────────────

function parseGraphStatement(stmt: string): Record<string, string> {
	const open = stmt.indexOf("[");
	if (open < 0) return {};
	return parseAttrs(stmt.slice(open + 1, stmt.lastIndexOf("]")));
}

// ── attribute list ───────────────────────────────────────────────────────────

/** Parse `key=value, key="quoted", …` honoring quoted/multi-line values. */
function parseAttrs(inner: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	let i = 0;
	const n = inner.length;
	while (i < n) {
		// skip separators / whitespace
		while (i < n && (/\s/.test(inner[i]!) || inner[i] === ",")) i++;
		if (i >= n) break;
		// key
		const keyStart = i;
		while (i < n && /[A-Za-z0-9_]/.test(inner[i]!)) i++;
		const key = inner.slice(keyStart, i).trim();
		if (!key) throw new WorkflowParseError(`malformed attribute near ${preview(inner.slice(keyStart))}`);
		// '='
		while (i < n && /\s/.test(inner[i]!)) i++;
		if (inner[i] !== "=") throw new WorkflowParseError(`attribute "${key}" missing '=' value`);
		i++;
		while (i < n && /\s/.test(inner[i]!)) i++;
		// value
		let value: string;
		if (inner[i] === '"') {
			i++;
			let v = "";
			while (i < n) {
				const c = inner[i]!;
				if (c === "\\" && i + 1 < n) {
					const next = inner[i + 1]!;
					if (next === "\n") {
						i += 2;
						continue;
					}
					if (next === '"') {
						v += '"';
						i += 2;
						continue;
					}
					if (next === "\\") {
						v += "\\";
						i += 2;
						continue;
					}
					v += c + next; // unknown escape: keep verbatim (\b, \w, …)
					i += 2;
					continue;
				}
				if (c === '"') {
					i++;
					break;
				}
				v += c;
				i++;
			}
			value = v;
		} else {
			const vStart = i;
			while (i < n && !/[\s,]/.test(inner[i]!)) i++;
			value = inner.slice(vStart, i);
		}
		attrs[key] = value;
	}
	return attrs;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function toInt(s: string, attr: string): number {
	const n = Number.parseInt(s, 10);
	if (!Number.isFinite(n)) throw new WorkflowParseError(`${attr} must be an integer, got ${preview(s)}`);
	return n;
}

function preview(s: string): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}
