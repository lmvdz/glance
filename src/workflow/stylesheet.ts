/**
 * Model stylesheet — fabro's CSS-like per-node model routing. A graph-level
 * `model_stylesheet` declares which model / reasoning effort each node runs at,
 * keyed by `*` (universal), `.class`, or `#id` / bare id. The executor resolves
 * a node's effective model+effort and switches the agent thread before its turn —
 * "cheap by default, frontier on the hard nodes" as a one-line change.
 *
 *   *        { model: claude-haiku-4-5; reasoning_effort: low; }
 *   .coding  { model: claude-sonnet-4-5; reasoning_effort: high; }
 *
 * Resolution precedence (low → high): universal < class < id; later rule wins a
 * tie; a node's own `model=` / `reasoning_effort=` attribute overrides the sheet.
 */

import type { WorkflowNode } from "./types.ts";

export interface StyleRule {
	/** `*` | `.class` | `#id` | bare id. */
	selector: string;
	model?: string;
	reasoningEffort?: string;
	/** universal 0 · class 10 · id 100. */
	specificity: number;
	/** Source order, for tie-breaking. */
	order: number;
}

export interface ResolvedStyle {
	model?: string;
	reasoningEffort?: string;
}

/** Parse a CSS-like stylesheet into flat rules (one per selector). */
export function parseStylesheet(css: string): StyleRule[] {
	const rules: StyleRule[] = [];
	let order = 0;
	// Each block is `selectorList { decls }`.
	const blockRe = /([^{}]+)\{([^{}]*)\}/g;
	let m: RegExpExecArray | null;
	while ((m = blockRe.exec(css)) !== null) {
		const selectors = m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
		const decls: ResolvedStyle = {};
		for (const decl of m[2]!.split(";")) {
			const colon = decl.indexOf(":");
			if (colon < 0) continue;
			const prop = decl.slice(0, colon).trim();
			const value = decl.slice(colon + 1).trim();
			if (!value) continue;
			if (prop === "model") decls.model = value;
			else if (prop === "reasoning_effort") decls.reasoningEffort = value;
		}
		if (decls.model === undefined && decls.reasoningEffort === undefined) continue;
		for (const selector of selectors) {
			const specificity = selector === "*" ? 0 : selector.startsWith(".") ? 10 : 100;
			rules.push({ selector, model: decls.model, reasoningEffort: decls.reasoningEffort, specificity, order: order++ });
		}
	}
	return rules;
}

/** Resolve a node's effective model + reasoning effort against parsed rules. Node attrs win. */
export function resolveNodeStyle(node: WorkflowNode, rules: StyleRule[]): ResolvedStyle {
	const classes = (node.attrs.class ?? "").split(/\s+/).filter(Boolean);
	const matched = rules
		.filter((r) => {
			if (r.selector === "*") return true;
			if (r.selector.startsWith(".")) return classes.includes(r.selector.slice(1));
			const id = r.selector.startsWith("#") ? r.selector.slice(1) : r.selector;
			return node.id === id;
		})
		.sort((a, b) => a.specificity - b.specificity || a.order - b.order);

	const resolved: ResolvedStyle = {};
	for (const r of matched) {
		if (r.model !== undefined) resolved.model = r.model;
		if (r.reasoningEffort !== undefined) resolved.reasoningEffort = r.reasoningEffort;
	}
	// A node's explicit attributes override the stylesheet.
	if (node.model !== undefined) resolved.model = node.model;
	if (node.reasoningEffort !== undefined) resolved.reasoningEffort = node.reasoningEffort;
	return resolved;
}
