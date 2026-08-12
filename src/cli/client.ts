/**
 * The `glance` CLI's daemon-facing proxy verbs. Split out of src/index.ts (deepen concern 22):
 * every function here is a thin HTTP client against a running daemon's REST surface (`base()` +
 * `tokenHeader()`), as opposed to the local-compute verbs (plan-validate, plan-decompose,
 * curate-plane, doctor, land-assessment — still in index.ts, no daemon involved) or `glance who`/
 * `glance install-hooks` (also local, no fetch). Deleting this module removes every "talk to the
 * daemon over HTTP" verb at once — the deletion test this split passes.
 *
 * `api()` below is the ONE fetch wrapper every verb goes through, replacing 14 hand-rolled fetch
 * sites (`postCommand` plus 13 direct `fetch()` calls) whose `!res.ok` handling had drifted into
 * at least four distinct shapes across the pre-split file:
 *   - most verbs (`add`/`list`/`harnesses`/`diff`/`commission`/`search`) checked `res.ok` and
 *     printed `"<verb> failed: <status> <body>"`.
 *   - `cmdOpen` checked `res.ok` but never read `res.text()` — the failure message had no body
 *     detail, just the bare status code, AND the fetch itself was never wrapped in try/catch, so
 *     a refused connection (no daemon running) would throw an unhandled rejection instead of a
 *     friendly message.
 *   - `cmdAar`/`cmdAnswers`/`cmdGrr`'s `--list` branch printed a bare `"<status> <body>"` with no
 *     verb prefix at all — and `cmdGrr`'s OWN `POST` branch a few lines below used the prefixed
 *     `"grr failed: <status> <body>"` shape, i.e. two different shapes inside the SAME function.
 *   - `cmdLogs` and `cmdAutomation` never checked `res.ok` at all — they called `res.json()`
 *     unconditionally, so a non-2xx response with a JSON error body silently passed through, and a
 *     non-2xx with a non-JSON body was misreported as "no daemon" by the outer catch.
 *   - `cmdPromote` didn't check `res.ok` at all either: it read `res.json()` unconditionally and
 *     trusted the response BODY's own `ok` field, so a non-2xx with a well-formed JSON body was
 *     silently treated as a normal (if unsuccessful) promotion instead of a transport failure.
 * `api()` picks the strictest prior behavior for every verb: a network/connect failure always
 * throws `ApiError` with `"No glance daemon on <base>. Start one with: glance up"` (unifying the
 * "No squad daemon"/"No glance daemon" text drift too — this repo rebranded omp-squad → glance),
 * and a non-2xx HTTP response always throws `ApiError` with `"<label> failed: <status> <body>"`.
 * Every verb's SUCCESS output text is untouched by this split — only the error path changed, and
 * only to close a real gap (a swallowed non-ok, a missing error detail, or a mismatched daemon
 * name), never to alter what a passing command prints.
 */
import * as path from "node:path";
import { realpath } from "node:fs/promises";
import { envInt } from "../config.ts";
import { who as whoPresence } from "../presence.ts";
import { matchUnit, openWorktree } from "../open-worktree.ts";
import { laneFromRouted } from "../lane.ts";
import { normalizeRepoPath } from "../project-registry.ts";
import { formatWhereToLookEntry, groupSymptomHits, statWhereToLookEntry, type SymptomSearchHit } from "../memory/symptoms.ts";
import type { FabricSearchResult, KbDocType } from "../memory/fabric-search.ts";
import type { AutomationRollupRow } from "../automation-log.ts";
import type { AgentDTO, ApprovalMode, AutomationEvent, ClientCommand, CommissionResult, CommissionSpec, CreateAgentOptions, FrictionEntry, ThinkingLevel, TranscriptEntry } from "../types.ts";
import { base, parseArgs, tokenHeader } from "../cli-args.ts";
import type { FileDiff } from "../explore.ts";
import { renderAgentRoster, renderDiff, renderDiffStat, renderHarnessTable, renderSearchResults, symptomAge, type HarnessListingRow } from "./render.ts";

type Flags = Record<string, string | boolean>;

class ApiError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.status = status;
	}
}

/** The one fetch wrapper every daemon-facing proxy verb below goes through — see the module doc
 *  for the drift this closes. `label` is the verb name used in the `"<label> failed: ..."` prefix. */
async function api(flags: Flags, label: string, path: string, init: RequestInit = {}): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(`${base(flags)}${path}`, { ...init, headers: { ...tokenHeader(), ...(init.headers as Record<string, string> | undefined) } });
	} catch {
		throw new ApiError(`No glance daemon on ${base(flags)}. Start one with: glance up`);
	}
	if (!res.ok) throw new ApiError(`${label} failed: ${res.status} ${await res.text()}`, res.status);
	return res;
}

function reportApiError(err: unknown): void {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
}

/**
 * `answer-read` (comprehension concern 02): a genuine CLI *display* path — `cmdAsk`'s interactive
 * print and `--read <id>` — POSTs this the same way the webapp's `reportAttention` does. Never
 * awaited by the caller and every rejection is swallowed here: a daemon hiccup or an old daemon
 * with no `/api/attention` route must never turn a successful `ask`/`--read` into a failed command.
 * Callers gate this themselves (never on `--json`/`--no-wait` — machine consumption isn't reading).
 * Deliberately NOT routed through `api()`: its whole point is to swallow every failure silently.
 */
