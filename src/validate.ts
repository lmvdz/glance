/**
 * Acceptance gate — the "interview" a commissioned worker must pass before it's
 * onboarded. Tiered and degrading: lint is mandatory and pure; typecheck and
 * flue-run acceptance run only when the worker's toolchain is installed,
 * otherwise they report "skip" rather than blocking the loop offline.
 */

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { extractLastJsonObject } from "./flue-service-driver.ts";
import type { CommissionSpec, GateCheck, GateReport } from "./types.ts";

export interface GateOptions {
	/** Fail the gate if the acceptance check is skipped (no flue toolchain). */
	requireAcceptance?: boolean;
}

export async function validateWorker(dir: string, spec: CommissionSpec, opts: GateOptions = {}): Promise<GateReport> {
	const checks: GateCheck[] = [];

	const lint = await lintWorker(dir, spec);
	checks.push(lint);

	const typecheck = await typecheckWorker(dir);
	checks.push(typecheck);

	const acceptance = await acceptanceWorker(dir, spec);
	checks.push(acceptance.check);

	const ponytail = await ponytailWorker(dir, spec);
	checks.push(ponytail);

	const lintOk = lint.status === "pass";
	const noFail = checks.every((c) => c.status !== "fail");
	const acceptanceOk = !opts.requireAcceptance || acceptance.check.status === "pass";
	return { ok: lintOk && noFail && acceptanceOk, checks, result: acceptance.result };
}

async function lintWorker(dir: string, spec: CommissionSpec): Promise<GateCheck> {
	const fails: string[] = [];

	const workflowPath = path.join(dir, ".flue", "workflows", `${spec.name}.ts`);
	const workflow = await read(workflowPath);
	if (workflow === undefined) {
		fails.push(`missing workflow ${path.relative(dir, workflowPath)}`);
	} else if (!/export\s+(async\s+)?function\s+run\b/.test(workflow) && !/export\s+const\s+run\b/.test(workflow)) {
		fails.push("workflow does not export run()");
	}

	if (typeof spec.model === "string") {
		if (!/^[^/\s]+\/[^\s]+$/.test(spec.model)) fails.push(`model "${spec.model}" is not a provider/model specifier`);
		const agent = await read(path.join(dir, ".flue", "agents", `${spec.name}.ts`));
		if (agent === undefined) fails.push("missing agent module");
		else if (!/export\s+default\s+createAgent\b/.test(agent)) fails.push("agent module does not default-export createAgent");
	}

	const manifestRaw = await read(path.join(dir, "flue.worker.json"));
	if (manifestRaw === undefined) {
		fails.push("missing flue.worker.json manifest");
	} else {
		let manifest: unknown;
		try {
			manifest = JSON.parse(manifestRaw);
		} catch {
			fails.push("flue.worker.json is not valid JSON");
		}
		if (manifest && typeof manifest === "object") {
			if (!("capabilities" in manifest) || !Array.isArray(manifest.capabilities)) {
				fails.push("manifest missing a capabilities allowlist");
			}
			if (!("workflow" in manifest) || typeof manifest.workflow !== "string") {
				fails.push("manifest missing workflow name");
			}
		}
	}

	return fails.length ? { name: "lint", status: "fail", detail: fails.join("; ") } : { name: "lint", status: "pass" };
}

async function typecheckWorker(dir: string): Promise<GateCheck> {
	const tscBin = path.join(dir, "node_modules", ".bin", "tsc");
	if (!existsSync(tscBin)) return { name: "typecheck", status: "skip", detail: "typescript not installed in worker" };
	const proc = Bun.spawn([tscBin, "-p", "tsconfig.json", "--noEmit"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	return code === 0
		? { name: "typecheck", status: "pass" }
		: { name: "typecheck", status: "fail", detail: (out + err).trim().split("\n").slice(0, 8).join("\n") };
}

async function acceptanceWorker(dir: string, spec: CommissionSpec): Promise<{ check: GateCheck; result?: unknown }> {
	if (!spec.accept) return { check: { name: "acceptance", status: "skip", detail: "no acceptance check in spec" } };
	const flueBin = path.join(dir, "node_modules", ".bin", "flue");
	if (!existsSync(flueBin)) return { check: { name: "acceptance", status: "skip", detail: "flue not installed in worker" } };

	const target = spec.deployTarget ?? "node";
	const proc = Bun.spawn([flueBin, "run", spec.name, "--target", target, "--payload", JSON.stringify(spec.accept.payload)], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	if (code !== 0) {
		return { check: { name: "acceptance", status: "fail", detail: `flue run exited ${code}: ${(err || out).trim().slice(0, 200)}` } };
	}
	const result = extractLastJsonObject(out);
	if (spec.accept.expect && !deepSubset(result, spec.accept.expect)) {
		return { check: { name: "acceptance", status: "fail", detail: `result did not match expectation: ${JSON.stringify(result)}` }, result };
	}
	return { check: { name: "acceptance", status: "pass" }, result };
}

/**
 * ponytail gate — the lazy-senior-dev check. A commissioned worker should reach for
 * the pinned skeleton, not install its way out of a problem or over-build. Fails when
 * the worker declares a dependency outside the skeleton allowlist, or its workflow
 * blows the size budget. Mechanizes the same ladder the OmpArchitect RECIPE instructs.
 *
 * ponytail: fixed allowlist + a flat LOC ceiling. Ceiling: a genuinely complex worker
 * could legitimately exceed it; upgrade path is a per-spec override (e.g. spec.accept
 * extended with a budget) when a worker earns the headroom.
 */
const PONYTAIL_DEP_ALLOWLIST = new Set(["@flue/runtime", "valibot", "@flue/cli", "typescript"]);
const PONYTAIL_MAX_WORKFLOW_LOC = 80;

async function ponytailWorker(dir: string, spec: CommissionSpec): Promise<GateCheck> {
	const smells: string[] = [];

	const pkgRaw = await read(path.join(dir, "package.json"));
	if (pkgRaw !== undefined) {
		try {
			const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
			const declared = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
			const extra = declared.filter((d) => !PONYTAIL_DEP_ALLOWLIST.has(d));
			if (extra.length) smells.push(`unrequested dependencies: ${extra.join(", ")} (the skeleton already covers the worker contract)`);
		} catch {
			/* malformed package.json is the lint check's concern, not this one */
		}
	}

	const workflow = await read(path.join(dir, ".flue", "workflows", `${spec.name}.ts`));
	if (workflow !== undefined) {
		const loc = workflow.split("\n").filter((l) => l.trim().length > 0).length;
		if (loc > PONYTAIL_MAX_WORKFLOW_LOC) {
			smells.push(`workflow is ${loc} non-blank lines (> ${PONYTAIL_MAX_WORKFLOW_LOC}); ship the minimum that passes acceptance`);
		}
	}

	return smells.length ? { name: "ponytail", status: "fail", detail: smells.join("; ") } : { name: "ponytail", status: "pass" };
}

async function read(p: string): Promise<string | undefined> {
	try {
		return await fs.readFile(p, "utf8");
	} catch {
		return undefined;
	}
}

/** True when every key/value in `expected` is present and deep-equal in `actual`. */
export function deepSubset(actual: unknown, expected: unknown): boolean {
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual) || actual.length !== expected.length) return false;
		return expected.every((v, i) => deepSubset(actual[i], v));
	}
	if (expected && typeof expected === "object") {
		if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
		const a: Record<string, unknown> = { ...actual };
		return Object.entries(expected).every(([k, v]) => deepSubset(a[k], v));
	}
	return actual === expected;
}
