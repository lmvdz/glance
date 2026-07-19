import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	COMMITTED_SKILL_NAMES,
	IDENTIFIER_ALLOWLIST,
	IDENTIFIER_ALLOWLIST_BASELINE,
	NO_VERIFY_BASELINE,
	resolveEffectVersion,
	runSkillsVerify,
	stampVerifiedAgainst,
} from "../scripts/skills-verify.ts";

/**
 * skills-verify's own gate test — see scripts/skills-verify.ts's module doc for the five tiers and
 * plans/skills-hardening/01-skills-verify-gate.md for the spec. This IS the entry point: nothing
 * else under `bun test` invokes runSkillsVerify, and importing it here is what typechecks/loads it
 * (mirrors tests/defect-ratchet.test.ts's relationship to defect-ratchet.ts).
 *
 * Floor/invariant assertions live here, not in the script — the script computes a report, this file
 * decides what "green" means, same division of labor as the defect-ratchet pair.
 */
const report = runSkillsVerify();

test("skills-verify: the gate is green on the current .claude/skills tree", () => {
	if (!report.ok) {
		const lines = [
			...report.frontmatterViolations,
			...report.structureViolations,
			...report.sizeViolations,
			...report.fenceViolations,
			...report.identifierViolations,
			...report.noVerifyViolations,
			...report.verifiedAgainstViolations,
		].map((v) => `  [${v.skill}] ${v.file ?? ""}${v.line ? `:${v.line}` : ""} ${v.message}`);
		const tsLines = report.tsErrors.map((e) => `  TS [${e.skill}/${e.doc}#${e.blockId}] ${e.message}`);
		const wfLines = report.workflowErrors.map((e) => `  WF [${e.skill}] ${e.file} ${e.message}`);
		throw new Error(`skills-verify found violations:\n${[...lines, ...tsLines, ...wfLines].join("\n")}`);
	}
	expect(report.ok).toBe(true);
});

test("skills-verify: fail-closed — at least one skill was actually scanned", () => {
	// runSkillsVerify() throws on zero skills (see the script), so reaching this line at all is
	// part of the proof; this assertion guards against a future refactor quietly swallowing that.
	expect(report.skillsScanned.length).toBeGreaterThan(0);
});

test("skills-verify: committed manifest is set-equal to what's on disk (no silent drift)", () => {
	expect(report.manifestDrift.missing).toEqual([]);
	expect(report.manifestDrift.unexpected).toEqual([]);
	expect(report.skillsScanned).toEqual([...COMMITTED_SKILL_NAMES].sort());
});

test("skills-verify: resolved effect version matches the committed pin (node_modules + bun.lock agree)", () => {
	expect(report.resolvedEffectVersion).toMatch(/^\d+\.\d+\.\d+/);
});

test("skills-verify: no-verify counts stay at/under their committed per-skill baseline", () => {
	for (const [skill, entry] of Object.entries(report.noVerify)) {
		expect(entry.count, `${skill}: ${entry.count} no-verify blocks exceeds baseline ${entry.baseline}`).toBeLessThanOrEqual(entry.baseline);
	}
	expect(Object.keys(NO_VERIFY_BASELINE).every((k) => k in report.noVerify) || Object.keys(NO_VERIFY_BASELINE).length === 0).toBe(true);
});

test("skills-verify: identifier-tier allowlist stays at/under its committed size ratchet", () => {
	expect(IDENTIFIER_ALLOWLIST.length).toBeLessThanOrEqual(IDENTIFIER_ALLOWLIST_BASELINE);
	// Every allowlisted token is unique — a duplicate would silently inflate the "size" without
	// covering a second real false positive.
	expect(new Set(IDENTIFIER_ALLOWLIST).size).toBe(IDENTIFIER_ALLOWLIST.length);
});

test('skills-verify: "effect" tripwire is armed now that concern 02 vendored the skill', () => {
	expect(report.skillsScanned.includes("effect")).toBe(true);
	expect(report.effectSkillHasVerifiedBlock).toBe(true);
});

test("skills-verify: the vendored effect skill contributes verified ts blocks (8 prose/bash-only skills plus effect)", () => {
	expect(report.tsBlocksVerified).toBeGreaterThan(0);
	expect(report.tsErrors).toEqual([]);
});

test("skills-verify: the two references/*.workflow.js files parse cleanly", () => {
	expect(report.workflowFilesChecked).toBeGreaterThanOrEqual(2);
	expect(report.workflowErrors).toEqual([]);
});

// -------------------------------------------------------------------------------------------
// Fail-closed / advisory-mode behavior — exercised against synthetic fixtures so these mutation
// scenarios don't require hand-editing the committed skill docs.
// -------------------------------------------------------------------------------------------

