#!/usr/bin/env bun
/**
 * glance CLI.
 *
 *   glance here                                   chat on the current directory, in this terminal
 *   glance up [--port N] [--no-tui] [--restore]   start the daemon (server + TUI)
 *   glance add <repo> [--name --branch --model --approval --task]
 *   glance list
 *   glance prompt <id> <message…>
 *   glance rm <id> [--delete-worktree]
 *   glance ask "<question>" [--repo …]           answer a question; no branch, nothing to merge
 *   glance answers [<id>]                        list or read durable answers
 *   glance aar [<id>]                            list or read after-action reports for terminal units
 *   glance promote <issue> [--repo …]            enrich a Backlog Plane ticket with Tier-1/Tier-2 context
 *   glance open
 *   glance doctor [--json]                        diagnose the factory: on? armed? pointed where?
 *   glance symptom "<query>" [--repo …]           search recorded symptom cards
 *
 * `up` is the long-lived process that owns the agents. The other verbs are thin
 * HTTP clients that talk to a running daemon's REST surface.
 *
 * This is the bin entrypoint — command dispatch table + arg parsing. The composition root
 * (`cmdUp`, ~255 lines of incident-documented boot ordering) lives in src/boot.ts; every
 * daemon-facing HTTP proxy verb (add/list/harnesses/prompt/…) lives in src/cli/client.ts, backed
 * by the render helpers in src/cli/render.ts. What stays here is: `glance here`'s own dispatch,
 * the five LOCAL-compute verbs that never talk to a daemon over HTTP (plan-validate,
 * plan-decompose, curate-plane, doctor, land-assessment) plus `who`/`install-hooks` (also local,
 * no fetch), and the string-command dispatch table itself (deepen concern 22).
 */

import "./env-compat.ts";
import * as os from "node:os";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import { renderDoctor, runDoctor } from "./doctor.ts";
import { makeDoctorProbe } from "./doctor-probe.ts";
import { installHarnessHooks, uninstallHarnessHooks } from "./harness-hooks.ts";
import { all as allPresence, who as whoPresence } from "./presence.ts";
import { loadEnvFile } from "./plane-secrets.ts";
import { curatePlaneIssues, renderClusterReport } from "./plane-curator.ts";
import { concernNumFromFile, parsePlanConcerns, validatePlanConcerns } from "./features.ts";
import { decompose, DECOMPOSE_TIMEOUT_MS, type VerifiedConcern } from "./planner.ts";
import { writeConcernDrafts } from "./plan-writer.ts";
import { ompClassify } from "./intake.ts";
import { base, DEFAULT_PORT, parseArgs, stateDirPath, tokenHeader } from "./cli-args.ts";
import { cmdHere } from "./here.ts";
import { runLandAssessmentCli } from "./land-assessment/cli.ts";
import { cmdUp } from "./boot.ts";
import { cmdAar, cmdAdd, cmdAnswers, cmdAsk, cmdAutomation, cmdCommission, cmdDiff, cmdGrr, cmdHarnesses, cmdKill, cmdList, cmdLogs, cmdNotify, cmdOpen, cmdPrompt, cmdPromote, cmdRm, cmdSearch, cmdSymptom } from "./cli/client.ts";

