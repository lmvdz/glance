/**
 * Flue worker scaffolding — turns a CommissionSpec into a runnable Flue worker
 * project (the artifact an architect "hires"). Pinned to the Flue versions this
 * repo verified against. The deterministic TemplateArchitect writes these files
 * verbatim; the OmpArchitect seeds the same skeleton and lets an omp agent fill
 * in the workflow body.
 */

import type { CommissionSpec } from "./types.ts";

const FLUE_RUNTIME = "^1.0.0-beta.2";
const FLUE_CLI = "^1.0.0-beta.1";
const VALIBOT = "^1.4.1";

export interface GeneratedFile {
	/** Path relative to the worker dir. */
	path: string;
	content: string;
}

/** All files for a worker project, ready to write under the worker dir. */
export function generateWorkerFiles(spec: CommissionSpec): GeneratedFile[] {
	const name = spec.name;
	const target = spec.deployTarget ?? "node";
	const hasModel = typeof spec.model === "string";
	const purposeLiteral = JSON.stringify(spec.purpose);

	const files: GeneratedFile[] = [];

	files.push({
		path: "package.json",
		content: `${JSON.stringify(
			{
				name,
				type: "module",
				private: true,
				dependencies: { "@flue/runtime": FLUE_RUNTIME, valibot: VALIBOT },
				devDependencies: { "@flue/cli": FLUE_CLI, typescript: "^6.0.3" },
			},
			null,
			2,
		)}\n`,
	});

	files.push({
		path: "tsconfig.json",
		content: `${JSON.stringify(
			{
				compilerOptions: {
					target: "ES2024",
					module: "ESNext",
					moduleResolution: "Bundler",
					strict: true,
					skipLibCheck: true,
					noEmit: true,
				},
				// TypeScript ignores hidden dirs by default; the .flue layout must be explicit.
				include: [".flue/**/*.ts"],
				exclude: ["dist", "node_modules"],
			},
			null,
			2,
		)}\n`,
	});

	files.push({ path: ".gitignore", content: "node_modules\ndist\n.env\n" });

	files.push({
		path: "flue.worker.json",
		content: `${JSON.stringify(
			{
				name,
				purpose: spec.purpose,
				model: spec.model ?? false,
				capabilities: spec.capabilities ?? [],
				workflow: name,
				target,
				accept: spec.accept,
			},
			null,
			2,
		)}\n`,
	});

	if (hasModel) {
		files.push({
			path: `.flue/agents/${name}.ts`,
			content: `import { createAgent } from "@flue/runtime";

/** ${spec.purpose} */
export default createAgent(() => ({
\tmodel: ${JSON.stringify(spec.model)},
\tinstructions: ${purposeLiteral},
}));
`,
		});
		files.push({ path: ".env.example", content: "# Provider credential for this worker, e.g.\nANTHROPIC_API_KEY=\n" });
		files.push({ path: `.flue/workflows/${name}.ts`, content: llmWorkflow(spec, purposeLiteral) });
	} else {
		files.push({ path: `.flue/workflows/${name}.ts`, content: deterministicWorkflow(spec) });
	}

	return files;
}

function deterministicWorkflow(spec: CommissionSpec): string {
	const body = (spec.workflowBody ?? "return { ...payload };")
		.split("\n")
		.map((line) => (line.length ? `\t${line}` : line))
		.join("\n");
	return `import { type FlueContext, type WorkflowRouteHandler } from "@flue/runtime";

export const route: WorkflowRouteHandler = async (_c, next) => next();

/** ${spec.purpose} (deterministic — no model). */
export async function run({ payload }: FlueContext<Record<string, unknown>>) {
${body}
}
`;
}

function llmWorkflow(spec: CommissionSpec, purposeLiteral: string): string {
	return `import { createAgent, type FlueContext, type WorkflowRouteHandler } from "@flue/runtime";
import * as v from "valibot";

export const route: WorkflowRouteHandler = async (_c, next) => next();

const worker = createAgent(() => ({ model: ${JSON.stringify(spec.model)}, instructions: ${purposeLiteral} }));

/** ${spec.purpose} */
export async function run({ init, payload }: FlueContext<Record<string, unknown>>) {
\tconst harness = await init(worker);
\tconst session = await harness.session();
\tconst prompt = typeof payload.text === "string" ? payload.text : JSON.stringify(payload);
\tconst { data } = await session.prompt(prompt, { result: v.object({ text: v.string() }) });
\treturn data;
}
`;
}
