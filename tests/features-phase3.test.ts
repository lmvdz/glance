/**
 * Phase 3 — pipeline ingestion: concern parsing, live PLANE-link derivation, from-plan adopt.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildFeatures, parsePlanConcerns } from "../src/features.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { PersistedFeature } from "../src/types.ts";

const tmps: string[] = [];
const managers: SquadManager[] = [];
afterEach(async () => {
	for (const m of managers) await m.stop().catch(() => {});
	managers.length = 0;
	for (const t of tmps) await fs.rm(t, { recursive: true, force: true }).catch(() => {});
	tmps.length = 0;
});

const PLAN_DIR = path.join("plans", "auth");

async function seedPlan(repo: string): Promise<void> {
	const dir = path.join(repo, PLAN_DIR);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "00-overview.md"), "# Overview\nSTATUS: open\n");
	await fs.writeFile(path.join(dir, "01-login.md"), "# Login flow\nPLANE: AUTH-12 — https://x/AUTH-12/\nSTATUS: open\nPRIORITY: p1\nCOMPLEXITY: moderate\nTOUCHES:\n  - src/login.ts\n");
	await fs.writeFile(path.join(dir, "02-logout.md"), "# Logout\nSTATUS: done\n");
	await fs.writeFile(path.join(dir, "notes.md"), "# Notes\njust notes, no status line\n");
}

test("parsePlanConcerns: extracts frontmatter, skips overview + status-less docs", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "p3-"));
	tmps.push(repo);
	await seedPlan(repo);
	const concerns = await parsePlanConcerns(repo, PLAN_DIR);
	expect(concerns.map((c) => c.file)).toEqual(["01-login.md", "02-logout.md"]); // overview (skip-list) + notes (no STATUS) excluded
	const login = concerns.find((c) => c.file === "01-login.md");
	expect(login?.title).toBe("Login flow");
	expect(login?.status).toBe("open");
	expect(login?.priority).toBe("p1");
	expect(login?.complexity).toBe("moderate");
	expect(login?.planeId).toBe("AUTH-12");
	expect(login?.open).toBe(true);
	const logout = concerns.find((c) => c.file === "02-logout.md");
	expect(logout?.open).toBe(false); // "done" is a closed status
	expect(logout?.planeId).toBeUndefined();
});

test("buildFeatures: a persisted feature derives PLANE links live from its plan dir", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "p3-"));
	tmps.push(repo);
	await seedPlan(repo);
	// pf.plane is intentionally unset — the link must come from scanning the plan dir.
	const pf: PersistedFeature = { id: "f1", title: "Auth", repo, origin: { planDir: PLAN_DIR }, createdAt: 0, updatedAt: 0 };
	const feats = await buildFeatures(repo, [], [pf]);
	const f = feats.find((x) => x.id === "f1");
	expect(f).toBeDefined();
	expect(f?.issueIdentifiers).toContain("AUTH-12");
	expect(f?.stage).toBe("issues-created"); // plan dir + issues, no agents working
	expect(f?.persisted).toBe(true);
});

test("from-plan ingest: createFeature + features() adopts the dir and de-dupes the derived feature", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "p3-state-"));
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "p3-repo-"));
	tmps.push(stateDir, repo);
	await seedPlan(repo);
	const mgr = new SquadManager({ stateDir });
	managers.push(mgr);
	const pf = mgr.createFeature({ title: "Auth revamp", repo, planDir: PLAN_DIR });
	const feats = await mgr.features(repo);
	const got = feats.find((f) => f.id === pf.id);
	expect(got).toBeDefined();
	expect(got?.planDir).toBe(PLAN_DIR);
	expect(got?.issueIdentifiers).toContain("AUTH-12");
	expect(got?.persisted).toBe(true);
	// The adopted dir must NOT also surface as a derived `plan:` feature.
	expect(feats.some((f) => f.id === `plan:${repo}:${PLAN_DIR}`)).toBe(false);
});
