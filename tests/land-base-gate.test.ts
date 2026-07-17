/**
 * Base-aware land gate (src/land.ts verifyMerged). The gate distinguishes "this branch regressed a
 * green base" from "the base was already red". A branch onto a green base behaves byte-for-byte as
 * before (land if green, roll back if red). A branch onto an already-red base LANDS with a logged
 * note instead of being refused — otherwise a brownfield repo could never land anything.
 *
 * Driven deterministically via the `verify` override: the gate `test ! -f RED` fails iff a tracked
 * `RED` marker exists in the checkout, so committing/omitting RED on base vs. branch toggles
 * base/merged red/green. Real git in a tmp dir, no mocks.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setGateLogRoot } from "../src/gate-logs.ts";
import { landAgent } from "../src/land.ts";
import { proofFor, setProofRoot } from "../src/proof.ts";

const GATE = "test ! -f RED"; // exit 0 (green) when RED absent, exit 1 (red) when present
const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function git(cwd: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", "-C", cwd, ...a], { stdout: "ignore", stderr: "ignore" }).exited;
}

async function out(cwd: string, ...a: string[]): Promise<string> {
	const p = Bun.spawn(["git", "-C", cwd, ...a], { stdout: "pipe", stderr: "pipe" });
	const [s] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return s.trim();
}

/** A repo on `main` with one base commit. `red` ⇒ the base commit also tracks the RED marker. */
async function baseRepo(prefix: string, red: boolean): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	if (red) await fs.writeFile(path.join(repo, "RED"), "broken\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	return repo;
}

/** A worktree on its own branch ahead by one commit adding `file`. */
async function branchWorktree(repo: string, branch: string, file: string): Promise<string> {
	await git(repo, "branch", branch);
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "land-wt-")), branch);
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, branch);
	await fs.writeFile(path.join(wt, file), `${file}\n`);
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", `add ${file}`);
	return wt;
}

test("base green + clean branch → lands, verified (unchanged)", async () => {
	const repo = await baseRepo("land-base-greengreen-", false);
	const wt = await branchWorktree(repo, "feat", "feature.txt");

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: GATE });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect(res.detail).toContain("verified");
	expect((await out(repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")).toContain("feature.txt");
});

test("base green + branch breaks the gate → blocked, main reset to head0 (unchanged)", async () => {
	const repo = await baseRepo("land-base-greenred-", false);
	const head0 = await out(repo, "rev-parse", "HEAD");
	const wt = await branchWorktree(repo, "feat", "RED"); // branch introduces the RED marker

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: GATE });

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.detail).toContain("rolled main back");
	expect(await out(repo, "rev-parse", "HEAD")).toBe(head0); // main rolled back, stays green
});

test("base already red + clean branch → lands onto the red baseline with a logged note", async () => {
	const repo = await baseRepo("land-base-redred-", true); // base tracks RED ⇒ already red
	const head0 = await out(repo, "rev-parse", "HEAD");
	const wt = await branchWorktree(repo, "feat", "feature.txt");

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: GATE });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect(res.detail).toContain("landed onto a red baseline");
	expect(await out(repo, "rev-parse", "HEAD")).not.toBe(head0); // main advanced past the red base
	expect((await out(repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")).toContain("feature.txt");
});

// ── finding #1 (eap-borrows wave 2): a branch that ADDS a new failure on top of an already-red base
// must be refused, not silently landed as "red baseline, nothing to see here" — the OLD acceptance
// path had NO failure-set comparison at all on this branch (unlike the full-suite regression gate),
// so ANY red-on-red merge landed regardless of whether the branch made things worse. A gate whose
// output distinguishes failures (Bun's own `(fail) <name>` lines) is needed to prove this — `GATE`
// above (`test ! -f RED`) produces no diagnostic text at all, so its failures are indistinguishable
// by design; this scenario needs a gate that actually NAMES what broke.

const NAMED_GATE = "sh gate.sh"; // "(fail) base.test.ts > known" iff BASE_RED, "(fail) new.test.ts > introduced" iff NEW_RED

/** A base repo whose gate.sh emits distinctly-named failures depending on tracked marker files. */
async function namedGateRepo(prefix: string, opts: { baseRed?: boolean } = {}): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(
		path.join(repo, "gate.sh"),
		[
			"#!/bin/sh",
			"out=''; code=0",
			"[ -f BASE_RED ] && { out=\"${out}(fail) base.test.ts > known\\n\"; code=1; }",
			"[ -f NEW_RED ]  && { out=\"${out}(fail) new.test.ts > introduced\\n\"; code=1; }",
			"printf \"$out\"",
			"exit \"$code\"",
		].join("\n"),
	);
	if (opts.baseRed) await fs.writeFile(path.join(repo, "BASE_RED"), "broken\n");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	return repo;
}

test("finding #1: base already red + branch introduces a NEW distinct failure → REFUSED, not landed as a red baseline", async () => {
	const repo = await namedGateRepo("land-base-red-worse-", { baseRed: true });
	const head0 = await out(repo, "rev-parse", "HEAD");
	// Branch does NOT fix BASE_RED and ADDS NEW_RED — a genuinely worse merged state than the base.
	await git(repo, "branch", "feat");
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "land-wt-")), "feat");
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, "feat");
	await fs.writeFile(path.join(wt, "NEW_RED"), "broken\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "add NEW_RED");

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: NAMED_GATE });

	// OLD behavior (fail-open): this merged and returned ok:true "landed onto a red baseline" —
	// the branch's NEW failure was invisible to a binary red/green gate. NEW behavior: refused.
	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.detail).toContain("new.test.ts > introduced");
	expect(await out(repo, "rev-parse", "HEAD")).toBe(head0); // main stays at its prior (red) baseline
});

