/**
 * `glance doctor` — the one command that answers "is the factory on, armed, and pointed at the right
 * world?"
 *
 * R6 of the founding brief: *operational fragility makes "is the factory even on?" a research question.*
 * That was not hyperbole. Every one of the checks below is a bug that actually cost a session, and each
 * time the answer took a shell archaeology dig — reading `/proc/<pid>/environ`, comparing `git rev-parse`
 * against a global install, curling `/api/auth/mode` — rather than a question anyone could ask the tool:
 *
 *   - The daemon runs the GLOBAL install, not this checkout. Editing `src/` changes nothing until a
 *     restart, and nothing says so. (`omp-squad-stale-work-guards`)
 *   - `bun` autoloads `.env` from the daemon's cwd, so a daemon launched in a repo with a `DATABASE_URL`
 *     silently boots in DB mode — which architecturally DISABLES the file-mode factory. The daemon looks
 *     healthy and dispatches nothing. (`omp-squad-tenancy-vs-factory`)
 *   - Autonomy is a matrix of six env flags with two spellings for the supervisor. "Is autodispatch on?"
 *     had no answer short of grepping the process environment — which shows only the INITIAL environment.
 *   - Plane secrets load from `~/.claude/secrets/plane.env` at boot; a daemon started before that file
 *     existed has an armed-looking config and no fuel line. ("motor but no fuel line")
 *   - The regression gate runs in a container. `oven/bun:1` has no git, so the gate passed by never
 *     running. The image is derived once and cached; if it's missing, the gate silently degrades.
 *   - Land refuses on a dirty default branch, and reports it as RETRYABLE — so the fleet retries forever
 *     and the learning ledger starves. 113 uncommitted deletions on `main` cost a full session.
 *
 * Design: every probe is injected, so the whole report is drivable from tests with zero IO and zero
 * daemon. `runDoctor` NEVER throws — a diagnostic that dies on the machine it is diagnosing is worthless.
 * A failing probe becomes a check of status `"unknown"` carrying its own error text.
 *
 * Statuses are a triage order, not a mood: `error` = the factory cannot do its job; `warn` = it can, but
 * a known trap is armed; `ok` = verified, not assumed; `unknown` = the probe itself failed, which is
 * itself information (you are not allowed to read this as "fine").
 */

import { errText } from "./err-text.ts";
import { tokenize } from "./fabric-search.ts";

export type DoctorStatus = "ok" | "warn" | "error" | "unknown";

export interface DoctorCheck {
	/** Stable machine id — `--json` consumers and tests key on this, never on the title. */
	id: string;
	/** Which question this answers, in the operator's words. */
	title: string;
	status: DoctorStatus;
	/** What is true right now. One line. */
	detail: string;
	/** What to do about it. Present iff status is not "ok". A remedy is a command, not advice. */
	remedy?: string;
}

export interface DoctorReport {
	checks: DoctorCheck[];
	/** The worst status present — what the exit code is derived from. */
	worst: DoctorStatus;
	/** True when nothing is `error`. `warn` is survivable; `unknown` is not a pass. */
	healthy: boolean;
}

/** A repo the operator has told glance to care about, as `doctor` needs to see it. */
export interface RepoFacts {
	repo: string;
	exists: boolean;
	isGitRepo: boolean;
	/** Uncommitted changes on the CURRENT checkout of the default branch. */
	dirtyFiles: number;
	hasOrigin: boolean;
	defaultBranch?: string;
	/** Local `squad/*` branches. NOT "with no open PR" — nothing here asks GitHub, and a remedy that
	 *  assumes otherwise would delete unmerged work. */
	staleBranches: number;
}

