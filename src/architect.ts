/**
 * Architects author a Flue worker into a directory — the "build the hire" step.
 *
 *  - TemplateArchitect: deterministic. Renders the worker from the spec. Used by
 *    the test suite and as an offline fallback.
 *  - OmpArchitect: drives a real `omp --mode rpc` agent (approval yolo, write) to
 *    write the workflow itself, from a compact Flue recipe + the spec. This is the
 *    agents-build-agents path.
 *
 * Neither validates — that's the acceptance gate's job (validate.ts).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RpcAgent } from "./rpc-agent.ts";
import type { CommissionSpec } from "./types.ts";
import { generateWorkerFiles } from "./worker-template.ts";

export interface Architect {
	readonly kind: string;
	/** Write a Flue worker project into `dir`. */
	author(spec: CommissionSpec, dir: string, feedback?: string): Promise<void>;
}

export class TemplateArchitect implements Architect {
	readonly kind = "template";

	async author(spec: CommissionSpec, dir: string, _feedback?: string): Promise<void> {
		for (const file of generateWorkerFiles(spec)) {
			const target = path.join(dir, file.path);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, file.content);
		}
	}
}

export interface OmpArchitectOptions {
	/** omp binary override. */
	bin?: string;
	/** Model for the architect agent (omp default when omitted). */
	model?: string;
	/** Max time to let the architect author before giving up. */
	timeoutMs?: number;
}

export class OmpArchitect implements Architect {
	readonly kind = "omp";
	private readonly opts: OmpArchitectOptions;

	constructor(opts: OmpArchitectOptions = {}) {
		this.opts = opts;
	}

	async author(spec: CommissionSpec, dir: string, feedback?: string): Promise<void> {
		// Seed everything except the workflow; the agent's job is to write the workflow.
		const workflowRel = path.join(".flue", "workflows", `${spec.name}.ts`);
		for (const file of generateWorkerFiles(spec)) {
			if (file.path === workflowRel) continue;
			const target = path.join(dir, file.path);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, file.content);
		}
		await fs.mkdir(path.join(dir, ".flue", "workflows"), { recursive: true });

		const agent = new RpcAgent({ id: `architect-${Date.now().toString(36)}`, cwd: dir, approvalMode: "yolo", thinking: "medium", model: this.opts.model, bin: this.opts.bin });
		await agent.start();
		try {
			await this.runTurn(agent, buildTask(spec, workflowRel, feedback), this.opts.timeoutMs ?? 300_000);
		} finally {
			await agent.stop();
		}
	}

	/** Send the authoring task and resolve when the agent's turn ends (or time out). */
	private runTurn(agent: RpcAgent, task: string, timeoutMs: number): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onEvent = (frame: { type?: string }) => {
			if (frame.type === "agent_end") finish();
		};
		const onExit = () => reject(new Error("architect agent exited before finishing"));
		const timer = setTimeout(() => reject(new Error(`architect timed out after ${timeoutMs}ms`)), timeoutMs);
		const finish = () => {
			clearTimeout(timer);
			agent.off("event", onEvent);
			agent.off("exit", onExit);
			resolve();
		};
		agent.on("event", onEvent);
		agent.once("exit", onExit);
		agent.prompt(task).catch(reject);
		return promise;
	}
}

const RECIPE = `You are a lazy senior developer authoring ONE Flue workflow module. Lazy means efficient, not careless: write the minimum that satisfies the acceptance test, and never cut input validation, error handling, or security to get there.

Before writing, stop at the first rung that holds: (1) does this need to exist? (2) does the stdlib do it? (3) native platform feature? (4) an already-installed dependency (@flue/runtime and valibot are already in package.json)? (5) can it be one line? (6) only then, the minimum that works. No abstractions, dependencies, or boilerplate nobody asked for. The skeleton (package.json, tsconfig.json, flue.worker.json) is fixed — do not edit it and do not install new packages; the acceptance gate rejects a worker that adds unrequested dependencies or over-builds.

Flue is a TypeScript agent framework.

Contract for the file you write:
- Import from "@flue/runtime".
- Export Hono middleware: export const route: WorkflowRouteHandler = async (_c, next) => next();
- Export an async function run({ payload }: FlueContext<Record<string, unknown>>) (add { init } too if you use a model).
- For a deterministic (no-model) ability, do the work in plain TypeScript and return a JSON-serializable object. Do NOT call init/session.
- For a model-backed ability, create an agent with createAgent(() => ({ model, instructions })), then: const harness = await init(agent); const session = await harness.session(); const { data } = await session.prompt(text, { result: v.object({...}) }); return data; (import * as v from "valibot").
- Read the input from \`payload\`. Return the result object directly.`;

function buildTask(spec: CommissionSpec, workflowRel: string, feedback?: string): string {
	const accept = spec.accept ? `\nThe acceptance test will run the workflow with payload ${JSON.stringify(spec.accept.payload)} and expects the result to match ${JSON.stringify(spec.accept.expect ?? "(any success)")}.` : "";
	const model = typeof spec.model === "string" ? `Use the model "${spec.model}".` : "This is a DETERMINISTIC worker — do not use any model.";
	const retry = feedback ? `\n${feedback}` : "";
	return `${RECIPE}

Job: ${spec.purpose}
${model}
Write the workflow to ${workflowRel} (the project skeleton, package.json, tsconfig.json and flue.worker.json already exist; do not change them).${accept}${retry}

Implement the workflow now, then stop.`;
}
