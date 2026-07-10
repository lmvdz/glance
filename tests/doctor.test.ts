/**
 * `glance doctor` — R6 of the founding brief: *operational fragility makes "is the factory even on?" a
 * research question.*
 *
 * Every check below is a bug that cost a real session, so every test here is that session's post-mortem
 * turned into an assertion. The report logic is pure; the probes are injected. What is tested is the
 * DIAGNOSIS — that the tool says the true thing, and says the actionable thing.
 *
 * The rule the whole command is built on: a diagnostic may never fabricate an all-clear. "I could not
 * find out" and "it is off" are different answers, and only one of them is safe to act on.
 */

import { expect, test } from "bun:test";
import { type AutonomyFacts, type DoctorProbe, type DoctorReport, type RepoFacts, renderDoctor, runDoctor } from "../src/doctor.ts";

const ARMED: AutonomyFacts = { autodispatch: true, autodrive: true, autoland: true, autosupervise: false, landConfirm: true, regressionGate: true };
const CLEAN_REPO: RepoFacts = { repo: "/srv/app", exists: true, isGitRepo: true, dirtyFiles: 0, hasOrigin: true, defaultBranch: "main", staleBranches: 0 };

function probe(over: Partial<DoctorProbe> = {}): DoctorProbe {
	return {
		daemon: async () => ({ running: true, pid: 1, cwd: "/srv/app", installedRev: "abc1234", installRepo: "/srv/app", authMode: "file", webapp: true, webappDist: true, uptimeMs: 60_000 }),
		autonomy: async () => ARMED,
		repoRev: async () => ({ rev: "abc1234", repoRoot: "/srv/app" }),
		stateDir: async () => ({ path: "/home/u/.glance", exists: true, writable: true }),
		planeArmed: async () => ({ configured: true, reachable: true }),
		gateImage: async () => ({ dockerUsable: true, imagePresent: true, image: "glance-gate:bun1-v2", strict: false }),
		projects: async () => [CLEAN_REPO],
		webappBuilt: async () => true,
		zombieAgents: async () => 0,
		...over,
	};
}

const find = (r: DoctorReport, id: string) => r.checks.find((c) => c.id === id);

test("a healthy factory reports healthy, and says so in one line", async () => {
	const report = await runDoctor(probe());
	expect(report.healthy).toBe(true);
	expect(report.worst).toBe("ok");
	expect(renderDoctor(report)).toContain("the factory is on, armed, and pointed at the right world.");
});

// ── the daemon ──────────────────────────────────────────────────────────────────────────────────

test("a dead daemon is an error, with the command that fixes it", async () => {
	const report = await runDoctor(probe({ daemon: async () => ({ running: false }) }));
	expect(find(report, "daemon.running")?.status).toBe("error");
	expect(find(report, "daemon.running")?.remedy).toBe("glance up");
	expect(report.healthy).toBe(false);
});

/**
 * Found on this command's FIRST live run: the daemon was up and driving agents, but running an install
 * that predates `/api/doctor`. Doctor read the 404 as "no daemon is listening" and told me to start one.
 * A diagnostic whose first act is to misdiagnose is worse than none.
 */
test("a live-but-unaskable daemon is never reported as down", async () => {
	const report = await runDoctor(probe({ daemon: async () => ({ running: true, reachableButOpaque: true, opaqueReason: "/api/doctor (404 — older daemon)" }) }));
	const check = find(report, "daemon.running");
	expect(check?.status).toBe("warn"); // alive
	expect(check?.detail).toContain("alive");
	expect(check?.remedy).not.toBe("glance up"); // it IS up
	expect(report.healthy).toBe(true);
});

/** The deploy gap: the daemon runs the code it started with. Editing `src/` changes nothing, and the only
 *  symptom is that your fix "didn't work". */
test("a daemon running different code than the checkout says which is which", async () => {
	const report = await runDoctor(probe({ daemon: async () => ({ running: true, installedRev: "0000000aaa", installRepo: "/srv/app", authMode: "file" }), repoRev: async () => ({ rev: "ffffffbbb", repoRoot: "/srv/app" }) }));
	const check = find(report, "daemon.stale");
	expect(check?.status).toBe("warn");
	expect(check?.detail).toContain("0000000");
	expect(check?.detail).toContain("ffffffb");
	expect(check?.remedy).toContain("restart");
});