export interface DaemonFacts {
	running: boolean;
	/** The daemon answered `/api/health` but could not answer `/api/doctor`: it is alive and running code
	 *  older than this CLI, or it refused us. Reporting that as "not running" is the exact class of lie
	 *  `doctor` exists to kill — it would tell the operator to `glance up` a daemon that is already up. */
	reachableButOpaque?: boolean;
	/** Why the facts are missing, when they are. */
	opaqueReason?: string;
	pid?: number;
	/** Absolute path of the binary/entrypoint the RUNNING daemon executes. */
	execPath?: string;
	/** The daemon's working directory — this is what decides which `.env` bun autoloads. */
	cwd?: string;
	/** Commit the running daemon's code is at, if resolvable. */
	installedRev?: string;
	/** Repo root the daemon's code lives in. Only when this matches the operator's checkout is a rev
	 *  comparison meaningful — otherwise `doctor` run from repo B would call the daemon "stale" for the
	 *  crime of being repo A. */
	installRepo?: string;
	/** "file" = the autonomous factory is possible; "db" = multi-tenant. */
	authMode?: "file" | "db";
	/** DB mode used to mean "no factory"; the opt-in ROOT factory (`OMP_SQUAD_ROOT_FACTORY=1` + Plane
	 *  repos) now runs one alongside the tenant registry. Report the factory's ACTUAL state, never infer
	 *  it from the storage mode. (gpt-5.6-sol) */
	rootFactory?: boolean;
	webapp?: boolean;
	/** `webapp/dist/index.html` exists next to the DAEMON's code — orthogonal to the flag above. */
	webappDist?: boolean;
	uptimeMs?: number;
}

export interface AutonomyFacts {
	autodispatch: boolean;
	autodrive: boolean;
	autoland: boolean;
	/** Either spelling. Two exist; one silently auto-approves human gates. */
	autosupervise: boolean;
	landConfirm: boolean;
	regressionGate: boolean;
	/** `OMP_SQUAD_COST_GATE` as the daemon sees it (adw-factory-borrows concern 09). `undefined` when
	 *  the daemon didn't report it (older install) — treated as "off", same as every other flag here. */
	costGateMode?: "off" | "shadow" | "enforce";
	/** Whether the daemon has ANY usable cost signal to verdict on — false when the cost aggregate AND
	 *  the model-outcomes ledger are both empty/too thin to clear `OMP_SQUAD_COST_MIN_SAMPLE` anywhere.
	 *  `undefined` when unreported (older install) — treated as "unknown, don't claim ready" by the
	 *  check below, never as "ready". */
	costAggregateReady?: boolean;
}

export interface DoctorProbe {
	daemon(): Promise<DaemonFacts>;
	/** Autonomy as the RUNNING daemon sees it — not as this shell's environment sees it. `undefined` when
	 *  the daemon cannot be asked: "nothing is armed" and "I could not find out" are different answers,
	 *  and only one of them is safe to act on. */
	autonomy(): Promise<AutonomyFacts | undefined>;
	/** Commit and repo root of the checkout the operator is standing in. */
	repoRev(): Promise<{ rev?: string; repoRoot?: string }>;
	/** `exists: false` with a writable parent is NORMAL on a fresh install — the daemon creates it at
	 *  boot. Only an existing, unwritable dir is a fault. (gpt-5.6-sol) */
	stateDir(): Promise<{ path: string; exists: boolean; writable: boolean }>;
	planeArmed(): Promise<{ configured: boolean; reachable: boolean; detail?: string }>;
	/** Is docker usable, is the image the gate will ACTUALLY use present, and does the gate fail closed
	 *  without docker (`OMP_SQUAD_GATE_SANDBOX_STRICT`)? Under strict, no docker means no gate at all —
	 *  an error, not a fallback. (gpt-5.6-sol) */
	gateImage(): Promise<{ dockerUsable: boolean; imagePresent: boolean; image: string; strict: boolean }>;
	projects(): Promise<RepoFacts[]>;
	webappBuilt(): Promise<boolean>;
	/** Are the foreign-harness lifecycle hooks registered (fleet-ide-bridge B03)? One entry per
	 *  harness; `ok: false` on an UNVERIFIED harness is a fact, not a fault — we decline to write
	 *  config schemas we have not confirmed, and say so. */
	harnessHooks(): Promise<Array<{ harness: string; ok: boolean; detail: string }>>;
	/** Agents parked in a terminal-but-listed state: the zombies `glance rm` is for. */
	zombieAgents(): Promise<number>;
	/** The known-symptom index (comprehension concern 07) — a stripped `SymptomEntry` projection, just
	 *  enough to match a failing check's title/detail and point at the summary row's count. Never
	 *  throws; an unreachable index reads as empty, not as a probe crash. */
	symptoms(): Promise<SymptomIndexEntry[]>;
}