test("finding #1 guard-rail: base already red + branch does NOT add a new failure → still lands (the allowance survives)", async () => {
	const repo = await namedGateRepo("land-base-red-same-", { baseRed: true });
	await git(repo, "branch", "feat");
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "land-wt-")), "feat");
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, "feat");
	await fs.writeFile(path.join(wt, "feature.txt"), "unrelated\n"); // doesn't touch BASE_RED or add NEW_RED
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "unrelated feature");

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: NAMED_GATE });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect(res.detail).toContain("landed onto a red baseline");
});

// offload half (eap-borrows concern 07 / 03's budgetedExcerpt+writeGateLog): the red-baseline detail
// used to plain-`truncate()` the gate output at 800 chars, losing everything past the cap. Now the
// FULL output is durably persisted and a pointer rides along in the LandResult/proof detail text.
test("offload half: a red-baseline land's oversized gate output is durably persisted, with a pointer in the detail", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "land-base-offload-"));
	tmps.push(repo);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "land-base-offload-state-"));
	tmps.push(stateDir);
	setGateLogRoot(stateDir);
	setProofRoot(stateDir);
	try {
		await git(repo, "init", "-q", "-b", "main");
		await git(repo, "config", "user.email", "t@t");
		await git(repo, "config", "user.name", "t");
		await git(repo, "config", "commit.gpgsign", "false");
		// A gate whose FAILED output is oversized (> 800 chars, the budget for this detail site).
		await fs.writeFile(path.join(repo, "gate.sh"), ["#!/bin/sh", `printf '(fail) base.test.ts > known\\n'`, `printf '%.0sY' $(seq 1 900)`, "printf '\\n'", "exit 1"].join("\n"));
		await fs.writeFile(path.join(repo, "base.txt"), "base\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-qm", "base (red)");
		const wt = await branchWorktree(repo, "feat", "feature.txt");

		const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "sh gate.sh" });

		expect(res.ok).toBe(true);
		expect(res.merged).toBe(true);
		// The pointer lives on the durable post-merge PROOF record (recordMainProof), not the returned
		// LandResult.detail itself — that's the "inspectable proof" this offload is meant to feed.
		const proof = await proofFor(repo, repo);
		expect(proof?.ok).toBe(false); // red baseline — main was not green, recorded honestly
		const pointerMatch = proof?.detail.match(/full: ([^\]]+)\]/);
		expect(pointerMatch).toBeTruthy();
		const fullContent = await fs.readFile(pointerMatch?.[1] ?? "", "utf8");
		expect(fullContent.length).toBeGreaterThan(900);
		expect(fullContent).toContain("base.test.ts > known");
	} finally {
		setGateLogRoot(path.join(os.tmpdir(), "gate-logs-unset"));
	}
});

// noisegate-compaction concern 05: land.ts's GREEN-PATH proof detail (verifyMerged's `v.code === 0`
// branch, land.ts ~line 649) now routes the acceptance gate's output through `reduceOutput` instead
// of a plain `truncate()` — DESIGN.md flags this as "now offloads full suite output per land,
// accepted (TTL-swept, forensically useful)" and requires proof that the resulting
// `[N bytes omitted — full: <path>]` pointer survives `recordProof`'s OWN, separate 4000-char
// `detail.slice(0, 4000)` cap (src/proof.ts) rather than getting silently amputated by a second,
// uncoordinated truncation layered on top of the first.
test("offload half (green path): a landed green gate's oversized output still carries its pointer through recordProof's 4000-char detail cap", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "land-base-green-offload-"));
	tmps.push(repo);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "land-base-green-offload-state-"));
	tmps.push(stateDir);
	setGateLogRoot(stateDir);
	setProofRoot(stateDir);
	try {
		await git(repo, "init", "-q", "-b", "main");
		await git(repo, "config", "user.email", "t@t");
		await git(repo, "config", "user.name", "t");
		await git(repo, "config", "commit.gpgsign", "false");
		// A PASSING gate (exit 0) whose stdout is oversized (> 800 chars, the budget for this detail
		// site) — no `command`/`test` word so greenGateUnproven() never second-guesses the pass, and no
		// package.json so applyRegressionGate finds no full suite to run (isolates the acceptance path).
		const noise = Array.from({ length: 30 }, (_, i) => `printf 'padding-line-${String(i).padStart(2, "0")}-filler-filler-filler\\n'`).join("\n");
		await fs.writeFile(path.join(repo, "gate.sh"), ["#!/bin/sh", noise, "printf 'TAIL-MARKER-VISIBLE\\n'", "exit 0"].join("\n"));
		await fs.writeFile(path.join(repo, "base.txt"), "base\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-qm", "base");
		const wt = await branchWorktree(repo, "feat", "feature.txt");

		const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "sh gate.sh" });

		expect(res.ok).toBe(true);
		expect(res.merged).toBe(true);

		const proof = await proofFor(repo, repo);
		expect(proof?.ok).toBe(true);
		// The proof's `detail` went through recordProof's OWN 4000-char cap on top of reduceOutput's
		// 800-char one — well within it (prefix + <=800 body), so the pointer must still be intact.
		expect(proof?.detail.length).toBeLessThanOrEqual(4000);
		const pointerMatch = proof?.detail.match(/\[(\d+) bytes omitted — full: ([^\]]+)\]/);
		expect(pointerMatch).toBeTruthy();
		const fullContent = await fs.readFile(pointerMatch?.[2] ?? "", "utf8");
		expect(fullContent.length).toBeGreaterThan(900);
		expect(fullContent).toContain("TAIL-MARKER-VISIBLE");
	} finally {
		setGateLogRoot(path.join(os.tmpdir(), "gate-logs-unset"));
	}
});
