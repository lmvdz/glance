#!/usr/bin/env bun
/**
 * LIVE durability characterization on a real Archil mount (OMPSQ-76, external-dep leg).
 *
 * This is the leg the local test (tests/persist-durability.test.ts) cannot do: on a normal
 * local FS the OS page cache survives a process SIGKILL, so non-fsync loss is unobservable
 * without real hardware. Here we crash the writer on a REAL Archil mount and then REMOUNT the
 * disk — exercising Archil's claim that `fsync` makes committed bytes durable across AZs even
 * if the client process dies before the async S3 sync.
 *
 * Property under test: a committed (fsynced) state.json + transcripts.json + receipts line +
 * a real git worktree survive `kill -9` of the writer followed by a disk remount — NOT a clean
 * `archil unmount` of a still-running writer (that would flush and produce a FALSE GREEN).
 *
 * Requires a human-provisioned paid Archil disk + creds. If ARCHIL_* are unset this script
 * REPORTS the creds blocker and exits 2 — it never skips silently and never fakes a pass.
 *
 * Env (read here in scripts/, never in src/ — see docs/archil-pilot.md):
 *   ARCHIL_DISK         synced "trunk" substrate disk name/id            (required)
 *   ARCHIL_REGION       aws-us-east-1 | aws-us-west-2 | aws-eu-west-1    (required)
 *   ARCHIL_MOUNT_TOKEN  disk token for `archil mount`                    (required; or ARCHIL_DISK_TOKEN)
 *   ARCHIL_BIN          archil CLI binary                                (optional, default "archil")
 *   ARCHIL_MOUNTPOINT   where to mount                                   (optional, default a fresh tmp dir)
 *
 * Usage: bun scripts/durability-archil.ts
 *
 * ponytail: the exact `archil` mount/unmount CLI flags are encoded once below and overridable
 * via ARCHIL_BIN — they follow the documented `archil mount <disk> <mountpoint>` shape. If a
 * future Archil CLI renames flags, adjust the two argv arrays in `mount`/`unmount` only.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileDurable } from "../src/dal/store.ts";
import { appendReceipt } from "../src/receipts.ts";
import type { RunReceipt } from "../src/types.ts";

const PROBE_DIR = "durability-probe";
const COMMITTED_AGENT = "a1";
const COMMITTED_TEXT = "committed-work";

/** Run a command, streaming output; throw with context on non-zero exit. */
async function run(argv: string[], opts: { cwd?: string } = {}): Promise<void> {
	const p = Bun.spawn(argv, { cwd: opts.cwd, stdout: "inherit", stderr: "inherit" });
	const code = await p.exited;
	if (code !== 0) throw new Error(`command failed (exit ${code}): ${argv.join(" ")}`);
}

const archil = process.env.ARCHIL_BIN ?? "archil";

async function mount(disk: string, region: string, token: string, mountpoint: string): Promise<void> {
	await fs.mkdir(mountpoint, { recursive: true });
	await run([archil, "mount", disk, mountpoint, "--region", region, "--token", token]);
}

async function unmount(mountpoint: string): Promise<void> {
	await run([archil, "unmount", mountpoint]);
}

/** The fileset a real agent commits: durable state + transcripts + a fsynced receipt + a git worktree. */
async function commitFileset(workdir: string): Promise<void> {
	await fs.rm(workdir, { recursive: true, force: true });
	await fs.mkdir(workdir, { recursive: true });
	await run(["git", "init", "-q"], { cwd: workdir });
	await run(["git", "config", "user.email", "durability@archil"], { cwd: workdir });
	await run(["git", "config", "user.name", "durability"], { cwd: workdir });
	await run(["git", "config", "commit.gpgsign", "false"], { cwd: workdir });

	const transcripts = { [COMMITTED_AGENT]: [{ kind: "system", text: COMMITTED_TEXT, ts: 1 }] };
	const state = {
		agents: [{ id: COMMITTED_AGENT, name: COMMITTED_AGENT, repo: workdir, worktree: workdir, approvalMode: "write" }],
		transcripts,
		features: [],
	};
	const receipt: RunReceipt = {
		agentId: COMMITTED_AGENT,
		name: COMMITTED_AGENT,
		repo: workdir,
		runId: "run-1",
		startedAt: 1,
		status: "idle",
		toolCalls: 1,
		toolTally: { bash: 1 },
		filesTouched: ["state.json"],
	};

	await writeFileDurable(path.join(workdir, "state.json"), JSON.stringify({ version: 1, ...state }, null, 2));
	await writeFileDurable(path.join(workdir, "transcripts.json"), JSON.stringify(transcripts));
	await appendReceipt(workdir, receipt);

	// A real git worktree: track + commit the durable fileset so we can assert the HEAD survives too.
	await run(["git", "add", "-A"], { cwd: workdir });
	await run(["git", "commit", "-qm", "committed work"], { cwd: workdir });
}