/** The two fields `matchSymptom` and the summary row need off a recorded symptom card — deliberately
 *  NOT `SymptomEntry` itself: `doctor.ts` stays decoupled from `symptoms.ts`'s storage shape, the
 *  same seam every other `DoctorProbe` fact (RepoFacts, AutonomyFacts, …) already draws. */
export interface SymptomIndexEntry {
	symptom: string;
	whereToLook: string[];
}

/**
 * May this caller see the HOST's process identity (pid, execPath, cwd)?
 *
 * In DB mode an org MEMBER is bridged to `operator` — the tier that governs their own agents. They did
 * not set this host's environment or choose its working directory, and the cwd names a path on someone
 * else's machine. File mode has exactly one operator: the person at the keyboard. (grok-4.5)
 */
export function doctorHostVisible(dbMode: boolean, isAdmin: boolean): boolean {
	return !dbMode || isAdmin;
}

const WORST_ORDER: DoctorStatus[] = ["ok", "unknown", "warn", "error"];

function worstOf(checks: DoctorCheck[]): DoctorStatus {
	let worst: DoctorStatus = "ok";
	for (const c of checks) if (WORST_ORDER.indexOf(c.status) > WORST_ORDER.indexOf(worst)) worst = c.status;
	return worst;
}

/** A probe that throws becomes an honest `unknown`, never a silent `ok`. */
async function attempt(id: string, title: string, fn: () => Promise<DoctorCheck[]>): Promise<DoctorCheck[]> {
	try {
		return await fn();
	} catch (err) {
		return [{ id, title, status: "unknown", detail: `probe failed: ${errText(err)}`, remedy: "this check could not run — do not read it as healthy" }];
	}
}

const short = (rev?: string): string => (rev ? rev.slice(0, 7) : "?");