const HELP = `glance — manage a fleet of Oh My Pi agents across git worktrees

USAGE
  glance here [--model M]                       Chat with an agent on THIS directory, in this terminal
  glance up [--port N] [--no-tui] [--restore]   Start the daemon (web + TUI)
  glance add <repo> [flags]                     Spawn an agent in a new worktree
  glance list [--json]                          Show the roster
  glance harnesses [--json]                     Honest capability tiers for every registered harness
  glance install-hooks --harness [--uninstall]  Register lifecycle hooks so raw claude/codex sessions report in
  glance open <id|name|branch>                  Open a unit's worktree in your editor (OMP_SQUAD_OPEN_CMD, else terax/code)
  glance prompt <id> <message...>               Send an instruction to an agent
  glance notify <id> <summary...> [--detail x]  Flag an agent needs a human's attention (non-blocking)
  glance kill <id>                              Stop an agent but keep it in the roster
  glance rm <id> [--delete-worktree]            Remove an agent
  glance who [repo]                             Who/what is working a repo (any omp agent)
  glance logs <id> [--limit N]                  Print an agent's recent transcript
  glance diff <id> [--stat] [--json]            Colorized unified diff of an agent's changes since fork
  glance search "<query>" [--limit N] [--type T] [--json]  Ranked BM25 search over the fleet knowledge base
  glance automation [--window 1h] [--loop L]    Show what the background loops are doing (and Scout's LLM cost)
  glance ask "<question>" [--repo R]            Ask; the deliverable is a written answer, not a branch
  glance grr "<gripe>" [--list]                 Log a friction gripe to the dogfood ledger in <5s
  glance answers [<id>] [--repo R]              List answers, or print one
  glance aar [<id>] [--json]                    After-action reports for terminal units: list, or print one post-mortem
  glance promote <issue> [--repo R] [--json]    Enrich a Backlog Plane ticket with Tier-1/Tier-2 context
  glance open                                   Print the dashboard URL
  glance doctor [--json]                       Is the factory on, armed, and pointed at the right world?
  glance symptom "<query>" [--repo R] [--json]  Search recorded symptom cards (glance doctor's known-symptom index)
  glance land-assessment replay [--json]        Offline replay: analyzers vs. the labeled incident manifest
  glance curate-plane [repo] [--file]             Group recurring Plane issues into unified fixes
  glance plan-validate <dir> [--json]           Check a plan dir's dep graph for cycles / dangling deps (offline)
  glance plan-decompose <dir> [--json]          One-shot: decompose <dir>/OBJECTIVE.md into a concern-DAG (needs \`omp\`)

ADD FLAGS
  --name <s>        Agent name (default: agent-N)
  --branch <s>      Worktree branch (default: squad/<name>)
  --model <s>       Model (fuzzy, e.g. opus / gpt-5.2)
  --approval <m>    always-ask | write | yolo (default: write)
  --thinking <l>    minimal | low | medium | high | xhigh (default: low)
  --task <s>        Initial instruction sent once the agent is ready
  --workflow <name|path>  Run a bundled workflow by name (research-plan-implement, plan-implement, fan-out) or a .fabro path; --task is the goal
  --verify <cmd>    Wrap --task in an implement → verify → fixup loop (gate = exit 0)
  --sandbox <image> Run the agent inside a container from <image> (mounts the worktree)
  --acp             Run an ACP runtime (auggie --acp) instead of omp --mode rpc
  --plain           Skip auto-routing; spawn a plain agent (no verify/plan/fan-out)

COMMISSION FLAGS
  --purpose <s>            What the worker does (required)
  --model <spec>           Model specifier, or "false" for a deterministic worker (default: false)
LIST FLAGS
  --json           Emit the raw roster JSON from GET /api/agents

CURATE-PLANE FLAGS
  --file                    File one [curator] do-not-auto-land issue per cluster

DIFF FLAGS
  --stat            Per-file add/remove summary only, no diff bodies
  --json             Emit the raw GET /api/agents/:id/diff payload

SEARCH FLAGS
  --limit <N>        Max results (default 10)
  --type <t>         Filter to one type: agent | digest | hot-area | scout | lease | decision | failure | symptom | episode | answer
  --json             Emit the raw GET /api/fabric/search payload

GLOBAL
  --port <N>        Daemon port (default: ${DEFAULT_PORT}, or $OMP_SQUAD_PORT)
  --host <addr>     Bind address (default: 127.0.0.1). A non-loopback bind (e.g. 0.0.0.0)
                    requires TLS ($OMP_SQUAD_TLS_CERT/$OMP_SQUAD_TLS_KEY) or a TLS tunnel
                    (tailscale serve / cloudflared); override with OMP_SQUAD_INSECURE=1.
                    Env: $OMP_SQUAD_HOST, $OMP_SQUAD_TLS_CERT/$OMP_SQUAD_TLS_KEY (in-process TLS).
                    A bearer token is auto-generated in the state dir and printed on boot.
  --no-supervise    Don't auto-answer agent prompts (default on; or OMP_SQUAD_AUTO_SUPERVISE=0)
`;

// parseArgs / base / stateDirPath / tokenHeader now live in cli-args.ts (shared with `glance here`).

async function cmdWho(args: string[]): Promise<void> {
	const { positional } = parseArgs(args);
	const repo = positional[0];
	const entries = repo ? await whoPresence(repo) : await allPresence();
	if (!entries.length) {
		process.stdout.write(repo ? `nobody is working on ${repo}\n` : "no active agents\n");
		return;
	}
	for (const e of entries) {
		const s = Math.max(0, Math.round((Date.now() - e.heartbeat) / 1000));
		const ago = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
		process.stdout.write(`${e.source.padEnd(5)} ${e.operator}/${e.agent}  ${e.repoName}${e.branch ? ` (${e.branch})` : ""}  ${ago} ago\n`);
	}
}

/** `glance install-hooks --harness [--uninstall]` — register the lifecycle shim in each
 *  VERIFIED foreign harness's own hook config, so a raw `claude` session inside a fleet repo
 *  becomes visible to `glance who` the instant it starts (fleet-ide-bridge B03). */
