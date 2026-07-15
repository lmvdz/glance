/**
 * Round-3 review minor: `OmpArchitect.author()` constructed its `RpcAgent` with no `harness`, so
 * `harnessAuthEnv`'s no-model fallback couldn't narrow to Anthropic and admitted every configured
 * provider credential to the architect agent's env instead — even though `OmpArchitect` (see its module
 * doc in architect.ts) always drives a real `omp --mode rpc` agent, never any other harness. This proves
 * the fix with a REAL spawn (mirrors spawn-env.test.ts's mutation-proof style): a fake `omp` bin dumps
 * its own env before doing anything else, and — with every provider credential set in the daemon's
 * env — only `ANTHROPIC_API_KEY` must survive into the architect agent's process.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OmpArchitect } from "../src/architect.ts";
import type { CommissionSpec } from "../src/types.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** A fake `omp --mode rpc` child: dumps its own env before anything else, emits the ready frame, then
 *  answers any `prompt` command with a success response followed by an `agent_end` event so
 *  `OmpArchitect.author()`'s turn-wait resolves quickly without needing a real model call. */
function fakeOmpArchitectBin(dumpPath: string): string {
	return `#!/usr/bin/env bun
require("fs").writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.env));
console.log(JSON.stringify({ type: "ready" }));
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
	buf += decoder.decode(chunk, { stream: true });
	let nl;
	while ((nl = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (!line) continue;
		let f; try { f = JSON.parse(line); } catch { continue; }
		if (f.type === "prompt") {
			console.log(JSON.stringify({ type: "response", id: f.id, success: true, command: "prompt", data: {} }));
			console.log(JSON.stringify({ type: "agent_end" }));
		}
	}
}
`;
}

test("OmpArchitect.author() names harness 'omp' — only ANTHROPIC_API_KEY reaches the architect agent even though every provider credential is configured", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-architect-harness-"));
	tmps.push(dir);
	const binPath = path.join(dir, "fake-omp-architect.ts");
	const dumpPath = path.join(dir, "env.json");
	await fs.writeFile(binPath, fakeOmpArchitectBin(dumpPath));
	await fs.chmod(binPath, 0o755);

	const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-architect-workdir-"));
	tmps.push(workDir);

	const prevKeys: Record<string, string | undefined> = {};
	const ALL_PROVIDER_ENV = {
		ANTHROPIC_API_KEY: "sk-anthropic-architect-proof",
		OPENAI_API_KEY: "sk-openai-must-not-leak",
		GOOGLE_API_KEY: "sk-google-must-not-leak",
		GEMINI_API_KEY: "sk-gemini-must-not-leak",
		XAI_API_KEY: "sk-xai-must-not-leak",
		OPENROUTER_API_KEY: "sk-openrouter-must-not-leak",
		AUGMENT_API_KEY: "sk-augment-must-not-leak",
	};
	for (const [k, v] of Object.entries(ALL_PROVIDER_ENV)) {
		prevKeys[k] = process.env[k];
		process.env[k] = v;
	}
	try {
		const architect = new OmpArchitect({ bin: binPath, timeoutMs: 20_000 });
		const spec: CommissionSpec = { name: "test-worker", purpose: "a test worker for the harness-narrowing proof" };
		await architect.author(spec, workDir);

		const dumped = JSON.parse(await fs.readFile(dumpPath, "utf8")) as Record<string, string>;
		expect(dumped.ANTHROPIC_API_KEY).toBe("sk-anthropic-architect-proof");
		for (const k of ["OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "AUGMENT_API_KEY"]) {
			expect(dumped[k]).toBeUndefined();
		}
	} finally {
		for (const [k, v] of Object.entries(prevKeys)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}, 30_000);