async function daemonChecks(probe: DoctorProbe): Promise<DoctorCheck[]> {
	const d = await probe.daemon();
	if (!d.running) {
		return [{ id: "daemon.running", title: "Is the daemon up?", status: "error", detail: "no daemon is listening", remedy: "glance up" }];
	}
	if (d.reachableButOpaque) {
		return [{
			id: "daemon.running",
			title: "Is the daemon up?",
			status: "warn",
			detail: `alive, but it cannot answer ${d.opaqueReason ?? "the doctor"} — it is running older code than this CLI, or refused the call`,
			remedy: "restart the daemon (scripts/squadctl.sh restart); until then its autonomy flags are unknowable from here",
		}];
	}

	const checks: DoctorCheck[] = [{ id: "daemon.running", title: "Is the daemon up?", status: "ok", detail: `pid ${d.pid ?? "?"}${d.uptimeMs ? `, up ${Math.round(d.uptimeMs / 60_000)}m` : ""}` }];

	// The deploy gap. The daemon runs whatever code it started with; a global install and a checkout can
	// be a hundred commits apart, and the only symptom is that your fix "didn't work".
	//
	// Only comparable when both revs name the SAME repo. `glance doctor` is routinely run from a repo the
	// daemon merely manages, not the one it runs from — comparing those two HEADs would report every such
	// run as a stale daemon.
	const { rev: repoRev, repoRoot } = await probe.repoRev();
	const comparable = Boolean(repoRoot && d.installRepo && repoRoot === d.installRepo);
	if (!comparable) {
		// Silence, not a guess.
	} else if (repoRev && d.installedRev && repoRev !== d.installedRev) {
		checks.push({
			id: "daemon.stale",
			title: "Is the running daemon this code?",
			status: "warn",
			detail: `daemon is at ${short(d.installedRev)}, checkout is at ${short(repoRev)}`,
			remedy: "restart the daemon to pick up your changes (scripts/squadctl.sh restart)",
		});
	} else if (repoRev) {
		checks.push({ id: "daemon.stale", title: "Is the running daemon this code?", status: "ok", detail: `both at ${short(repoRev)}` });
	}

	// Tenancy vs factory. Enabling multi-tenancy once silently turned the factory off — the tenant
	// managers are lazy and org-scoped, so nothing owned the global Plane loops. It is no longer
	// unconditional: an opt-in ROOT factory runs alongside the registry. So report what the factory is
	// actually DOING, and never tell an operator to tear down working tenancy to get it back.
	// (gpt-5.6-sol)
	if (d.authMode === "db" && d.rootFactory) {
		checks.push({ id: "daemon.mode", title: "File mode or DB mode?", status: "ok", detail: "DB (multi-tenant) with the root factory on — tenants served, autonomy running" });
	} else if (d.authMode === "db") {
		checks.push({
			id: "daemon.mode",
			title: "File mode or DB mode?",
			status: "warn",
			detail: `DB (multi-tenant) with no root factory — tenant managers are lazy and org-scoped, so nothing owns the Plane loops and no work is dispatched${d.cwd ? `; launched from ${d.cwd}, whose .env bun autoloads` : ""}`,
			remedy: "OMP_SQUAD_ROOT_FACTORY=1 with PLANE_PROJECT_MAP set, then restart — or run file mode (no DATABASE_URL in the launch dir's .env)",
		});
	} else if (d.authMode === "file") {
		checks.push({ id: "daemon.mode", title: "File mode or DB mode?", status: "ok", detail: "file mode — the factory can run" });
	}

	if (d.webapp === false) {
		checks.push({ id: "daemon.webapp", title: "Which UI is being served?", status: "warn", detail: "the legacy fallback UI (src/web/index.html)", remedy: "GLANCE_WEBAPP=1, and build it: cd webapp && bun run build" });
	} else if (d.webapp) {
		checks.push({ id: "daemon.webapp", title: "Which UI is being served?", status: "ok", detail: "the React webapp" });
	}

	return checks;
}

function autonomyCheck(a: AutonomyFacts): DoctorCheck {
	const on = (["autodispatch", "autodrive", "autoland"] as const).filter((k) => a[k]);
	// The supervisor answers approval gates with a small model. On, it is how trust dies invisibly: a
	// human gate gets auto-approved and nothing in the transcript says a human never saw it.
	if (a.autosupervise) {
		return { id: "autonomy", title: "Is autonomy armed, and safely?", status: "warn", detail: `auto-supervisor is ON — approval gates are being answered by a model, not by you`, remedy: "OMP_SQUAD_AUTOSUPERVISE=0 (and OMP_SQUAD_AUTO_SUPERVISE=0 — both spellings exist), then RESTART: these are read at boot" };
	}
	if (a.autoland && !a.regressionGate) {
		return { id: "autonomy", title: "Is autonomy armed, and safely?", status: "error", detail: "autoland is ON with the regression gate OFF — units can land unverified work", remedy: "OMP_SQUAD_REGRESSION_GATE=1, or OMP_SQUAD_AUTOLAND=0, then RESTART: these are read at boot" };
	}
	if (on.length === 0) {
		return { id: "autonomy", title: "Is autonomy armed, and safely?", status: "warn", detail: "nothing is armed — the daemon is a viewer; no work will be picked up", remedy: "OMP_SQUAD_AUTODISPATCH=1 OMP_SQUAD_AUTODRIVE=1, then RESTART: these are read at boot" };
	}
	return { id: "autonomy", title: "Is autonomy armed, and safely?", status: "ok", detail: `${on.join(", ")} armed; gate ${a.regressionGate ? "on" : "off"}; land ${a.landConfirm ? "confirms" : "auto"}` };
}