async function cmdInstallHooks(args: string[]): Promise<void> {
	const { flags } = parseArgs(args);
	if (!flags.harness) {
		process.stderr.write("usage: glance install-hooks --harness [--uninstall]\n");
		process.exit(1);
	}
	const stateDir = stateDirPath();
	const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
	const reports = flags.uninstall ? await uninstallHarnessHooks(stateDir) : await installHarnessHooks(stateDir, port);
	for (const r of reports) {
		const verb = flags.uninstall ? "removed" : r.installed ? "installed" : "skipped";
		process.stdout.write(`${r.harness}: ${verb}${r.reason ? ` — ${r.reason}` : ""}\n`);
	}
}

/**
 * Offline plan-DAG validator — reads a plan dir straight off disk (no daemon) and reports
 * dependency cycles + dangling deps, using the same core the UI diagram uses. Exit 0 = clean,
 * 1 = issues found (a signal the pipeline skills branch on, warning-first not a hard gate).
 */
async function cmdPlanValidate(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const dir = positional[0];
	if (!dir) {
		process.stderr.write("usage: omp-squad plan-validate <plan-dir> [--json]\n");
		process.exit(1);
		return;
	}
	// Accept an absolute or cwd-relative plan dir; validatePlanConcerns joins repo+planDir,
	// so passing repo="" + the resolved absolute path works for both.
	const abs = path.resolve(dir);
	const issues = await validatePlanConcerns("", abs);
	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ dir: abs, issues }, null, 2)}\n`);
		if (issues.length) process.exit(1);
		return;
	}
	if (!issues.length) {
		process.stdout.write(`✓ ${path.basename(abs)} — plan dependency graph is clean (no cycles or dangling deps)\n`);
		return;
	}
	process.stdout.write(`⚠ ${path.basename(abs)} — ${issues.length} plan dependency issue${issues.length === 1 ? "" : "s"}:\n`);
	for (const issue of issues) process.stdout.write(`  • [${issue.kind}] ${issue.message}\n`);
	process.exit(1);
}

/** STATUS values that mean "finished" — mirrors plan-sync.ts's own local TERMINAL set. */
const TERMINAL_STATUSES = new Set(["done", "complete", "completed", "closed", "cancelled", "canceled"]);

/**
 * One-shot decompose→write→validate cycle against a plans/<name>/OBJECTIVE.md — the manual
 * dogfood path for the resident planner (resident-planner.ts) AND the deterministic end-to-end
 * harness for its epic's top-level Verify, without standing up the daemon loop. The verified set
 * here is local-terminal-STATUS only: the DoneProof ledger (done-proof.ts) that lets the live
 * daemon loop react to a land BEFORE plan-sync catches STATUS up is only available inside a
 * running SquadManager (resident-planner.ts, wired in squad-manager.ts) — this off-daemon path
 * has no ledger to consult, so it falls back to whatever STATUS is already on disk.
 */
async function cmdPlanDecompose(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const dir = positional[0];
	if (!dir) {
		process.stderr.write("usage: omp-squad plan-decompose <plan-dir> [--json]\n");
		process.exit(1);
		return;
	}
	const abs = path.resolve(dir);
	const objective = await readFile(path.join(abs, "OBJECTIVE.md"), "utf8").catch(() => undefined);
	if (objective === undefined || !objective.trim()) {
		const msg = `no OBJECTIVE.md found in ${abs} (create one to seed the resident planner)`;
		if (flags.json) process.stdout.write(`${JSON.stringify({ dir: abs, error: msg })}\n`);
		else process.stderr.write(`✗ ${msg}\n`);
		process.exit(1);
		return;
	}

	const existing = await parsePlanConcerns("", abs);
	const verified: VerifiedConcern[] = existing.filter((c) => TERMINAL_STATUSES.has(c.status)).map((c) => ({ num: concernNumFromFile(c.file) ?? undefined, title: c.title, planeId: c.planeId }));
	const openExisting = existing.filter((c) => !TERMINAL_STATUSES.has(c.status));
	const drafts = await decompose({ objective, verified, existing: openExisting, classify: ompClassify(undefined, DECOMPOSE_TIMEOUT_MS) });

	if (drafts.length === 0) {
		// Never attempt a destructive empty write (that would prune every open concern) — a failed
		// or empty decompose is a no-op, not a gate failure. Exit 0: nothing was wrong, nothing changed.
		if (flags.json) process.stdout.write(`${JSON.stringify({ dir: abs, written: [], removed: [], issues: [], ok: true, concernsWritten: 0 }, null, 2)}\n`);
		else process.stdout.write(`${path.basename(abs)} — decompose produced no concerns this pass (objective may already be fully planned, or the model call failed)\n`);
		return;
	}

	const result = await writeConcernDrafts("", abs, drafts);
	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ dir: abs, written: result.written, removed: result.removed, issues: result.issues, ok: result.ok, concernsWritten: result.ok ? drafts.length : 0 }, null, 2)}\n`);
		if (!result.ok) process.exit(1);
		return;
	}
	if (!result.ok) {
		process.stdout.write(`✗ ${path.basename(abs)} — dependency graph gate refused (${result.issues.length} issue${result.issues.length === 1 ? "" : "s"}):\n`);
		for (const issue of result.issues) process.stdout.write(`  • [${issue.kind}] ${issue.message}\n`);
		process.exit(1);
		return;
	}
	process.stdout.write(`✓ ${drafts.length} concern${drafts.length === 1 ? "" : "s"} written to ${path.basename(abs)}\n`);
}

