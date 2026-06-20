/**
 * Smart-spawn resolver — deterministic pieces (repo discovery, naming, repo
 * heuristic, JSON extraction). The live model path (planSpawn → omp --smol) is
 * exercised end to end via the daemon, not here.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverRepos, parsePlanJson, pickRepoHeuristic, slug } from "../src/smart-spawn.ts";

afterEach(() => {
	delete process.env.OMP_SQUAD_REPO_ROOTS;
});

async function gitDir(parent: string, name: string): Promise<string> {
	const d = path.join(parent, name);
	await fs.mkdir(path.join(d, ".git"), { recursive: true });
	return d;
}

test("slug makes a short kebab name and never empty", () => {
	expect(slug("Add rate limiting to the login route")).toBe("add-rate-limiting-to");
	expect(slug("Fix bug #42 in Parser")).toBe("fix-bug-42-in");
	expect(slug("   !!!   ")).toBe("agent");
});

test("discoverRepos returns cwd + scanned roots (git repos only, absolute)", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "disc-"));
	const repoA = await gitDir(root, "alpha");
	const repoB = await gitDir(root, "beta");
	await fs.mkdir(path.join(root, "not-a-repo"), { recursive: true });
	const cwd = await gitDir(root, "cwdrepo");
	process.env.OMP_SQUAD_REPO_ROOTS = root;

	const repos = discoverRepos(cwd, []);
	expect(repos).toContain(path.resolve(repoA));
	expect(repos).toContain(path.resolve(repoB));
	expect(repos).toContain(path.resolve(cwd));
	expect(repos).not.toContain(path.resolve(path.join(root, "not-a-repo")));
	for (const r of repos) expect(path.isAbsolute(r)).toBe(true);
});

test("pickRepoHeuristic prefers a candidate the task names, else cwd, else first", () => {
	const cands = ["/x/omp-squad", "/x/web-app", "/x/api"];
	expect(pickRepoHeuristic("fix the web-app login", cands, "/x/api")).toBe("/x/web-app");
	expect(pickRepoHeuristic("do something generic", cands, "/x/api")).toBe("/x/api");
	expect(pickRepoHeuristic("do something generic", cands, "/elsewhere")).toBe("/x/omp-squad");
});

test("parsePlanJson extracts one object from noisy output and coerces/ trims fields", () => {
	const raw = parsePlanJson('sure!\n{"repo": " /x/app ", "name": "do-thing", "approval":"yolo", "junk": 5}\nthanks');
	expect(raw?.repo).toBe("/x/app");
	expect(raw?.name).toBe("do-thing");
	expect(raw?.approval).toBe("yolo");
	expect(raw?.model).toBeUndefined();
	expect(parsePlanJson("no json here")).toBeUndefined();
	expect(parsePlanJson('{"a":}')).toBeUndefined();
});