/**
 * Config posture (adw-factory-borrows concern 09, red-team S1): `OMP_SQUAD_COST_GATE=enforce` with no
 * usable cost signal is armed but SILENTLY inert — every verdict comes back `undefined` (thin sample
 * or no ceiling anywhere), so `enforce` never denies anything and looks IDENTICAL to `off` from the
 * operator's chair. `undefined` (mode unreported, an older daemon) yields no check at all — silence,
 * not a false "off" claim; `undefined` `costAggregateReady` under a reported `enforce` is treated as
 * NOT ready (fail loud, never assume readiness the daemon didn't confirm). Absent when mode isn't
 * "enforce" (nothing to warn about) — same "no check when nothing to say" shape `daemonChecks`'s
 * `daemon.stale` uses when the two revs aren't comparable. */
function costGateCheck(a: AutonomyFacts): DoctorCheck | undefined {
	if (a.costGateMode !== "enforce") return undefined;
	if (a.costAggregateReady) {
		return { id: "cost-gate", title: "Is the cost gate armed with real signal?", status: "ok", detail: "OMP_SQUAD_COST_GATE=enforce with a usable cost aggregate" };
	}
	return {
		id: "cost-gate",
		title: "Is the cost gate armed with real signal?",
		status: "warn",
		detail: "OMP_SQUAD_COST_GATE=enforce, but the cost aggregate and model-outcomes ledger are both missing/too thin to verdict on (below OMP_SQUAD_COST_MIN_SAMPLE) — every lane silently stays unenforced",
		remedy: "let the fleet land enough runs to clear OMP_SQUAD_COST_MIN_SAMPLE (or lower it) before relying on enforce",
	};
}

function repoChecks(repos: RepoFacts[]): DoctorCheck[] {
	if (repos.length === 0) {
		return [{ id: "projects", title: "Which repos is glance working on?", status: "warn", detail: "no projects registered", remedy: "add one in the web UI (+ Add project…), or POST /api/projects" }];
	}
	const checks: DoctorCheck[] = [];
	for (const r of repos) {
		const name = r.repo.split("/").pop() || r.repo;
		if (!r.exists) {
			checks.push({ id: `repo.${name}`, title: `Repo ${name}`, status: "error", detail: `${r.repo} does not exist`, remedy: `DELETE /api/projects — it is registered but gone` });
			continue;
		}
		if (!r.isGitRepo) {
			checks.push({ id: `repo.${name}`, title: `Repo ${name}`, status: "error", detail: `${r.repo} is not a git repository`, remedy: "unregister it; glance cuts worktrees, which requires git" });
			continue;
		}
		// A dirty default branch makes every land refuse — and the refusal is classed RETRYABLE, so the
		// fleet retries forever, never records an outcome, and the learning ledger starves silently.
		if (r.dirtyFiles > 0) {
			checks.push({ id: `repo.${name}.dirty`, title: `Repo ${name}`, status: "error", detail: `${r.dirtyFiles} uncommitted file(s) — every land will refuse, and retry forever`, remedy: `commit or stash them in ${r.repo}` });
		}
		if (!r.hasOrigin) {
			checks.push({ id: `repo.${name}.origin`, title: `Repo ${name}`, status: "warn", detail: "no origin remote — units will land by local merge, never by PR", remedy: "git remote add origin <url>" });
		}
		if (r.staleBranches > 0) {
			// `-d` (safe delete), never `-D`: nothing here checked whether these are merged, and a doctor
			// whose remedy destroys unmerged work is worse than the litter. (grok-4.5)
			checks.push({ id: `repo.${name}.branches`, title: `Repo ${name}`, status: "warn", detail: `${r.staleBranches} leftover squad/* branch(es)`, remedy: "git branch -d <name> for each already merged (safe: refuses unmerged)" });
		}
		if (r.dirtyFiles === 0 && r.hasOrigin && r.staleBranches === 0) {
			checks.push({ id: `repo.${name}`, title: `Repo ${name}`, status: "ok", detail: `clean, origin present, default ${r.defaultBranch ?? "?"}` });
		}
	}
	return checks;
}