/**
 * `glance doctor` is routinely run from a repo the daemon MANAGES, not the one it runs FROM. Comparing
 * those two HEADs would flag a perfectly current daemon as stale on every such run — and a diagnostic
 * that cries wolf gets ignored, which costs more than the check was ever worth. Two different repos are
 * not comparable, so it says nothing rather than guessing.
 */
test("revs from two different repos are not compared at all", async () => {
	const report = await runDoctor(probe({ daemon: async () => ({ running: true, installedRev: "aaaaaaa", installRepo: "/srv/glance", authMode: "file" }), repoRev: async () => ({ rev: "bbbbbbb", repoRoot: "/srv/some-other-project" }) }));
	expect(find(report, "daemon.stale")).toBeUndefined();
});

/** A globally-installed daemon has no resolvable repo. Silence, not a fabricated match. */
test("an unresolvable install rev produces no claim either way", async () => {
	const report = await runDoctor(probe({ daemon: async () => ({ running: true, authMode: "file" }), repoRev: async () => ({ rev: "bbbbbbb", repoRoot: "/srv/app" }) }));
	expect(find(report, "daemon.stale")).toBeUndefined();
});

/**
 * The flag and the build are orthogonal: `OMP_SQUAD_WEBAPP` can be off while `webapp/dist` exists, and
 * the build can be missing while the flag is on. Conflating them fired "the UI is missing" at every
 * operator who simply hadn't opted in.
 */
test("serving the legacy UI is not the same as having no build", async () => {
	const report = await runDoctor(probe({ daemon: async () => ({ running: true, authMode: "file", webapp: false, webappDist: true }), webappBuilt: async () => true }));
	expect(find(report, "daemon.webapp")?.detail).toContain("legacy"); // opted out
	expect(find(report, "webapp.dist")?.status).toBe("ok"); // but built
	expect(report.healthy).toBe(true);
});

/** `bun` autoloads `.env` from the launch cwd, so a DB-mode daemon is usually an accident of *where it
 *  was started*. That cwd is the single most useful thing to print, because it is the thing to change. */
test("DB mode names the cwd that caused it", async () => {
	const report = await runDoctor(probe({ daemon: async () => ({ running: true, authMode: "db", rootFactory: false, cwd: "/srv/tenant-app" }) }));
	expect(find(report, "daemon.mode")?.detail).toContain("/srv/tenant-app");
});

test("the legacy UI is named, not silently served", async () => {
	const report = await runDoctor(probe({ daemon: async () => ({ running: true, authMode: "file", webapp: false }) }));
	expect(find(report, "daemon.webapp")?.detail).toContain("legacy");
});

// ── autonomy ────────────────────────────────────────────────────────────────────────────────────

/** The whole point. An unaskable daemon may be autolanding right now; "nothing is armed" would be a
 *  fabricated all-clear, and `unknown` is not a pass. */
test("autonomy we could not read is UNKNOWN, never 'off'", async () => {
	const report = await runDoctor(probe({ autonomy: async () => undefined }));
	const check = find(report, "autonomy");
	expect(check?.status).toBe("unknown");
	expect(check?.detail).toContain("did not answer");
	expect(report.worst).not.toBe("ok");
});

/** A smol model answering approval gates is how trust dies invisibly: the gate is answered, the
 *  transcript shows an approval, and no human ever saw it. Both spellings exist; the one you forget is
 *  the one that's on. */
test("the auto-supervisor is called out, and both env spellings are in the remedy", async () => {
	const report = await runDoctor(probe({ autonomy: async () => ({ ...ARMED, autosupervise: true }) }));
	const check = find(report, "autonomy");
	expect(check?.status).toBe("warn");
	expect(check?.remedy).toContain("OMP_SQUAD_AUTOSUPERVISE=0");
	expect(check?.remedy).toContain("OMP_SQUAD_AUTO_SUPERVISE=0");
});