function reportAnswerReadCli(flags: Flags, repo: string, answerId: string): void {
	fetch(`${base(flags)}/api/attention`, {
		method: "POST",
		headers: { ...tokenHeader(), "content-type": "application/json" },
		body: JSON.stringify({ kind: "answer-read", repo, answerId }),
	}).catch(() => {});
}

/**
 * `glance grr "<gripe>" [--repo <path>] [--context <s>]` / `glance grr --list [--repo <path>] [--json]`
 * canonicalization: resolve `input` to an absolute path, then — if it sits inside a git
 * checkout — walk UP to the repo root via `git rev-parse --show-toplevel` rather than trusting
 * the caller's cwd literally. Without this, a gripe logged from a subdirectory (e.g.
 * `glance grr` run from `<repo>/webapp`) persists with `repo=<repo>/webapp`, and every
 * repo-filtered read (`GET /api/friction?repo=`, the dogfood-drain skill) uses exact-string
 * equality against the registered repo ROOT — so the entry is silently invisible to any
 * repo-scoped list even though `glance grr --list` (unfiltered) still shows it.
 *
 * Falls back to the resolved input path when it isn't a git checkout (git missing, bare dir,
 * `rev-parse` fails) — `normalizeRepoPath` still runs, so the fallback path collapses the same
 * way a registered non-git "repo" would.
 *
 * @substrate exported for tests/friction-log.test.ts; live caller is cmdGrr, in this same file —
 * a cross-file dead-export scan can't see that.
 */
export async function canonicalRepoRoot(input: string): Promise<string> {
	const resolved = path.resolve(input);
	try {
		const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: resolved, stdout: "pipe", stderr: "ignore" });
		const out = (await new Response(proc.stdout).text()).trim();
		await proc.exited;
		if (proc.exitCode === 0 && out) return normalizeRepoPath(await realpath(out).catch(() => out));
	} catch {
		/* git missing or spawn failed — fall through to the resolved path */
	}
	return normalizeRepoPath(resolved);
}

// ── Declarative table: the uniform "build a ClientCommand, POST /api/command, print one word or
// fail" shape shared by prompt/notify/rm/kill. Each entry's `build` does that verb's own arg
// parsing/validation (they're not identical — notify accepts --detail, rm accepts
// --delete-worktree); once built, dispatch is identical. Previously NONE of these four exited
// non-zero on a failed command (they printed "failed: ..." and returned 0) — folded into the same
// strictest-behavior unification as the fetch drift above: a failed command now exits 1. ────────
interface SimpleCommandSpec {
	usage: string;
	build: (positional: string[], flags: Flags) => ClientCommand | undefined;
	successMsg: string;
}

const SIMPLE_COMMANDS: Record<string, SimpleCommandSpec> = {
	prompt: {
		usage: "usage: glance prompt <id> <message...>\n",
		build: (positional) => {
			const id = positional[0];
			const message = positional.slice(1).join(" ");
			return id && message ? { type: "prompt", id, message } : undefined;
		},
		successMsg: "sent",
	},
	notify: {
		usage: 'usage: glance notify <id> <summary...> [--detail "..."]\n',
		build: (positional, flags) => {
			const id = positional[0];
			const summary = positional.slice(1).join(" ") || (typeof flags.summary === "string" ? flags.summary : "");
			if (!id || !summary) return undefined;
			const detail = typeof flags.detail === "string" ? flags.detail : undefined;
			return { type: "notify", id, summary, detail };
		},
		successMsg: "sent",
	},
	rm: {
		usage: "usage: glance rm <id> [--delete-worktree]\n",
		build: (positional, flags) => {
			const id = positional[0];
			return id ? { type: "remove", id, deleteWorktree: !!flags["delete-worktree"] } : undefined;
		},
		successMsg: "removed",
	},
	kill: {
		usage: "usage: glance kill <id>\n",
		build: (positional) => {
			const id = positional[0];
			return id ? { type: "kill", id } : undefined;
		},
		successMsg: "killed",
	},
};