/**
 * The doctor-failure auto-match (DESIGN.md "push at motivation"): a failing check's `title + detail`
 * against the recorded symptom index, scored by token OVERLAP COEFFICIENT
 * (`|shared| / min(|query|, |symptom|)`) rather than BM25 — a corpus of one to a few dozen symptom
 * cards makes BM25's idf term nearly meaningless, and a stable, corpus-size-independent threshold is
 * exactly what "clears a modest bar" needs. Reuses `fabric-search.ts`'s `tokenize` (camelCase-aware,
 * punctuation-stripping) rather than forking a second tokenizer. Pure: no I/O, so every branch is
 * directly testable, and ties resolve to whichever symptom scores highest first in `symptoms`.
 */
export const SYMPTOM_MATCH_THRESHOLD = 0.3;

export function matchSymptom(text: string, symptoms: SymptomIndexEntry[], threshold: number = SYMPTOM_MATCH_THRESHOLD): SymptomIndexEntry | undefined {
	const queryTokens = new Set(tokenize(text));
	if (queryTokens.size === 0) return undefined;
	let best: SymptomIndexEntry | undefined;
	let bestScore = 0;
	for (const s of symptoms) {
		const symptomTokens = new Set(tokenize(`${s.symptom} ${s.whereToLook.join(" ")}`));
		if (symptomTokens.size === 0) continue;
		let shared = 0;
		for (const t of symptomTokens) if (queryTokens.has(t)) shared++;
		const score = shared / Math.min(queryTokens.size, symptomTokens.size);
		if (score > bestScore) {
			bestScore = score;
			best = s;
		}
	}
	return bestScore >= threshold ? best : undefined;
}

/**
 * Assemble the report. Every check is independent and every probe is guarded, so one broken subsystem
 * cannot hide the diagnosis of the others — the failure mode of every health check ever written.
 */