/** The one autonomy combination that is a genuine emergency: work lands on main without ever being
 *  verified. The regression gate defaulted OFF for most of this system's life. */
test("autoland with the regression gate off is an ERROR, not a warning", async () => {
	const report = await runDoctor(probe({ autonomy: async () => ({ ...ARMED, autoland: true, regressionGate: false }) }));
	expect(find(report, "autonomy")?.status).toBe("error");
	expect(report.healthy).toBe(false);
});

test("a daemon with nothing armed is a viewer, and says so", async () => {
	const report = await runDoctor(probe({ autonomy: async () => ({ ...ARMED, autodispatch: false, autodrive: false, autoland: false }) }));
	expect(find(report, "autonomy")?.detail).toContain("viewer");
});

// ── the world the factory points at ─────────────────────────────────────────────────────────────

/**
 * A dirty default branch makes every land refuse — and the refusal is classed RETRYABLE, so the fleet
 * retries forever, never records an outcome, and the learning ledger starves in silence. 113 uncommitted
 * deletions on `main` cost an entire session before anyone looked at `git status`.
 */
test("a dirty repo is an ERROR that explains the retry loop", async () => {
	const report = await runDoctor(probe({ projects: async () => [{ ...CLEAN_REPO, dirtyFiles: 113 }] }));
	const check = find(report, "repo.app.dirty");
	expect(check?.status).toBe("error");
	expect(check?.detail).toContain("113");
	expect(check?.detail).toContain("retry forever");
	expect(report.healthy).toBe(false);
});

test("a registered repo that has vanished is an error, not a crash", async () => {
	const report = await runDoctor(probe({ projects: async () => [{ ...CLEAN_REPO, exists: false }] }));
	expect(find(report, "repo.app")?.status).toBe("error");
});

test("a repo with no origin can never land by PR — a warning, since local merge still works", async () => {
	const report = await runDoctor(probe({ projects: async () => [{ ...CLEAN_REPO, hasOrigin: false }] }));
	expect(find(report, "repo.app.origin")?.detail).toContain("never by PR");
	expect(report.healthy).toBe(true);
});

test("no registered projects is a warning with the way to fix it", async () => {
	const report = await runDoctor(probe({ projects: async () => [] }));
	expect(find(report, "projects")?.remedy).toContain("Add project");
});

test("Plane configured but unreachable is an error; absent is a warning", async () => {
	const unreachable = await runDoctor(probe({ planeArmed: async () => ({ configured: true, reachable: false, detail: "HTTP 401" }) }));
	expect(find(unreachable, "plane")?.status).toBe("error");
	expect(find(unreachable, "plane")?.detail).toContain("401");

	const absent = await runDoctor(probe({ planeArmed: async () => ({ configured: false, reachable: false }) }));
	expect(find(absent, "plane")?.status).toBe("warn");
	// Plane's secrets are read ONCE, at boot. Fixing the file without a restart fixes nothing.
	expect(find(absent, "plane")?.remedy).toContain("before the daemon boots");
});

test("an unwritable state dir is an error", async () => {
	const report = await runDoctor(probe({ stateDir: async () => ({ path: "/home/u/.glance", exists: true, writable: false }) }));
	expect(find(report, "state")?.status).toBe("error");
	// `chown -R` on a path the operator may have mis-set is a foot-gun they cannot undo — and on a MISSING
	// path it simply fails. Say what is wrong; let them pick the tool. (gpt-5.6-sol)
	expect(find(report, "state")?.remedy).not.toContain("chown -R");
});

/** A fresh install has no state dir. The daemon creates it at boot; calling that "not writable" turns a
 *  first run into a false alarm. (gpt-5.6-sol) */
test("a state dir that does not exist yet, with a writable parent, is fine", async () => {
	const report = await runDoctor(probe({ stateDir: async () => ({ path: "/home/u/.glance", exists: false, writable: true }) }));
	expect(find(report, "state")?.status).toBe("ok");
	expect(find(report, "state")?.detail).toContain("will be created");
});

test("a state dir that cannot be created is an error that says so", async () => {
	const report = await runDoctor(probe({ stateDir: async () => ({ path: "/ro/.glance", exists: false, writable: false }) }));
	expect(find(report, "state")?.detail).toContain("cannot be created");
});