async function cmdSimpleCommand(name: keyof typeof SIMPLE_COMMANDS, args: string[]): Promise<void> {
	const spec = SIMPLE_COMMANDS[name];
	const { positional, flags } = parseArgs(args);
	const cmd = spec.build(positional, flags);
	if (!cmd) {
		process.stderr.write(spec.usage);
		process.exit(1);
		return;
	}
	try {
		await api(flags, name, "/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cmd) });
		process.stdout.write(`${spec.successMsg}\n`);
	} catch (err) {
		reportApiError(err);
		process.exit(1);
	}
}

export const cmdPrompt = (args: string[]): Promise<void> => cmdSimpleCommand("prompt", args);
export const cmdNotify = (args: string[]): Promise<void> => cmdSimpleCommand("notify", args);
export const cmdRm = (args: string[]): Promise<void> => cmdSimpleCommand("rm", args);
export const cmdKill = (args: string[]): Promise<void> => cmdSimpleCommand("kill", args);

// ── Bespoke proxy verbs: each has real logic beyond "build a command, print a word" (flag
// parsing, polling, dual modes, rendering), so they stay hand-written — but every fetch now goes
// through the shared api() above instead of its own hand-rolled !res.ok check. ────────────────

async function cmdAdd(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const repo = positional[0] ?? process.cwd();
	const options: CreateAgentOptions = { repo };
	if (typeof flags.name === "string") options.name = flags.name;
	if (typeof flags.branch === "string") options.branch = flags.branch;
	if (typeof flags.model === "string") options.model = flags.model;
	if (typeof flags.task === "string") options.task = flags.task;
	if (typeof flags.approval === "string") options.approvalMode = flags.approval as ApprovalMode;
	if (typeof flags.thinking === "string") options.thinking = flags.thinking as ThinkingLevel;
	if (typeof flags.workflow === "string") options.workflow = flags.workflow;
	if (typeof flags.verify === "string") options.verify = flags.verify;
	// --lane hotfix|feature|chore: the CLI caller is the operator, so this is an operator-sourced
	// lane (may move LANE_POLICY privilege axes). Invalid values are rejected loudly, never guessed.
	if (typeof flags.lane === "string") {
		const lane = laneFromRouted({ lane: flags.lane });
		if (!lane) {
			console.error(`unknown --lane "${flags.lane}" — expected hotfix | feature | chore`);
			process.exit(1);
		}
		options.lane = lane;
	}
	if (typeof flags.sandbox === "string") options.sandbox = { image: flags.sandbox };
	if (flags.acp === true || flags.runtime === "acp") options.runtime = "acp";
	// Any registered harness by name (omp/pi/claude-code/codex/opencode/gemini/…). Supersedes --acp;
	// --bin overrides the harness's binary for this one agent.
	if (typeof flags.harness === "string") options.harness = flags.harness;
	if (typeof flags.bin === "string") options.bin = flags.bin;
	// Spawn from a named capability bundle (env OMP_SQUAD_PROFILES or repo .glance/profiles.json) —
	// its harness/bin/model/thinking/memory/capabilities apply unless the flags above override them.
	if (typeof flags.profile === "string") options.profileId = flags.profile;
	if (flags.plain === true) options.autoRoute = false;

	// Discoverability: warn if anyone (squad agent or raw omp session) is already on this repo.
	const present = await whoPresence(repo).catch(() => []);
	if (present.length) {
		process.stderr.write(`⚠ ${present.length} agent(s) already active on ${repo}:\n`);
		for (const p of present) process.stderr.write(`    ${p.source} ${p.operator}/${p.agent}${p.branch ? ` (${p.branch})` : ""}\n`);
	}

	let dto: AgentDTO;
	try {
		const res = await api(flags, "add", "/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "create", options }) });
		dto = (await res.json()) as AgentDTO;
	} catch (err) {
		reportApiError(err);
		process.exit(1);
		return;
	}
	process.stdout.write(`spawned ${dto.name} [${dto.status}]\n  id: ${dto.id}\n  worktree: ${dto.worktree}\n`);
}

async function cmdList(args: string[]): Promise<void> {
	const { flags } = parseArgs(args);
	let agents: AgentDTO[];
	try {
		agents = (await (await api(flags, "list", "/api/agents")).json()) as AgentDTO[];
	} catch (err) {
		reportApiError(err);
		process.exit(1);
		return;
	}
	process.stdout.write(renderAgentRoster(agents, { json: flags.json === true }));
}

/** `glance harnesses [--json]` — the honest capability tier matrix (concern 06): every
 *  REGISTERED harness (not just the create-surface-visible verified ones) with its tier, a
 *  verified-binary-missing alert, and the usage-verified bit. Always queries the create API's
 *  `?all=1` under the hood — this listing is always the full roster, so there is no `--all` flag
 *  to pass. */
async function cmdHarnesses(args: string[]): Promise<void> {
	const { flags } = parseArgs(args);
	let body: { default: string; harnesses: HarnessListingRow[] };
	try {
		body = (await (await api(flags, "harnesses", "/api/harnesses?all=1")).json()) as { default: string; harnesses: HarnessListingRow[] };
	} catch (err) {
		reportApiError(err);
		process.exit(1);
		return;
	}
	process.stdout.write(renderHarnessTable(body.harnesses, body.default, { json: flags.json === true }));
}

/** `glance open <id|name|branch>` — the fleet→worktree jump (fleet-ide-bridge B02):
 *  resolve the unit's worktree from the roster and launch the configured opener
 *  LOCALLY (this machine), falling back to printing the path when no opener exists. */
async function cmdOpen(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const key = positional[0];
	if (!key) {
		process.stderr.write("usage: glance open <id|name|branch>\n");
		process.exit(1);
		return;
	}
	let agents: AgentDTO[];
	try {
		agents = (await (await api(flags, "open", "/api/agents")).json()) as AgentDTO[];
	} catch (err) {
		reportApiError(err);
		process.exit(1);
		return;
	}
	const unit = matchUnit(agents, key);
	if (!unit) {
		process.stderr.write(`no unit matching "${key}" (tried id, name, branch, unique id prefix)\n`);
		process.exit(1);
		return;
	}
	const out = openWorktree(unit.worktree);
	if (out.spawned && out.argv) process.stdout.write(`opening ${out.path} (${out.argv[0]})\n`);
	else {
		process.stdout.write(`${out.path}\n`);
		if (out.hint) process.stderr.write(`${out.hint}\n`);
	}
}

/**
 * `glance aar [<id>] [--json]` — after-action reports (after-action.ts): the durable post-mortem a
 * terminal unit leaves behind. No id lists every report, newest death first; an id prints that
 * unit's markdown. Reports outlive the roster row (auto-reap prunes valueless corpses), so this is
 * the surface that answers "what were those five red units, and do I care?" after they're gone.
 */
async function cmdAar(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0];
	const routePath = id ? `/api/after-action/${encodeURIComponent(id)}` : "/api/after-action";
	let body: unknown;
	try {
		body = await (await api(flags, "aar", routePath)).json();
	} catch (err) {
		reportApiError(err);
		process.exit(1);
		return;
	}
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
		return;
	}
	if (id) {
		process.stdout.write(`${(body as { markdown: string }).markdown}\n`);
		return;
	}
	const list = body as Array<{ id: string; name: string; classification: string; terminalAt: number; terminalReason: string }>;
	if (list.length === 0) {
		process.stdout.write("no after-action reports — no unit has died with a post-mortem yet\n");
		return;
	}
	for (const r of list) {
		process.stdout.write(`${new Date(r.terminalAt).toISOString().slice(0, 16)} ${r.classification.padEnd(14)} ${r.name.padEnd(12)} ${r.terminalReason.slice(0, 70)}\n`);
	}
}

