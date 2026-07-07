/**
 * Guards the command-node PATH hardening: a `--verify` gate runs under `bash -lc`
 * (a login shell that re-derives PATH from /etc/profile). Without the fix, a gate
 * that shells out to a project-local binary like `omp` fails to resolve it and the
 * gate exits non-zero even though the code is green — the exact false-negative that
 * escalated a green unit to a human. The run's own node_modules/.bin must be first
 * on PATH regardless of what the login profile does.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withLocalBinOnPath } from "../src/workflow/executor.ts";

describe("command-node PATH hardening", () => {
	test("withLocalBinOnPath prepends the run's node_modules/.bin", () => {
		const wrapped = withLocalBinOnPath("echo hi", "/work/tree");
		expect(wrapped).toContain("export PATH='/work/tree/node_modules/.bin':\"$PATH\"");
		expect(wrapped.endsWith("\necho hi")).toBe(true);
	});

	test("single quotes in the cwd path are escaped safely", () => {
		const wrapped = withLocalBinOnPath("true", "/weird/it's here");
		// The path is single-quoted with each ' → '\'' so bash reconstructs it verbatim.
		expect(wrapped).toContain("'/weird/it'\\''s here/node_modules/.bin'");
	});

	test("a project-local bin resolves under `bash -lc` even when the profile omits it", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glance-gate-"));
		try {
			const bin = path.join(dir, "node_modules", ".bin");
			await fs.mkdir(bin, { recursive: true });
			// A fake project-local tool that only resolves if node_modules/.bin is on PATH.
			const tool = path.join(bin, "glancetool");
			await fs.writeFile(tool, "#!/usr/bin/env bash\necho found-local\n");
			await fs.chmod(tool, 0o755);

			// Reproduce the daemon gate: a login shell whose profile CLOBBERS PATH to a
			// minimal set (mimicking /etc/profile dropping ~/.bun/bin). The prelude, injected
			// after profile sourcing by withLocalBinOnPath, must still make the tool resolve.
			const script = withLocalBinOnPath("glancetool", dir);
			const proc = Bun.spawn(["bash", "-lc", `export PATH=/usr/bin:/bin\n${script}`], {
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
			});
			const stdout = await new Response(proc.stdout).text();
			const code = await proc.exited;
			expect(code).toBe(0);
			expect(stdout.trim()).toBe("found-local");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