test("a missing webapp build is an error — the UI would 404", async () => {
	const report = await runDoctor(probe({ webappBuilt: async () => false }));
	expect(find(report, "webapp.dist")?.status).toBe("error");
});

test("zombie units are surfaced with the command that reaps them", async () => {
	const report = await runDoctor(probe({ zombieAgents: async () => 4 }));
	expect(find(report, "zombies")?.detail).toContain("4");
	expect(find(report, "zombies")?.remedy).toContain("glance rm");
});

// ── the diagnostic must survive the machine it diagnoses ────────────────────────────────────────

/** A health check that dies on a broken machine is worthless exactly when it is needed. And a probe that
 *  threw must never be rendered as a pass. */
test("a probe that throws yields 'unknown', and never hides the other checks", async () => {
	const report = await runDoctor(
		probe({
			gateImage: async () => {
				throw new Error("docker socket permission denied");
			},
		}),
	);
	const gate = find(report, "gate");
	expect(gate?.status).toBe("unknown");
	expect(gate?.detail).toContain("permission denied");
	expect(gate?.remedy).toContain("do not read it as healthy");

	expect(find(report, "daemon.running")?.status).toBe("ok"); // the rest of the diagnosis survived
	expect(report.worst).not.toBe("ok");
	expect(report.healthy).toBe(true); // unknown is not blocking — but it is not "ok" either
});

test("every failing check carries a remedy, and no passing check does", async () => {
	const report = await runDoctor(probe({ daemon: async () => ({ running: false }), autonomy: async () => ({ ...ARMED, autoland: true, regressionGate: false }), projects: async () => [{ ...CLEAN_REPO, dirtyFiles: 2 }] }));
	for (const c of report.checks) {
		if (c.status === "ok") expect(c.remedy).toBeUndefined();
		else expect(c.remedy).toBeTruthy();
	}
});

/** Errors first: the operator reads the top of the output, and the top must be what is broken. */
test("the rendering leads with what is broken", async () => {
	const report = await runDoctor(probe({ daemon: async () => ({ running: false }), zombieAgents: async () => 2 }));
	const out = renderDoctor(report);
	expect(out.indexOf("no daemon is listening")).toBeLessThan(out.indexOf("parked in a terminal state"));
	expect(out).toContain("1 blocking");
});

// ── the all-clear must be earned ────────────────────────────────────────────────────────────────

/**
 * A report where every probe failed contains zero errors. Deriving the all-clear from
 * `!checks.some(error)` therefore printed "the factory is on, armed, and pointed at the right world"
 * over a page of `?` marks — a fabricated all-clear, the one thing this command must never produce.
 * (grok-4.5)
 */
test("a report full of unknowns never prints the all-clear", async () => {
	const boom = () => {
		throw new Error("probe exploded");
	};
	const report = await runDoctor(probe({ daemon: boom, autonomy: boom, stateDir: boom, planeArmed: boom, gateImage: boom, projects: boom, webappBuilt: boom, zombieAgents: boom }));

	expect(report.checks.every((c) => c.status === "unknown")).toBe(true);
	expect(report.healthy).toBe(true); // nothing is BLOCKING — the exit code stays 0
	const out = renderDoctor(report);
	expect(out).not.toContain("pointed at the right world");
	expect(out).toContain("unknown"); // and the count is stated
});

test("a single warning also withholds the all-clear", async () => {
	const report = await runDoctor(probe({ zombieAgents: async () => 1 }));
	expect(renderDoctor(report)).not.toContain("pointed at the right world");
});

/** A remedy that destroys unmerged work is worse than the litter it cleans up. Nothing in this probe
 *  asks GitHub whether a branch was merged, so the remedy must not assume it. */
test("the stale-branch remedy cannot delete unmerged work", async () => {
	const report = await runDoctor(probe({ projects: async () => [{ ...CLEAN_REPO, staleBranches: 37 }] }));
	const remedy = find(report, "repo.app.branches")?.remedy ?? "";
	expect(remedy).toContain("git branch -d");
	expect(remedy).not.toContain("-D");
});