function makeScratchSkillsRoot(): string {
	const root = join(tmpdir(), `skills-verify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return root;
}

test("skills-verify: zero skills under a root throws (never a vacuous pass)", () => {
	const root = makeScratchSkillsRoot();
	try {
		expect(() => runSkillsVerify([root])).toThrow(/zero skills found/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("skills-verify: --roots mode is advisory — manifest set-equality is not enforced", () => {
	const root = makeScratchSkillsRoot();
	const skillDir = join(root, "totally-unrelated-skill");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "---\nname: totally-unrelated-skill\ndescription: a fixture, not a real skill\n---\n\nBody.\n");
	try {
		const r = runSkillsVerify([root]);
		expect(r.gating).toBe(false);
		expect(r.ok).toBe(true);
		expect(r.manifestDrift).toEqual({ missing: [], unexpected: [] });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("skills-verify: a ts block with a real type error fails red, naming the skill and block id", () => {
	const root = makeScratchSkillsRoot();
	const skillDir = join(root, "scratch-ts-error");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		[
			"---",
			"name: scratch-ts-error",
			"description: fixture for the planted-type-error mutation test",
			"---",
			"",
			"```ts id=broken-example",
			"const n: number = \"this is a string, not a number\";",
			"```",
			"",
		].join("\n"),
	);
	try {
		const r = runSkillsVerify([root]);
		expect(r.ok).toBe(false);
		expect(r.tsBlocksVerified).toBe(1);
		expect(r.tsErrors.length).toBeGreaterThan(0);
		expect(r.tsErrors[0].skill).toBe("scratch-ts-error");
		expect(r.tsErrors[0].blockId).toBe("broken-example");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("skills-verify: a deliberately-wrong example with @ts-expect-error still verifies clean", () => {
	const root = makeScratchSkillsRoot();
	const skillDir = join(root, "scratch-ts-expect-error");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		[
			"---",
			"name: scratch-ts-expect-error",
			"description: fixture proving @ts-expect-error blocks stay verified",
			"---",
			"",
			"```ts id=deliberately-wrong",
			"// @ts-expect-error - demonstrating the type error this API used to allow",
			'const n: number = "nope";',
			"```",
			"",
		].join("\n"),
	);
	try {
		const r = runSkillsVerify([root]);
		expect(r.tsBlocksVerified).toBe(1);
		expect(r.tsErrors).toEqual([]);
		expect(r.ok).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("skills-verify: an untagged fence in a ts-bearing file hard-fails", () => {
	const root = makeScratchSkillsRoot();
	const skillDir = join(root, "scratch-untagged-fence");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		[
			"---",
			"name: scratch-untagged-fence",
			"description: fixture for the untagged-fence-in-ts-file rule",
			"---",
			"",
			"```ts id=fine",
			"export const x = 1;",
			"```",
			"",
			"```",
			"this fence has no language tag at all",
			"```",
			"",
		].join("\n"),
	);
	try {
		const r = runSkillsVerify([root]);
		expect(r.ok).toBe(false);
		expect(r.fenceViolations.some((v) => v.message.includes("untagged fence"))).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("skills-verify: no-verify without a reason fails; with a reason it's counted, not silently skipped", () => {
	const root = makeScratchSkillsRoot();
	const skillDir = join(root, "scratch-no-verify");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		[
			"---",
			"name: scratch-no-verify",
			"description: fixture for the no-verify reason requirement",
			"---",
			"",
			"```ts no-verify",
			"this would never typecheck and that's fine, it's opted out",
			"```",
			"",
		].join("\n"),
	);
	try {
		const withoutReason = runSkillsVerify([root]);
		expect(withoutReason.ok).toBe(false);
		expect(withoutReason.fenceViolations.some((v) => v.message.includes("non-empty reason"))).toBe(true);

		writeFileSync(
			join(skillDir, "SKILL.md"),
			[
				"---",
				"name: scratch-no-verify",
				"description: fixture for the no-verify reason requirement",
				"---",
				"",
				'```ts no-verify reason="illustrative only, never meant to run"',
				"this would never typecheck and that's fine, it's opted out",
				"```",
				"",
			].join("\n"),
		);
		const withReason = runSkillsVerify([root]);
		// The block itself is now grammatically valid (fence-level violation gone) — a NEW
		// no-verify still fails the report overall because this scratch skill has no committed
		// ratchet baseline (defaults to 0), which is the correct fail-closed behavior: opting a
		// block out of verification must be a deliberate baseline bump, never free.
		expect(withReason.fenceViolations.some((v) => v.message.includes("non-empty reason"))).toBe(false);
		expect(withReason.noVerify["scratch-no-verify"].count).toBe(1);
		expect(withReason.noVerify["scratch-no-verify"].reasons).toEqual(["illustrative only, never meant to run"]);
		expect(withReason.noVerifyViolations.some((v) => v.skill === "scratch-no-verify")).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("skills-verify: a fake OMP_SQUAD_* token with no env-read site fails red", () => {
	const root = makeScratchSkillsRoot();
	const skillDir = join(root, "scratch-fake-env");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		["---", "name: scratch-fake-env", "description: fixture for the fake-env-token mutation test", "---", "", "Set `OMP_SQUAD_NOPE` to enable a thing that does not exist.", ""].join("\n"),
	);
	try {
		const r = runSkillsVerify([root]);
		expect(r.ok).toBe(false);
		expect(r.identifierViolations.some((v) => v.message.includes("OMP_SQUAD_NOPE"))).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("skills-verify: a real OMP_SQUAD_* token with a genuine env-read site passes, in BOTH bare and assignment form", () => {
	const root = makeScratchSkillsRoot();
	const skillDir = join(root, "scratch-real-env");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		["---", "name: scratch-real-env", "description: fixture for a genuine env token", "---", "", "Set `OMP_SQUAD_AUTOSUPERVISE=0` to disable in-process auto-supervise; `OMP_SQUAD_AUTOSUPERVISE` is the same knob bare.", ""].join("\n"),
	);
	try {
		const r = runSkillsVerify([root]);
		expect(r.identifierViolations.filter((v) => v.message.includes("OMP_SQUAD_AUTOSUPERVISE"))).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("skills-verify: a fake env token in ASSIGNMENT form (`OMP_SQUAD_FAKE=1`) fails red — the spelling docs actually use", () => {
	const root = makeScratchSkillsRoot();
	const skillDir = join(root, "scratch-fake-env-assign");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		["---", "name: scratch-fake-env-assign", "description: fixture", "---", "", "Set `OMP_SQUAD_TOTALLY_FAKE=1` to enable nothing.", ""].join("\n"),
	);
	try {
		const r = runSkillsVerify([root]);
		expect(r.ok).toBe(false);
		expect(r.identifierViolations.some((v) => v.message.includes("OMP_SQUAD_TOTALLY_FAKE"))).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("skills-verify: an unterminated fence hard-fails — everything after it would be invisible to the identifier tier", () => {
	const root = makeScratchSkillsRoot();
	const skillDir = join(root, "scratch-unterminated");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		["---", "name: scratch-unterminated", "description: fixture", "---", "", "```bash", "echo hi", "", "Set `OMP_SQUAD_HIDDEN_FAKE=1` — this line is swallowed by the open fence.", ""].join("\n"),
	);
	try {
		const r = runSkillsVerify([root]);
		expect(r.ok).toBe(false);
		expect(r.fenceViolations.some((v) => v.message.includes("unterminated fence"))).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("skills-verify: 4-backtick fences are seen (a ````ts block is still a ts block), and js retags stay verified", () => {
	const root = makeScratchSkillsRoot();
	const skillDir = join(root, "scratch-fence-dodges");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		[
			"---", "name: scratch-fence-dodges", "description: fixture", "---", "",
			"````ts id=four-tick", 'const n: number = "not a number";', "````", "",
			"```js id=js-retag", 'const m: number = "also not";', "```", "",
		].join("\n"),
	);
	try {
		const r = runSkillsVerify([root]);
		expect(r.ok).toBe(false);
		expect(r.tsBlocksVerified).toBe(2);
		const ids = r.tsErrors.map((e) => e.blockId).sort();
		expect(ids).toEqual(["four-tick", "js-retag"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("skills-verify --stamp path: a stale stamp with a trailing space is rewritten, never silently no-oped", () => {
	const root = makeScratchSkillsRoot();
	const skillDir = join(root, "scratch-stamp");
	mkdirSync(skillDir, { recursive: true });
	const skillMd = join(skillDir, "SKILL.md");
	writeFileSync(skillMd, ["---", "name: scratch-stamp", "description: fixture", "verified-against: effect@0.0.0-stale \t", "---", "", "body", ""].join("\n"));
	try {
		const resolved = runSkillsVerify([root]).resolvedEffectVersion;
		const changed = stampVerifiedAgainst([root], resolved);
		expect(changed.length).toBe(1);
		expect(changed[0]).toMatchObject({ skill: "scratch-stamp", from: "effect@0.0.0-stale".slice("effect@".length), to: resolved });
		const after = readFileSync(skillMd, "utf8");
		expect(after).toContain(`verified-against: effect@${resolved}`);
		expect(after).not.toContain("0.0.0-stale");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("skills-verify: a dangling backticked repo-relative path fails red", () => {
	const root = makeScratchSkillsRoot();
	const skillDir = join(root, "scratch-dangling-path");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		["---", "name: scratch-dangling-path", "description: fixture for a dangling path mutation test", "---", "", "See `src/this-file-does-not-exist.ts` for details.", ""].join("\n"),
	);
	try {
		const r = runSkillsVerify([root]);
		expect(r.ok).toBe(false);
		expect(r.identifierViolations.some((v) => v.message.includes("src/this-file-does-not-exist.ts"))).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("skills-verify: a broken frontmatter field (missing description) fails red", () => {
	const root = makeScratchSkillsRoot();
	const skillDir = join(root, "scratch-broken-frontmatter");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), ["---", "name: scratch-broken-frontmatter", "---", "", "Body with no description in the frontmatter.", ""].join("\n"));
	try {
		const r = runSkillsVerify([root]);
		expect(r.ok).toBe(false);
		expect(r.frontmatterViolations.some((v) => v.message.includes("description"))).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("skills-verify: a stale verified-against stamp fails red, and only --stamp semantics green it after the program ran", () => {
	const root = makeScratchSkillsRoot();
	const skillDir = join(root, "scratch-stale-stamp");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		["---", "name: scratch-stale-stamp", "description: fixture for the verified-against staleness check", "verified-against: effect@0.0.0-fake", "---", "", "Body.", ""].join("\n"),
	);
	try {
		const before = runSkillsVerify([root]);
		expect(before.ok).toBe(false);
		expect(before.verifiedAgainstViolations.length).toBe(1);
		expect(before.readyToStamp).toBe(true); // nothing else is wrong — only the stamp is stale

		const changed = stampVerifiedAgainst([root], before.resolvedEffectVersion);
		expect(changed).toEqual([{ skill: "scratch-stale-stamp", pkg: "effect", from: "0.0.0-fake", to: before.resolvedEffectVersion }]);

		const after = runSkillsVerify([root]);
		expect(after.ok).toBe(true);
		expect(after.verifiedAgainstViolations).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("skills-verify: node_modules/bun.lock version guard resolves without throwing on this repo", () => {
	// resolveEffectVersion() is exercised implicitly by every runSkillsVerify() call above; this
	// test just pins the observable shape so a future refactor can't silently drop the guard.
	expect(report.resolvedEffectVersion.length).toBeGreaterThan(0);
	// On this (converged) repo there is no skew — the softening path must not fabricate one.
	expect(report.effectVersionSkew).toBeNull();
});

/** Build a throwaway repoRoot with a fabricated `node_modules/effect/package.json` + `bun.lock`. */
function fakeRepoRoot(nodeModulesVersion: string | null, lockVersion: string | null): string {
	const root = join(tmpdir(), `sv-effect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	if (nodeModulesVersion !== null) {
		mkdirSync(join(root, "node_modules/effect"), { recursive: true });
		writeFileSync(join(root, "node_modules/effect/package.json"), JSON.stringify({ name: "effect", version: nodeModulesVersion }));
	} else {
		mkdirSync(root, { recursive: true });
	}
	// bun.lock — the regex only needs `"effect": [ "effect@<ver>"`. Omit the whole line when null.
	const lockBody = lockVersion !== null ? `  "packages": {\n    "effect": ["effect@${lockVersion}", "", {}],\n  }\n` : `  "packages": {}\n`;
	writeFileSync(join(root, "bun.lock"), `{\n${lockBody}}\n`);
	return root;
}

test("resolveEffectVersion: a node_modules↔bun.lock SKEW is non-fatal — returns the INSTALLED version + surfaced skew (OMPSQ-448)", () => {
	// The exact shape that killed OMPSQ-448: a shared node_modules behind a bumped lockfile. This must
	// NOT throw — it returns the installed (node_modules) version, which is what tsc actually resolves.
	const root = fakeRepoRoot("4.0.0-beta.93", "4.0.0-beta.98");
	try {
		const { version, skew } = resolveEffectVersion(root);
		expect(version).toBe("4.0.0-beta.93");
		expect(skew).toEqual({ nodeModules: "4.0.0-beta.93", lock: "4.0.0-beta.98" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveEffectVersion: agreement ⇒ no skew", () => {
	const root = fakeRepoRoot("4.0.0-beta.98", "4.0.0-beta.98");
	try {
		const { version, skew } = resolveEffectVersion(root);
		expect(version).toBe("4.0.0-beta.98");
		expect(skew).toBeNull();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveEffectVersion: a genuinely ABSENT node_modules/effect still throws (real can't-verify, not a skew)", () => {
	const root = fakeRepoRoot(null, "4.0.0-beta.98");
	try {
		expect(() => resolveEffectVersion(root)).toThrow(/node_modules absent\/stale/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