export async function runDoctor(probe: DoctorProbe): Promise<DoctorReport> {
	// Fetched ONCE, shared by the summary row below AND the per-check auto-match — a probe that hits
	// the daemon must not pay for that round trip twice just because two consumers want it. Deliberately
	// NOT caught here: `attempt()` below is what converts a rejection into an honest "unknown" for the
	// summary row, same as every other probe (module doc: "a probe that throws becomes an honest
	// `unknown`, never a silent `ok`"). The auto-match use further down guards it separately. Wrapped in
	// an async IIFE so a probe that throws SYNCHRONOUSLY (every other probe call happens inside an
	// `async () => ...` closure already, which does this for free) becomes a rejected promise here too,
	// instead of crashing `runDoctor` itself before `attempt` ever gets a chance to catch it.
	const symptomsPromise: Promise<SymptomIndexEntry[]> = (async () => probe.symptoms())();
	const groups = await Promise.all([
		attempt("daemon", "Is the daemon up?", () => daemonChecks(probe)),
		attempt("autonomy", "Is autonomy armed, and safely?", async () => {
			const a = await probe.autonomy();
			// Silence is not "off". A daemon we cannot interrogate may well be autolanding right now.
			if (!a) return [{ id: "autonomy", title: "Is autonomy armed, and safely?", status: "unknown" as const, detail: "the daemon did not answer — its flags cannot be read from here", remedy: "restart it so it can report, or read its launch environment" }];
			const checks = [autonomyCheck(a)];
			const costGate = costGateCheck(a);
			if (costGate) checks.push(costGate);
			return checks;
		}),
		attempt("state", "Can glance write its state?", async () => {
			const s = await probe.stateDir();
			if (s.writable) return [{ id: "state", title: "Can glance write its state?", status: "ok" as const, detail: s.exists ? s.path : `${s.path} (will be created at boot)` }];
			// `chown -R` on a path that may be mis-set is a foot-gun the operator cannot undo, and on a
			// MISSING path it just fails. Say what is wrong; let them choose the tool. (gpt-5.6-sol)
			return [{
				id: "state",
				title: "Can glance write its state?",
				status: "error" as const,
				detail: s.exists ? `"${s.path}" exists but is not writable` : `"${s.path}" cannot be created (its parent is not writable)`,
				remedy: s.exists ? `make "${s.path}" writable by this user, or point GLANCE_STATE_DIR elsewhere` : `create "${s.path}" yourself, or point GLANCE_STATE_DIR at a writable path`,
			}];
		}),
		attempt("plane", "Is the work queue connected?", async () => {
			const p = await probe.planeArmed();
			if (!p.configured) return [{ id: "plane", title: "Is the work queue connected?", status: "warn" as const, detail: "Plane is not configured — dispatch has no backlog to pull from", remedy: "provide plane.env before the daemon boots; it is read once, at boot" }];
			if (!p.reachable) return [{ id: "plane", title: "Is the work queue connected?", status: "error" as const, detail: `Plane configured but unreachable${p.detail ? `: ${p.detail}` : ""}`, remedy: "check the API key and base URL, then restart the daemon" }];
			return [{ id: "plane", title: "Is the work queue connected?", status: "ok" as const, detail: "configured and reachable" }];
		}),
		attempt("gate", "Can the verification gate run?", async () => {
			const g = await probe.gateImage();
			// STRICT exists precisely so the gate never silently runs unsandboxed. Without docker it does
			// not degrade — it refuses, and every verify fails. That is a blocking fault, not a warning.
			if (!g.dockerUsable && g.strict) return [{ id: "gate", title: "Can the verification gate run?", status: "error" as const, detail: "docker is unavailable and OMP_SQUAD_GATE_SANDBOX_STRICT=1 — the gate fails closed, so nothing can verify or land", remedy: "start docker, or unset OMP_SQUAD_GATE_SANDBOX_STRICT to allow the host fallback" }];
			if (!g.dockerUsable) return [{ id: "gate", title: "Can the verification gate run?", status: "warn" as const, detail: "docker is unavailable — the gate falls back to running on the host", remedy: "start docker, or accept an unsandboxed gate" }];
			if (!g.imagePresent) return [{ id: "gate", title: "Can the verification gate run?", status: "warn" as const, detail: `gate image "${g.image}" is not present locally; it will be built or pulled on first use`, remedy: "none — the first gate run pays for it" }];
			return [{ id: "gate", title: "Can the verification gate run?", status: "ok" as const, detail: `docker + gate image "${g.image}" present` }];
		}),
		attempt("projects", "Which repos is glance working on?", async () => repoChecks(await probe.projects())),
		attempt("webapp.dist", "Is the UI built?", async () => [(await probe.webappBuilt()) ? { id: "webapp.dist", title: "Is the UI built?", status: "ok" as const, detail: "webapp/dist is present" } : { id: "webapp.dist", title: "Is the UI built?", status: "error" as const, detail: "webapp/dist is missing — the UI will 404", remedy: "cd webapp && bun run build" }]),
		// A harness whose hooks are not installed is invisible while it runs — glance learns of the
		// session only when a transcript walk catches up minutes later. `warn`, never `error`: the
		// fleet works fine without it, and an UNVERIFIED harness is honest reporting, not a fault.
		attempt("harness.hooks", "Do foreign harness sessions report in?", async () => {
			const rows = await probe.harnessHooks();
			return rows.map((r) => ({
				id: `harness.hooks.${r.harness}`,
				title: `Does a raw \`${r.harness}\` session report in?`,
				status: r.ok ? ("ok" as const) : ("warn" as const),
				detail: r.detail,
				...(r.ok ? {} : { remedy: "glance install-hooks --harness" }),
			}));
		}),
		attempt("zombies", "Any stuck units?", async () => {
			const n = await probe.zombieAgents();
			return [n === 0 ? { id: "zombies", title: "Any stuck units?", status: "ok" as const, detail: "none" } : { id: "zombies", title: "Any stuck units?", status: "warn" as const, detail: `${n} unit(s) parked in a terminal state`, remedy: "glance rm <name>" }];
		}),
		// Informational only (RT2-16 "doctor-tier discovery") — this row NEVER warns or errors on its
		// own; an empty index is a fact about a fresh install, not a fault. No `remedy` here: `remedy` is
		// present iff status is not `"ok"` everywhere else in this report (`DoctorCheck`'s own doc
		// comment), so the `glance symptom` nudge is folded into `detail` instead of breaking that
		// invariant for the one row that's always ok.
		attempt("symptom-index", "Is there a known-symptom index?", async () => {
			const symptoms = await symptomsPromise;
			const detail = symptoms.length
				? `${symptoms.length} known symptom(s) recorded — search them: glance symptom <query>`
				: "no symptoms recorded yet — glance symptom <query> once one exists";
			return [{ id: "symptom-index", title: "Is there a known-symptom index?", status: "ok" as const, detail }];
		}),
	]);

	const checks = groups.flat();

	// The doctor-failure auto-match (DESIGN.md "push at motivation"): every NON-ok check's title+detail
	// is matched against the symptom index, and a clearing top hit is appended to that check's remedy —
	// the moment of maximum motivation gets the pointer, instead of a pull-only search surface nobody
	// opens mid-incident. A throwing `symptoms()` probe (already reported as the "symptom-index" row's
	// own "unknown" above) must not crash the REST of the diagnosis — it just disables auto-match.
	const symptoms = await symptomsPromise.catch(() => [] as SymptomIndexEntry[]);
	if (symptoms.length) {
		for (const c of checks) {
			if (c.status === "ok") continue;
			const top = matchSymptom(`${c.title} ${c.detail}`, symptoms);
			if (!top) continue;
			const pointer = `known symptom: "${top.symptom}" → ${top.whereToLook[0]} (glance symptom for more)`;
			c.remedy = c.remedy ? `${c.remedy}; ${pointer}` : pointer;
		}
	}

	const worst = worstOf(checks);
	return { checks, worst, healthy: !checks.some((c) => c.status === "error") };
}