async function cmdLogs(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0];
	if (!id) {
		process.stderr.write("usage: glance logs <id> [--limit N]\n");
		process.exit(1);
		return;
	}
	const limit = flags.limit ? Number(flags.limit) : 40;
	let entries: TranscriptEntry[];
	try {
		entries = (await (await api(flags, "logs", `/api/agents/${encodeURIComponent(id)}/transcript`)).json()) as TranscriptEntry[];
	} catch (err) {
		reportApiError(err);
		process.exit(1);
		return;
	}
	if (!entries.length) {
		process.stdout.write("no transcript\n");
		return;
	}
	const recent = entries.slice(-limit);
	const w = Math.max(...recent.map((e) => e.kind.length));
	for (const e of recent) {
		process.stdout.write(`${e.kind.toUpperCase().padEnd(w)}  ${e.text}\n`);
	}
}

/** Colorize stdout only on a real TTY, honoring the NO_COLOR (https://no-color.org) and
 *  FORCE_COLOR conventions — a piped `glance diff` must never leak escape codes into a file/pager. */
function colorEnabled(): boolean {
	if (process.env.NO_COLOR) return false;
	if (process.env.FORCE_COLOR === "0") return false;
	if (process.env.FORCE_COLOR) return true;
	return Boolean(process.stdout.isTTY);
}

/**
 * `glance diff <id|name|branch> [--stat] [--json]` — the terminal review surface: an agent's changed
 * files as a colorized unified diff, without leaving the CLI. Backs off `GET /api/agents/:id/diff`
 * (`worktreeDiffSinceFork` — committed AND uncommitted changes since the unit's fork point, the same
 * source the webapp review panel drives). `<id>` resolves the same way `glance open` does: exact id,
 * then exact name, then exact branch, then a unique id prefix — ambiguity is a miss, never a guess.
 */