/** Autonomy flags are read at boot. A remedy that only sets an env var leaves the running daemon exactly
 *  as dangerous as it was, while the operator believes they fixed it. */
test("every autonomy remedy says to restart", async () => {
	for (const autonomy of [
		async () => ({ ...ARMED, autosupervise: true }),
		async () => ({ ...ARMED, autoland: true, regressionGate: false }),
		async () => ({ ...ARMED, autodispatch: false, autodrive: false, autoland: false }),
	]) {
		const report = await runDoctor(probe({ autonomy }));
		expect(find(report, "autonomy")?.remedy).toContain("RESTART");
	}
});

/**
 * `/api/doctor` returns the daemon's pid, executable path, and working directory. In file mode the only
 * operator IS the person at the keyboard. In DB mode an org member is bridged to `operator` so they can
 * govern their own agents — they never chose this host's cwd, and that path belongs to someone else.
 * (grok-4.5)
 */
test("host process identity is redacted from DB-mode members, not from admins", async () => {
	const { doctorHostVisible } = await import("../src/doctor.ts");
	expect(doctorHostVisible(false, false)).toBe(true); // file mode: one operator, the human here
	expect(doctorHostVisible(true, false)).toBe(false); // db mode, org member: no host paths
	expect(doctorHostVisible(true, true)).toBe(true); // db mode, admin: it is their host
});

// ── the diagnosis must track the code, not a memory of it ───────────────────────────────────────

/**
 * "DB mode disables the factory" was true when it was written, and `doctor` said so unconditionally with
 * the remedy "launch without DATABASE_URL" — advice that dismantles working multi-tenancy. The opt-in
 * ROOT factory (`OMP_SQUAD_ROOT_FACTORY=1` + Plane repos) now runs the global loops alongside the tenant
 * registry. Report what the factory is DOING; never infer it from the storage mode. (gpt-5.6-sol)
 */
test("DB mode WITH a root factory is healthy, not a warning", async () => {
	const report = await runDoctor(probe({ daemon: async () => ({ running: true, authMode: "db", rootFactory: true }) }));
	expect(find(report, "daemon.mode")?.status).toBe("ok");
	expect(find(report, "daemon.mode")?.detail).toContain("root factory");
});

test("DB mode WITHOUT one names the real cause, and never says to tear down tenancy", async () => {
	const report = await runDoctor(probe({ daemon: async () => ({ running: true, authMode: "db", rootFactory: false }) }));
	const check = find(report, "daemon.mode");
	expect(check?.status).toBe("warn");
	expect(check?.detail).toContain("nothing owns the Plane loops");
	expect(check?.remedy).toContain("OMP_SQUAD_ROOT_FACTORY=1"); // the fix that keeps tenancy
});

/** `OMP_SQUAD_GATE_SANDBOX_STRICT=1` exists so the gate never silently runs unsandboxed. Without docker
 *  it does not degrade — it refuses, and nothing can verify or land. That is blocking. (gpt-5.6-sol) */
test("no docker under STRICT is an error, not a graceful fallback", async () => {
	const strict = await runDoctor(probe({ gateImage: async () => ({ dockerUsable: false, imagePresent: false, image: "glance-gate:bun1-v2", strict: true }) }));
	expect(find(strict, "gate")?.status).toBe("error");
	expect(find(strict, "gate")?.detail).toContain("nothing can verify or land");

	const lax = await runDoctor(probe({ gateImage: async () => ({ dockerUsable: false, imagePresent: false, image: "glance-gate:bun1-v2", strict: false }) }));
	expect(find(lax, "gate")?.status).toBe("warn"); // falls back to the host
});

/** An operator who pinned `OMP_SQUAD_GATE_SANDBOX=my-image` was told about an image the gate would never
 *  run. The daemon names the image; the probe inspects that one. */
test("the gate check names the image the gate will actually use", async () => {
	const report = await runDoctor(probe({ gateImage: async () => ({ dockerUsable: true, imagePresent: false, image: "acme/custom-gate:3", strict: false }) }));
	expect(find(report, "gate")?.detail).toContain("acme/custom-gate:3");
});