const GLYPH: Record<DoctorStatus, string> = { ok: "✔", warn: "!", error: "✗", unknown: "?" };

/** Human rendering. Grouped by status so the thing that is broken is the thing you read first. */
export function renderDoctor(report: DoctorReport): string {
	const order: DoctorStatus[] = ["error", "warn", "unknown", "ok"];
	const lines: string[] = [];
	for (const status of order) {
		for (const c of report.checks.filter((x) => x.status === status)) {
			lines.push(`${GLYPH[status]} ${c.title.padEnd(34)} ${c.detail}`);
			if (c.remedy) lines.push(`  ↳ ${c.remedy}`);
		}
	}
	const count = (s: DoctorStatus) => report.checks.filter((c) => c.status === s).length;
	lines.push("");
	// The all-clear is earned by `worst === "ok"`, NOT by the absence of errors. A report where every probe
	// failed has no errors in it — and printing "pointed at the right world" over a page of `?` marks is
	// exactly the fabricated all-clear this command was written to stop. (grok-4.5)
	if (report.worst === "ok") lines.push("the factory is on, armed, and pointed at the right world.");
	else {
		const parts = [`${count("error")} blocking`, `${count("warn")} to watch`];
		if (count("unknown")) parts.push(`${count("unknown")} unknown`);
		lines.push(parts.join(", "));
	}
	return `${lines.join("\n")}\n`;
}