async function cmdCuratePlane(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	loadEnvFile(path.join(os.homedir(), ".claude", "secrets", "plane.env"));
	const rawRepo = positional[0];
	const repo = rawRepo ? (rawRepo === "." || rawRepo.startsWith("./") || rawRepo.startsWith("../") || rawRepo.startsWith("/") ? path.resolve(rawRepo) : rawRepo) : process.cwd();
	const report = await curatePlaneIssues(repo, { file: flags.file === true });
	if (!report) {
		process.stderr.write("Plane is not configured or unreachable\n");
		process.exit(1);
	}
	process.stdout.write(`${renderClusterReport(report)}\n`);
}

/**
 * `glance doctor` — R6's answer. Exit code IS the verdict, so CI and the operator's `&&` both work:
 * 0 = nothing blocking, 1 = the factory cannot do its job. A warning never fails the command; a warning
 * that failed the command would be turned off within a week.
 */
async function cmdDoctor(args: string[]): Promise<void> {
	const { flags } = parseArgs(args);
	const report = await runDoctor(makeDoctorProbe({ base: base(flags), headers: tokenHeader(), cwd: process.cwd() }));
	process.stdout.write(flags.json ? `${JSON.stringify(report, null, 2)}
` : renderDoctor(report));
	if (!report.healthy) process.exit(1);
}

async function main(): Promise<void> {
	const [cmd, ...rest] = process.argv.slice(2);
	switch (cmd) {
		case undefined:
		case "up":
			await cmdUp(rest);
			break;
		case "here":
			await cmdHere(rest);
			break;
		case "add":
			await cmdAdd(rest);
			break;
		case "who":
			await cmdWho(rest);
			break;
		case "list":
		case "ls":
			await cmdList(rest);
			break;
		case "harnesses":
			await cmdHarnesses(rest);
			break;
		case "prompt":
		case "say":
			await cmdPrompt(rest);
			break;
		case "notify":
			await cmdNotify(rest);
			break;
		case "install-hooks":
			await cmdInstallHooks(rest);
			break;
		case "open":
			await cmdOpen(rest);
			break;
		case "kill":
		case "stop":
			await cmdKill(rest);
			break;
		case "rm":
		case "remove":
			await cmdRm(rest);
			break;
		case "logs":
			await cmdLogs(rest);
			break;
		case "diff":
			await cmdDiff(rest);
			break;
		case "search":
			await cmdSearch(rest);
			break;
		case "automation":
		case "auto":
			await cmdAutomation(rest);
			break;
		case "commission":
		case "hire":
			await cmdCommission(rest);
			break;
		case "curate-plane":
		case "plane-curator":
			await cmdCuratePlane(rest);
			break;
		case "plan-validate":
		case "validate-plan":
			await cmdPlanValidate(rest);
			break;
		case "plan-decompose":
			await cmdPlanDecompose(rest);
			break;
		case "ask":
			if (typeof parseArgs(rest).flags.read === "string") await cmdAnswers(rest);
			else await cmdAsk(rest);
			break;
		case "grr":
			await cmdGrr(rest);
			break;
		case "answers":
			await cmdAnswers(rest);
			break;
		case "aar":
			await cmdAar(rest);
			break;
		case "promote":
			await cmdPromote(rest);
			break;
		case "doctor":
			await cmdDoctor(rest);
			break;
		case "land-assessment":
			await runLandAssessmentCli(rest);
			break;
		case "symptom":
			await cmdSymptom(rest);
			break;
		case "help":
		case "-h":
		case "--help":
			process.stdout.write(HELP);
			break;
		default:
			process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
			process.exit(1);
	}
}

if (import.meta.main) void main();
