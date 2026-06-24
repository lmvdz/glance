import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { gitNoSignEnv } from "../src/agent-host.ts";

const run = promisify(execFile);

describe("gitNoSignEnv", () => {
	test("declares both signing keys disabled", () => {
		expect(gitNoSignEnv.GIT_CONFIG_COUNT).toBe("2");
		const keys = [gitNoSignEnv.GIT_CONFIG_KEY_0, gitNoSignEnv.GIT_CONFIG_KEY_1];
		expect(keys).toContain("commit.gpgsign");
		expect(keys).toContain("tag.gpgsign");
		expect(gitNoSignEnv.GIT_CONFIG_VALUE_0).toBe("false");
		expect(gitNoSignEnv.GIT_CONFIG_VALUE_1).toBe("false");
	});

	// Real git: a repo with commit.gpgsign=true in its config must still report
	// false once gitNoSignEnv is applied — proving the override actually wins.
	test("overrides a repo config that enables signing", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gpgsign-"));
		try {
			await run("git", ["init", "-q"], { cwd: dir });
			await run("git", ["config", "commit.gpgsign", "true"], { cwd: dir });

			const on = await run("git", ["config", "--get", "commit.gpgsign"], { cwd: dir });
			expect(on.stdout.trim()).toBe("true");

			const off = await run("git", ["config", "--get", "commit.gpgsign"], {
				cwd: dir,
				env: { ...process.env, ...gitNoSignEnv },
			});
			expect(off.stdout.trim()).toBe("false");
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});
});