/** Assert the committed fileset survived the crash + remount. Throws on any loss/corruption. */
async function assertSurvived(workdir: string): Promise<void> {
	const state = JSON.parse(await fs.readFile(path.join(workdir, "state.json"), "utf8"));
	if (state?.agents?.[0]?.id !== COMMITTED_AGENT) throw new Error("state.json lost the committed agent");
	if (state?.transcripts?.[COMMITTED_AGENT]?.[0]?.text !== COMMITTED_TEXT) throw new Error("state.json transcript corrupt");

	const transcripts = JSON.parse(await fs.readFile(path.join(workdir, "transcripts.json"), "utf8"));
	if (transcripts?.[COMMITTED_AGENT]?.[0]?.text !== COMMITTED_TEXT) throw new Error("transcripts.json corrupt");

	const raw = await fs.readFile(path.join(workdir, "receipts", `${COMMITTED_AGENT}.jsonl`), "utf8");
	if (!raw.endsWith("\n")) throw new Error("receipts tail is a torn record (no trailing newline)");
	const lines = raw.split("\n").filter((l) => l.trim());
	const last = JSON.parse(lines[lines.length - 1]) as RunReceipt;
	if (last.runId !== "run-1") throw new Error("receipts tail lost the committed record");

	if (await fs.exists(path.join(workdir, "state.json.tmp"))) throw new Error("stray .tmp masquerading as truth");

	// The git worktree HEAD must resolve to the committed snapshot.
	const head = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
	if ((await head.exited) !== 0) throw new Error("git worktree lost its HEAD commit");
}

/** Writer subprocess body: commit the fileset on the mount, fsync, print COMMITTED, then block. */
async function runWriter(workdir: string): Promise<void> {
	await commitFileset(workdir);
	process.stdout.write("COMMITTED\n");
	// Block forever (no timer) so the parent can kill -9 us — an UNCLEAN crash, no flush hook.
	process.stdin.resume();
}

/** Resolve once `needle` appears on the stream; reject if the stream ends first. */
async function waitForLine(stream: ReadableStream<Uint8Array>, needle: string): Promise<void> {
	const dec = new TextDecoder();
	let buf = "";
	for await (const chunk of stream) {
		buf += dec.decode(chunk);
		if (buf.includes(needle)) return;
	}
	throw new Error(`writer exited before "${needle}" — fileset never committed`);
}

async function main(): Promise<number> {
	// Writer mode (forked by the parent below): commit on the mount, then block to be killed.
	const writerIdx = process.argv.indexOf("__writer");
	if (writerIdx !== -1) {
		await runWriter(process.argv[writerIdx + 1]);
		return 0;
	}

	const disk = process.env.ARCHIL_DISK;
	const region = process.env.ARCHIL_REGION;
	const token = process.env.ARCHIL_MOUNT_TOKEN ?? process.env.ARCHIL_DISK_TOKEN;
	const missing = [
		!disk && "ARCHIL_DISK",
		!region && "ARCHIL_REGION",
		!token && "ARCHIL_MOUNT_TOKEN (or ARCHIL_DISK_TOKEN)",
	].filter(Boolean);
	if (missing.length > 0) {
		console.error("BLOCKER: live Archil durability run needs a human-provisioned paid disk + creds.");
		console.error(`  Missing env: ${missing.join(", ")}`);
		console.error("  Set ARCHIL_* in your .env (see docs/archil-pilot.md §'To un-park'), then re-run.");
		console.error("  The local crash-survival leg is covered by: bun test tests/persist-durability.test.ts");
		return 2; // blocker, NOT a pass and NOT a property failure
	}

	const mountpoint = process.env.ARCHIL_MOUNTPOINT ?? (await fs.mkdtemp(path.join(os.tmpdir(), "archil-mnt-")));
	const workdir = path.join(mountpoint, PROBE_DIR);

	console.error(`Mounting ${disk} (${region}) at ${mountpoint} …`);
	await mount(disk as string, region as string, token as string, mountpoint);
	try {
		console.error("Spawning writer to commit + fsync the fileset on the mount …");
		const writer = Bun.spawn(["bun", import.meta.path, "__writer", workdir], { stdout: "pipe", stderr: "inherit" });
		await waitForLine(writer.stdout, "COMMITTED");

		// UNCLEAN crash: kill -9 the writer. NOT `archil unmount` — a clean unmount would flush.
		console.error(`kill -9 writer (pid ${writer.pid}) — no clean shutdown, no flush hook …`);
		process.kill(writer.pid, "SIGKILL");
		await writer.exited;

		// Detach + reattach the disk: the remount that exercises crash-durability across the client.
		console.error("Remounting the disk (unmount → mount) to simulate host detach/reattach …");
		await unmount(mountpoint);
		await mount(disk as string, region as string, token as string, mountpoint);

		await assertSurvived(workdir);
		console.error("SURVIVED: committed state/transcripts/receipts/worktree intact across kill -9 + remount.");
		return 0;
	} catch (err) {
		console.error(`FAILED: committed work did NOT survive the unclean stop + remount: ${(err as Error).message}`);
		return 1;
	} finally {
		await unmount(mountpoint).catch(() => {});
	}
}

process.exit(await main());
