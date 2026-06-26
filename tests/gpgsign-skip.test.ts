import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { GIT_HARDEN_ARGS, gitNoSignEnv } from "../src/git-harden.ts";

const run = promisify(execFile);

describe("gitNoSignEnv", () => {
	test("declares both signing keys disabled", () => {
		const env = gitNoSignEnv({});
		expect(env.GIT_CONFIG_COUNT).toBe("2");
		const keys = [env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_KEY_1];
		expect(keys).toContain("commit.gpgsign");
		expect(keys).toContain("tag.gpgsign");
		expect(env.GIT_CONFIG_VALUE_0).toBe("false");
		expect(env.GIT_CONFIG_VALUE_1).toBe("false");
	});

	// Real git: a repo with commit.gpgsign=true in its config must still report
	// false once gitNoSignEnv is applied — proving the override actually wins.
	test("overrides a repo config that enables signing", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gpgsign-"));
		try {
			await run("git", ["init", "-q"], { cwd: dir });
			await run("git", ["config", "commit.gpgsign", "true"], { cwd: dir });

			// Baseline read with the ambient gitNoSignEnv overrides stripped, so it reflects the
			// repo config (the test runner may already carry GIT_CONFIG_* in its env).
			const cleanEnv = { ...process.env };
			for (const k of Object.keys(cleanEnv)) if (k.startsWith("GIT_CONFIG_")) delete cleanEnv[k];
			const on = await run("git", ["config", "--get", "commit.gpgsign"], { cwd: dir, env: cleanEnv });
			expect(on.stdout.trim()).toBe("true");

			const off = await run("git", ["config", "--get", "commit.gpgsign"], {
				cwd: dir,
				env: { ...process.env, ...gitNoSignEnv() },
			});
			expect(off.stdout.trim()).toBe("false");
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("GIT_HARDEN_ARGS signing", () => {
	test("forces commit + tag signing off", () => {
		expect(GIT_HARDEN_ARGS).toContain("commit.gpgsign=false");
		expect(GIT_HARDEN_ARGS).toContain("tag.gpgsign=false");
	});

	// Real git: a repo with commit.gpgsign=true and a guaranteed-failing signer. A plain
	// commit fails (git runs the broken gpg.program); the hardened commit succeeds and is
	// unsigned — proving GIT_HARDEN_ARGS disables signing without a TTY/pinentry prompt.
	test("a hardened commit succeeds unsigned where a plain signed commit fails", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gpgharden-"));
		try {
			await run("git", ["init", "-q"], { cwd: dir });
			await run("git", ["config", "user.email", "t@example.com"], { cwd: dir });
			await run("git", ["config", "user.name", "Test"], { cwd: dir });
			await run("git", ["config", "commit.gpgsign", "true"], { cwd: dir });
			await run("git", ["config", "gpg.program", "/bin/false"], { cwd: dir });
			await fsp.writeFile(path.join(dir, "a.txt"), "1");
			await run("git", ["add", "-A"], { cwd: dir });

			// The daemon sets gitNoSignEnv (GIT_CONFIG_* disabling signing) process-wide, which the
			// test runner (and the squad harness exporting commit.gpgsign=false) inherits — that would
			// silently disable signing for the "plain" commit too. Strip any ambient GIT_CONFIG_*
			// overrides so the plain commit reflects the repo config (signing on, broken signer) and the
			// hardened commit's success is attributable to GIT_HARDEN_ARGS alone, not the ambient env.
			const cleanEnv = { ...process.env };
			for (const k of Object.keys(cleanEnv)) if (k.startsWith("GIT_CONFIG_")) delete cleanEnv[k];

			// Plain signed commit must fail: git invokes /bin/false as the signer.
			let plainFailed = false;
			await run("git", ["commit", "-m", "plain"], { cwd: dir, env: cleanEnv }).catch(() => {
				plainFailed = true;
			});
			expect(plainFailed).toBe(true);

			// Hardened commit: signing forced off by GIT_HARDEN_ARGS, no signer invoked -> succeeds, unsigned.
			await run("git", [...GIT_HARDEN_ARGS, "commit", "-m", "hardened"], { cwd: dir, env: cleanEnv });
			const sig = await run("git", ["log", "-1", "--format=%G?"], { cwd: dir, env: cleanEnv });
			expect(sig.stdout.trim()).toBe("N");
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});
});
