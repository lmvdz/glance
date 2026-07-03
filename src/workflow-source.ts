/**
 * Workflow graph sources — resolving `--workflow` specs to `.fabro` files, rendering a
 * capability step-graph into DOT, and the bundled commission graph. Extracted from the
 * squad-manager god-file (it re-exports the public names, so import paths are unchanged).
 * Lives in src/ root so `import.meta.dir`-relative bundled-workflow paths stay identical.
 */

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkflowDefinition } from "./workflow-catalog.ts";
import { parseWorkflow } from "./workflow/dot.ts";
import type { Workflow } from "./workflow/types.ts";

/**
 * Resolve a `--workflow` spec to a graph file: an existing path is used as-is;
 * otherwise a bare name resolves to a bundled graph (`<pkg>/workflows/<name>/workflow.fabro`),
 * making `--workflow research-plan-implement` (and plan-implement / fan-out) first-class.
 */
export function resolveWorkflowPath(spec: string): string {
	if (existsSync(spec)) return spec;
	const bundledDir = path.join(import.meta.dir, "..", "workflows", spec, "workflow.fabro");
	if (existsSync(bundledDir)) return bundledDir;
	const bundledFile = path.join(import.meta.dir, "..", "workflows", spec.endsWith(".fabro") ? spec : `${spec}.fabro`);
	if (existsSync(bundledFile)) return bundledFile;
	return spec;
}

/** Filesystem-safe slug for a capability binding key (`cap:slug:id`) used as a workflow filename. */
export function slugifyForFile(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "capability-workflow";
}

/**
 * Render a capability WorkflowDefinition (inline step graph) into a DOT/`.fabro` source the WorkflowEngine
 * can run. The capability dialect (steps with id/label/owner/next) has no explicit entry/exit, so we
 * synthesize a single `start` (Mdiamond) and single `exit` (Msquare):
 *   - start → every step with no inbound edge (graph roots),
 *   - each step → its declared `next` steps,
 *   - every leaf step (no outbound `next`) → exit.
 * Each step becomes an agent node whose prompt is its label + owner, so the engine executes a real turn.
 * Step ids are sanitized to valid DOT identifiers with a stable id↔dotId map so edges stay consistent.
 */
export function capabilityWorkflowToDot(def: WorkflowDefinition): string {
	const steps = def.steps;
	const dotIds = new Map<string, string>();
	const used = new Set<string>(["start", "exit"]);
	for (const step of steps) {
		let base = step.id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]+/, "");
		if (!base) base = "step";
		let id = base;
		let n = 1;
		while (used.has(id)) id = `${base}_${n++}`;
		used.add(id);
		dotIds.set(step.id, id);
	}
	const inbound = new Set<string>();
	for (const step of steps) for (const nxt of step.next) if (dotIds.has(nxt)) inbound.add(nxt);
	const roots = steps.filter((step) => !inbound.has(step.id));
	const leaves = steps.filter((step) => step.next.filter((nxt) => dotIds.has(nxt)).length === 0);

	const lines: string[] = [`digraph ${slugifyForFile(def.id).replace(/[^A-Za-z0-9_]/g, "_") || "capability"} {`];
	lines.push(`  goal = ${dotString(def.label || def.id)};`);
	lines.push(`  start [shape=Mdiamond, label="Start"];`);
	lines.push(`  exit [shape=Msquare, label="Exit"];`);
	for (const step of steps) {
		const id = dotIds.get(step.id)!;
		const owner = step.owner ? ` (owner: ${step.owner})` : "";
		const prompt = `${step.label}${owner}. Complete this step toward the goal, then stop.`;
		lines.push(`  ${id} [shape=box, label=${dotString(step.label)}, prompt=${dotString(prompt)}];`);
	}
	for (const root of roots.length ? roots : steps.slice(0, 1)) lines.push(`  start -> ${dotIds.get(root.id)};`);
	for (const step of steps) {
		for (const nxt of step.next) {
			const to = dotIds.get(nxt);
			if (to) lines.push(`  ${dotIds.get(step.id)} -> ${to};`);
		}
	}
	for (const leaf of leaves.length ? leaves : steps.slice(-1)) lines.push(`  ${dotIds.get(leaf.id)} -> exit;`);
	lines.push("}");
	return lines.join("\n");
}

/** Quote a DOT attribute value, escaping `"` and `\` so multi-word labels/prompts parse cleanly. */
function dotString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

let commissionWorkflow: Workflow | undefined;

/** Parse (once) the bundled commission graph that drives author → validate → onboard. */
export async function loadCommissionWorkflow(): Promise<Workflow> {
	if (!commissionWorkflow) {
		const file = path.join(import.meta.dir, "..", "workflows", "commission", "workflow.fabro");
		commissionWorkflow = parseWorkflow(await fs.readFile(file, "utf8"));
	}
	return commissionWorkflow;
}