async function cmdDiff(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const key = positional[0];
	if (!key) {
		process.stderr.write("usage: glance diff <id|name|branch> [--stat] [--json]\n");
		process.exit(1);
		return;
	}
	let agents: AgentDTO[];
	try {
		agents = (await (await api(flags, "diff", "/api/agents")).json()) as AgentDTO[];
	} catch (err) {
		reportApiError(err);
		process.exit(1);
		return;
	}
	const unit = matchUnit(agents, key);
	if (!unit) {
		process.stderr.write(`no unit matching "${key}" (tried id, name, branch, unique id prefix)\n`);
		process.exit(1);
		return;
	}
	let files: FileDiff[];
	try {
		files = (await (await api(flags, "diff", `/api/agents/${encodeURIComponent(unit.id)}/diff`)).json()) as FileDiff[];
	} catch (err) {
		reportApiError(err);
		process.exit(1);
		return;
	}
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(files, null, 2)}\n`);
		return;
	}
	process.stdout.write(flags.stat ? renderDiffStat(files) : renderDiff(files, { color: colorEnabled() }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function cmdCommission(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const name = positional[0];
	const purpose = typeof flags.purpose === "string" ? flags.purpose : "";
	if (!name || !purpose) {
		process.stderr.write('usage: glance commission <name> --purpose "..." [--model <spec|false>] [--target node|cloudflare] [--capabilities a,b] [--accept-payload <json> --accept-expect <json>]\n');
		process.exit(1);
	}
	const spec: CommissionSpec = { name, purpose, model: false };
	if (typeof flags.model === "string") spec.model = flags.model === "false" ? false : flags.model;
	if (typeof flags.target === "string") spec.deployTarget = flags.target === "cloudflare" ? "cloudflare" : "node";
	if (typeof flags.capabilities === "string") {
		spec.capabilities = flags.capabilities
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	if (typeof flags["accept-payload"] === "string") {
		const payload: unknown = JSON.parse(flags["accept-payload"]);
		let expect: Record<string, unknown> | undefined;
		if (typeof flags["accept-expect"] === "string") {
			const parsed: unknown = JSON.parse(flags["accept-expect"]);
			if (isRecord(parsed)) expect = parsed;
		}
		spec.accept = { payload, expect };
	}
	process.stdout.write(`commissioning "${name}" — authoring + validating (this can take a while)…\n`);
	let result: CommissionResult;
	try {
		const res = await api(flags, "commission", "/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "commission", spec }) });
		result = (await res.json()) as CommissionResult;
	} catch (err) {
		reportApiError(err);
		process.exit(1);
		return;
	}
	for (const c of result.report.checks) {
		const mark = c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "·";
		process.stdout.write(`  ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ""}\n`);
	}
	if (result.ok && result.member) {
		process.stdout.write(`onboarded ${result.member.name} [flue-service${result.member.verified ? ", verified" : ""}]\n  id: ${result.member.id}\n  dir: ${result.dir}\n`);
	} else {
		process.stdout.write(`rejected — gate failed; worker left at ${result.dir}\n`);
		process.exit(1);
	}
}

const AUTOMATION_WINDOWS: Record<string, number> = { "15m": 900_000, "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000 };
/** Compact "Ns/Nm/Nh ago" for the CLI automation view. */
function relAgo(ts: number): string {
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/** `glance automation` — what the daemon's background loops (scout/observer/opportunity/dispatch) are
 *  doing on their own, and what the Scout is costing in LLM calls. The terminal twin of GET /api/automation. */
async function cmdAutomation(args: string[]): Promise<void> {
	const { flags } = parseArgs(args);
	const winKey = String(flags.window ?? flags.w ?? "1h");
	const windowMs = AUTOMATION_WINDOWS[winKey] ?? 3_600_000;
	const loop = typeof flags.loop === "string" ? flags.loop : undefined;
	const limit = Number(flags.limit) || 20;
	let data: { events: AutomationEvent[]; rollup: AutomationRollupRow[] };
	try {
		const q = new URLSearchParams({ windowMs: String(windowMs), limit: String(limit) });
		if (loop) q.set("loop", loop);
		data = (await (await api(flags, "automation", `/api/automation?${q.toString()}`)).json()) as { events: AutomationEvent[]; rollup: AutomationRollupRow[] };
	} catch (err) {
		reportApiError(err);
		process.exit(1);
		return;
	}
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
		return;
	}
	const winLbl = Object.keys(AUTOMATION_WINDOWS).find((k) => AUTOMATION_WINDOWS[k] === windowMs) ?? `${Math.round(windowMs / 60_000)}m`;
	process.stdout.write(`background automation — last ${winLbl}\n\n`);
	const rollup = data.rollup ?? [];
	if (!rollup.length) process.stdout.write("  (no background activity recorded yet — loops run once agents + Plane repos are configured)\n");
	for (const r of rollup) {
		const extra = `${r.spawned ? `  ${r.spawned} spawned` : ""}${r.errors ? `  ${r.errors} err` : ""}`;
		process.stdout.write(`  ${r.loop.padEnd(12)}${String(r.events).padStart(4)} ev   ${String(r.llmCalls).padStart(3)} LLM   ${String(r.filed).padStart(3)} filed   ${String(r.found).padStart(3)} found${extra}   last ${r.lastAt ? `${relAgo(r.lastAt)} ago` : "—"}\n`);
	}
	const evs = data.events ?? [];
	if (evs.length) {
		process.stdout.write(`\nrecent (${evs.length}):\n`);
		for (const e of evs) {
			const metrics = [e.llmCalls ? `${e.llmCalls} LLM` : "", e.found ? `${e.found} found` : "", e.filed ? `${e.filed} filed` : "", e.spawned ? `${e.spawned} spawned` : "", e.level && e.level !== "info" ? e.level : ""].filter(Boolean).join(" ") || "—";
			const who = e.agent ?? (e.repo ? (e.repo.split("/").pop() ?? e.repo) : "fleet");
			process.stdout.write(`  ${`${relAgo(e.at)} ago`.padStart(8)}  ${e.loop.padEnd(11)} ${who.padEnd(22)} ${metrics}${e.detail ? `  — ${e.detail}` : ""}\n`);
		}
	}
}

/**
 * `glance grr "<gripe>" [--repo <path>] [--context <s>]` / `glance grr --list [--repo <path>] [--json]`
 *
 * The friction ledger's five-second capture (plans/daily-dogfood-engine/01). Fire-and-forget by
 * design: one POST, print "logged.", exit — anything slower than a few seconds would never get
 * used mid-annoyance, and then the whole dogfood epic loses its raw material. No polling, no
 * confirmation round trip beyond the 2xx.
 */
async function cmdGrr(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const repo = await canonicalRepoRoot(typeof flags.repo === "string" ? flags.repo : process.cwd());

	if (flags.list) {
		const q = new URLSearchParams();
		if (typeof flags.repo === "string") q.set("repo", repo);
		if (typeof flags.limit === "string") q.set("limit", flags.limit);
		let entries: FrictionEntry[];
		try {
			({ entries } = (await (await api(flags, "grr", `/api/friction?${q.toString()}`)).json()) as { entries: FrictionEntry[] });
		} catch (err) {
			reportApiError(err);
			process.exit(1);
			return;
		}
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
			return;
		}
		if (!entries.length) {
			process.stdout.write('no gripes yet. log one: glance grr "the thing that just annoyed you"\n');
			return;
		}
		for (const e of entries) {
			const where = [e.repo ? (e.repo.split("/").pop() ?? e.repo) : "—", e.context, e.agentId].filter(Boolean).join(" · ");
			// Concern 02 (plans/daily-driver-w15): mark daemon-auto-captured rows so a human skimming
			// `--list` doesn't mistake them for something they typed — `--json` already carries the raw
			// `source` field for a programmatic reader (the drain).
			const marker = e.source === "auto" ? "auto " : "";
			process.stdout.write(`  ${`${relAgo(e.ts)} ago`.padStart(8)}  ${marker}${where.padEnd(28)} ${e.gripe}\n`);
		}
		return;
	}

	const gripe = positional.join(" ").trim();
	if (!gripe) {
		process.stderr.write('usage: glance grr "<gripe>" [--repo <path>] [--context <s>]\n       glance grr --list [--repo <path>] [--json]\n');
		process.exit(1);
	}
	try {
		await api(flags, "grr", "/api/friction", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ repo, context: typeof flags.context === "string" ? flags.context : "cli", gripe }),
		});
	} catch (err) {
		reportApiError(err);
		process.exit(1);
		return;
	}
	process.stdout.write("logged.\n");
}

/**
 * `glance ask "<question>" [--repo <path>] [--json] [--no-wait]`
 *
 * R5: the second deliverable. A question in, a written answer out — no branch, no PR, nothing to merge.
 * The unit is an observer (`is-landing-unit.ts` refuses to land one), so this cannot mutate the repo.
 *
 * Waits by default. An `ask` you have to poll for is an `ask` nobody uses: the whole point is that the
 * answer arrives where the question was asked.
 *
 * The polling loop deliberately does NOT go through `api()`: a poll tick that fails to connect or
 * gets a non-2xx isn't a fatal error mid-wait, it's "not answered yet" — the loop below already
 * distinguishes "no answer on disk yet" from "the unit is gone" from "the unit errored" on its own.
 */
async function cmdAsk(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const question = positional.join(" ").trim();
	if (!question) {
		process.stderr.write('usage: glance ask "<question>" [--repo <path>] [--model M] [--json] [--no-wait]\n');
		process.exit(1);
	}
	const repo = typeof flags.repo === "string" ? path.resolve(flags.repo) : process.cwd();
	let dto: AgentDTO;
	try {
		const res = await api(flags, "ask", "/api/answers", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ repo, question, model: typeof flags.model === "string" ? flags.model : undefined, harness: typeof flags.harness === "string" ? flags.harness : undefined }),
		});
		dto = (await res.json()) as AgentDTO;
	} catch (err) {
		reportApiError(err);
		process.exit(1);
		return;
	}
	if (flags["no-wait"]) {
		process.stdout.write(`asked. ${dto.id}\n  read it later: glance ask --read ${dto.id}\n`);
		return;
	}

	// Poll the ANSWER, not the agent: the agent row is reaped, the answer is durable. A unit that dies
	// without answering must not hang the operator forever, so an ended agent ends the wait too.
	const started = Date.now();
	const deadline = started + envInt("GLANCE_ASK_TIMEOUT_MS", 30 * 60_000);
	if (!flags.json) process.stderr.write(`thinking… (${dto.id})\n`);
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 2_000));
		const res = await fetch(`${base(flags)}/api/answers/${encodeURIComponent(dto.id)}`, { headers: tokenHeader() }).catch(() => null);
		const answer = res?.ok ? ((await res.json()) as { markdown?: string; answeredAt?: number; durationMs?: number }) : undefined;
		if (answer?.answeredAt && answer.markdown) {
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
			} else {
				process.stdout.write(`\n${answer.markdown}\n`);
				// A real display path (not --json, not --no-wait — that path never reaches here): the
				// operator just read this answer.
				reportAnswerReadCli(flags, repo, dto.id);
			}
			return;
		}
		const agents = await fetch(`${base(flags)}/api/agents`, { headers: tokenHeader() }).then((r) => (r.ok ? (r.json() as Promise<AgentDTO[]>) : [])).catch(() => []);
		const live = agents.find((a) => a.id === dto.id);
		if (!live) {
			// Gone from the roster with no answer on disk: say so, rather than spinning until the timeout.
			process.stderr.write(`the unit ended without answering (${dto.id})\n`);
			process.exit(1);
		}
		if (live.status === "error") {
			process.stderr.write(`the unit failed: ${live.blockedReason ?? "unknown error"}\n`);
			process.exit(1);
		}
	}
	process.stderr.write(`timed out after ${Math.round((Date.now() - started) / 60_000)}m — the unit is still running; read it later with: glance ask --read ${dto.id}\n`);
	process.exit(1);
}

/** `glance answers [--repo R]` / `glance ask --read <id>` — the durable side of the deliverable. */
async function cmdAnswers(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0] ?? (typeof flags.read === "string" ? flags.read : undefined);
	const routePath = id ? `/api/answers/${encodeURIComponent(id)}` : `/api/answers${flags.repo ? `?repo=${encodeURIComponent(String(flags.repo))}` : ""}`;
	let body: unknown;
	try {
		body = await (await api(flags, "answers", routePath)).json();
	} catch (err) {
		reportApiError(err);
		process.exit(1);
		return;
	}
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
		return;
	}
	if (id) {
		const a = body as { question: string; markdown: string; answeredAt?: number; repo?: string };
		process.stdout.write(`${a.question}\n\n${a.answeredAt ? a.markdown : "(not answered yet)"}\n`);
		// Displaying an unanswered placeholder isn't reading the answer; only an actual answeredAt+repo counts.
		if (a.answeredAt && a.repo) reportAnswerReadCli(flags, a.repo, id);
		return;
	}
	const list = body as Array<{ id: string; question: string; answeredAt?: number; repo: string }>;
	if (list.length === 0) {
		process.stdout.write('no answers yet. ask one: glance ask "why is dispatch slow?"\n');
		return;
	}
	for (const a of list) process.stdout.write(`${a.answeredAt ? "✔" : "…"} ${a.id.padEnd(34)} ${a.question.slice(0, 60)}\n`);
}

/**
 * `glance promote <issue> [--repo <path>] [--json]`
 *
 * adw-factory-borrows concern 05: enrich a Backlog Plane ticket with Tier-1/Tier-2 context through
 * the daemon's ask-mode seam, fail-closed validated against the same truncation `dispatchSpec`
 * applies at dispatch time. Never moves the ticket's state — Backlog stays Backlog; dragging it to
 * Todo in Plane is the release (concern 03's dispatcher state gate is what makes that drag mean
 * something). Blocks for the same wait window `glance ask` does — the enrichment IS an ask-mode unit
 * under the hood, so this can take several minutes on a non-trivial ticket.
 *
 * Deliberately NOT routed through `api()`: a refused connection near-instantly is genuinely "no
 * daemon", but a drop after minutes of waiting (ECONNRESET, or any other mid-flight socket error)
 * means the daemon WAS there and the promotion may still be running server-side — reporting both
 * as "no daemon" sends an operator chasing a dead lead while a live promotion keeps going unseen.
 * `api()`'s single network-catch message can't make that distinction, so this keeps its own
 * elapsed-time-aware catch. It DOES now check `res.ok` before trusting the body, closing the one
 * real drift here: previously this read `res.json()` unconditionally and trusted the body's own
 * `result.ok` field, so a non-2xx response with a well-formed JSON error body silently passed
 * through as an ordinary (if unsuccessful) promotion instead of a transport failure.
 */
async function cmdPromote(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const issue = positional[0];
	if (!issue) {
		process.stderr.write("usage: glance promote <issue-id-or-identifier> [--repo <path>] [--json]\n");
		process.exit(1);
	}
	const repo = typeof flags.repo === "string" ? path.resolve(flags.repo) : process.cwd();
	if (!flags.json) process.stderr.write(`promoting ${issue}… (waits for an ask-mode unit to investigate; can take several minutes)\n`);
	const requestStarted = Date.now();
	let res: Response | null = null;
	try {
		res = await fetch(`${base(flags)}/api/issues/${encodeURIComponent(issue)}/promote`, {
			method: "POST",
			headers: { ...tokenHeader(), "content-type": "application/json" },
			body: JSON.stringify({ repo }),
		});
	} catch (err) {
		// A refused connection fails near-instantly — that's genuinely "no daemon". A drop after the
		// request was already minutes into waiting (ECONNRESET, or any other mid-flight socket error) means
		// the daemon WAS there and the promotion may still be running server-side; reporting both as "no
		// daemon" sent an operator chasing a dead lead while a live promotion kept going unseen and a
		// confused retry could hit the idempotency guard.
		const elapsedMs = Date.now() - requestStarted;
		const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
		if (elapsedMs > 5_000) {
			process.stderr.write(
				`lost connection to the daemon ${Math.round(elapsedMs / 1000)}s into the promotion${code ? ` (${code})` : ""} — it may still be running server-side; check the Plane ticket for ${issue} or the daemon logs, then retry (an already-promoted ticket is refused, not re-enriched, so a retry is safe).\n`,
			);
		} else {
			process.stderr.write(`No glance daemon on ${base(flags)}. Start one with: glance up\n`);
		}
		process.exit(1);
	}
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		process.stderr.write(`promote failed: ${res.status} ${text}\n`);
		process.exit(1);
		return;
	}
	const result = (await res.json().catch(() => null)) as { ok: boolean; issue?: string; message: string; error?: string; draft?: string } | null;
	if (!result) {
		process.stderr.write(`promote failed: ${res.status} ${res.statusText}\n`);
		process.exit(1);
	}
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (!result.ok) process.exit(1);
		return;
	}
	if (result.ok) {
		process.stdout.write(`${result.message}\n`);
		return;
	}
	process.stderr.write(`${result.message}\n`);
	if (result.draft) process.stderr.write(`\n--- draft (not written) ---\n${result.draft}\n`);
	process.exit(1);
}

/**
 * `glance symptom "<query>" [--repo <path>] [--json]` — the pull-search half of DESIGN.md's "push at
 * motivation" (`glance doctor`'s auto-match is the push half: it surfaces the same index unprompted
 * inside a failing check's remedy). Ranking happens server-side (`GET /api/symptoms`, reusing
 * fabric-search's BM25 core); this renders the ranked hits, folding recurrences of the same symptom
 * text into one card (newest first) and flagging any `whereToLook` entry that no longer exists in
 * THIS repo tree — a dead pointer surfaced mid-incident is worse than none.
 */
async function cmdSymptom(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const query = positional.join(" ").trim();
	if (!query) {
		process.stderr.write('usage: glance symptom "<query>" [--repo <path>] [--json]\n');
		process.exit(1);
	}
	const repo = typeof flags.repo === "string" ? path.resolve(flags.repo) : undefined;
	const qs = new URLSearchParams({ q: query });
	if (repo) qs.set("repo", repo);
	let body: { query: string; results: SymptomSearchHit[] };
	try {
		body = (await (await api(flags, "symptom search", `/api/symptoms?${qs.toString()}`)).json()) as { query: string; results: SymptomSearchHit[] };
	} catch (err) {
		reportApiError(err);
		process.exit(1);
		return;
	}
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
		return;
	}
	if (body.results.length === 0) {
		process.stdout.write(`no matching symptom found for "${query}".\n`);
		return;
	}
	const repoRoot = repo ?? process.cwd();
	for (const group of groupSymptomHits(body.results)) {
		process.stdout.write(`\n${group.symptom}\n`);
		for (const hit of group.entries) {
			const pr = hit.fixedBy.prNumber ? ` (PR #${hit.fixedBy.prNumber})` : "";
			process.stdout.write(`  ${symptomAge(hit.landedAt)}${pr}\n`);
			for (const w of hit.whereToLook) {
				const stat = await statWhereToLookEntry(repoRoot, w);
				process.stdout.write(`    - ${formatWhereToLookEntry(w, stat)}\n`);
			}
		}
	}
}

/** The full `KbDocType` union (fabric-search.ts) — every `--type` filter `glance search` accepts. */
const FABRIC_TYPES: ReadonlySet<KbDocType> = new Set(["agent", "digest", "hot-area", "scout", "lease", "decision", "failure", "symptom", "episode", "answer"]);

/** `glance search "<query>" [--limit N] [--type <t>] [--json]` — ranked BM25 search over the fleet
 * knowledge base (`GET /api/fabric/search`, the same `searchFabric`/BM25 core `glance symptom` and
 * the webapp's ⌘K palette drive), so an operator can pull prior decisions/hot files/scout findings/
 * digests without leaving the terminal. `--limit` maps to the API's `topK` (server default 20; this
 * CLI defaults to 10, a terminal-sized page). `--type` is validated client-side against the full
 * `KbDocType` union so a typo fails loudly instead of silently returning zero results.
 */
async function cmdSearch(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const query = positional.join(" ").trim();
	if (!query) {
		process.stderr.write('usage: glance search "<query>" [--limit N] [--type <t>] [--json]\n');
		process.exit(1);
		return;
	}
	const rawLimit = flags.limit ? Number(flags.limit) : 10;
	const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 10;
	const type = typeof flags.type === "string" ? flags.type : undefined;
	if (type && !FABRIC_TYPES.has(type as KbDocType)) {
		process.stderr.write(`unknown --type "${type}" — expected one of ${[...FABRIC_TYPES].join(", ")}\n`);
		process.exit(1);
		return;
	}
	const qs = new URLSearchParams({ q: query, topK: String(limit) });
	if (type) qs.set("type", type);
	let body: { query: string; results: FabricSearchResult[]; counts: Record<string, number> };
	try {
		body = (await (await api(flags, "search", `/api/fabric/search?${qs.toString()}`)).json()) as { query: string; results: FabricSearchResult[]; counts: Record<string, number> };
	} catch (err) {
		reportApiError(err);
		process.exit(1);
		return;
	}
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
		return;
	}
	process.stdout.write(renderSearchResults(body.results, query));
}

export { cmdAdd, cmdList, cmdHarnesses, cmdOpen, cmdAar, cmdLogs, cmdDiff, cmdCommission, cmdAutomation, cmdGrr, cmdAsk, cmdAnswers, cmdPromote, cmdSymptom, cmdSearch };
