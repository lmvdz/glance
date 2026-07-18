/**
 * `glance land-assessment` -- the offline replay CLI (concern 06, `plans/land-assessment/06-replay-cli-and-report.md`).
 * Wired at `src/index.ts` the same way `doctor` is (`case "doctor":` -> `cmdDoctor`, anchor re-verified
 * 2026-07-17) -- one `case "land-assessment":` delegating everything here.
 *
 * Subcommands:
 *   replay    run every analyzer over the manifest's labeled incidents (go/no-go evidence), an
 *             optional synthetic corpus (structural-api/dependency's only recall source), and an
 *             optional real reconstructed corpus (broader runtime/coverage/precision-at-budget stats).
 *             Exits non-zero ONLY when the event store's own strict-with-accounting read found a
 *             malformed line -- the concern's explicit "no flag to silence in v0".
 *   inspect   look up one `assessmentKey` or `attemptId` in the durable store and dump its full record.
 *
 * This module never calls `gh` itself (matches `replay/corpus.ts`'s own "network dependency is the
 * caller's to own" contract) -- `--merged-prs-json` reads a caller-supplied file instead.
 *
 * `cmdReplay`/`cmdInspect` return `{code, stdout}` rather than writing directly and calling
 * `process.exit` themselves -- `runLandAssessmentCli` is the ONE place that touches the real process
 * (write + exit), so `run.test.ts` can drive both subcommands in-process and assert on their exact
 * output/exit code without a subprocess.
 */

import { readFile } from "node:fs/promises";
import { parseArgs, stateDirPath } from "../cli-args.ts";
import { git } from "./analyzers/plugin.ts";
import { computeRepositoryId } from "./id.ts";
import { buildReplayCorpus, splitCorpusAt, type MergedPrRow, type ReplayCorpus } from "./replay/corpus.ts";
import { loadIncidentManifest } from "./replay/incident-taxonomy.ts";
import { computeMetrics, renderMarkdown, toJson } from "./replay/report.ts";
import { runReplay } from "./replay/run.ts";
import type { SyntheticCorpusFile } from "./replay/synthesize.ts";
import { reconstructRepositoryStore } from "./store-reader.ts";

const HELP = `glance land-assessment <subcommand>

  replay     run the offline replay: analyzers over the labeled incident manifest (+ optional
             synthetic/real corpora) -> JSON + Markdown report.
    --repo <path>              default: cwd
    --state-dir <path>         default: resolved glance state dir
    --main-ref <ref>           default: main -- resolved ONCE for every manifest entry missing a
                                pinned mainCommit, and as the corpus reconstruction's main ref.
    --from <iso-date>          only include real-corpus lands landed on/after this date (temporal
                                holdout -- omit for the full corpus).
    --merged-prs-json <path>   JSON array of {number, headRefOid, baseRefOid?, mergeCommit?, mergedAt}
                                rows (this CLI never calls \`gh\` itself) -- feeds the pr-merge corpus
                                source. Omit to skip that source.
    --skip-corpus               skip the real-corpus pass entirely (manifest scoring only).
    --skip-synthetic             skip the synthetic corpus pass entirely.
    --synthetic-cap <n>          max TS files to synthesize mutations over. default: 15
    --json                       print the JSON report instead of Markdown.

  inspect <assessmentId|attemptId>   dump one stored record by id.
`;

export interface CliResult {
	code: number;
	stdout: string;
}

async function resolveMainCommit(repo: string, mainRef: string): Promise<string> {
	const r = await git(["rev-parse", mainRef], repo);
	if (r.code !== 0 || !r.stdout) {
		throw new Error(`land-assessment: could not resolve --main-ref "${mainRef}" in ${repo}: ${r.stderr || r.stdout || "no output"}`);
	}
	return r.stdout;
}

/** Read up to `cap` TS files' content AT `commit` (never the live working tree -- replay stays
 *  commit-addressed, matching the whole subsystem's own ethos) via `git ls-tree`/`git show`, sorted for
 *  determinism. Read failures degrade a single file to "skip it", never abort the whole listing. */
async function listTsFilesAtCommit(repo: string, commit: string, cap: number): Promise<SyntheticCorpusFile[]> {
	const ls = await git(["ls-tree", "-r", "--name-only", commit], repo);
	if (ls.code !== 0 || !ls.stdout) return [];
	const paths = ls.stdout
		.split("\n")
		.filter((p) => p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.includes("node_modules/"))
		.sort()
		.slice(0, cap);
	const files: SyntheticCorpusFile[] = [];
	for (const p of paths) {
		const show = await git(["show", `${commit}:${p}`], repo);
		if (show.code !== 0) continue;
		files.push({ sourcePath: p, sourceContent: show.stdout });
	}
	return files;
}

async function readMergedPrRows(filePath: string): Promise<MergedPrRow[]> {
	const raw = await readFile(filePath, "utf8");
	const parsed = JSON.parse(raw) as unknown;
	if (!Array.isArray(parsed)) throw new Error(`land-assessment: --merged-prs-json ${filePath} must be a JSON array`);
	return parsed as MergedPrRow[];
}

/** @substrate Test-only entry point (`run.test.ts` drives it directly) plus `runLandAssessmentCli`'s own
 *  production dispatch -- not dead despite the name mirroring the test-injection convention other
 *  concerns use, since `runLandAssessmentCli` below is a real, non-test caller. */
export async function cmdReplay(args: string[]): Promise<CliResult> {
	const { flags } = parseArgs(args);
	const repoArg = typeof flags.repo === "string" ? flags.repo : process.cwd();
	const repo = computeRepositoryId(repoArg);
	const stateDir = typeof flags["state-dir"] === "string" ? flags["state-dir"] : stateDirPath();
	const mainRef = typeof flags["main-ref"] === "string" ? flags["main-ref"] : "main";
	const syntheticCap = typeof flags["synthetic-cap"] === "string" ? Number(flags["synthetic-cap"]) : 15;

	const manifest = loadIncidentManifest();
	const mainCommit = await resolveMainCommit(repo, mainRef);

	let corpus: ReplayCorpus | undefined;
	if (!flags["skip-corpus"]) {
		const mergedPrRows = typeof flags["merged-prs-json"] === "string" ? await readMergedPrRows(flags["merged-prs-json"]) : [];
		const built = await buildReplayCorpus({ repo, mainRef, stateDir, mergedPrRows });
		corpus = typeof flags.from === "string" ? { ...built, triples: splitCorpusAt(built, flags.from).holdout } : built;
	}

	const syntheticFiles = flags["skip-synthetic"] ? [] : await listTsFilesAtCommit(repo, mainCommit, Number.isFinite(syntheticCap) ? syntheticCap : 15);

	const run = await runReplay({ repo, stateDir, manifest, mainCommitForUnpinnedEntries: mainCommit, corpus, syntheticFiles });
	const metrics = computeMetrics(run, manifest);
	const stdout = flags.json ? `${toJson(metrics)}\n` : renderMarkdown(metrics);
	return { code: metrics.incomplete ? 1 : 0, stdout };
}

/** @substrate Only `runLandAssessmentCli` (same file) and `run.test.ts` call this directly today --
 *  kept exported so tests can drive the `inspect` subcommand in-process without a subprocess, mirroring
 *  `cmdReplay`'s own convention just above. */
export async function cmdInspect(args: string[]): Promise<CliResult> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0];
	if (!id) return { code: 1, stdout: "" };
	const repoArg = typeof flags.repo === "string" ? flags.repo : process.cwd();
	const repo = computeRepositoryId(repoArg);
	const stateDir = typeof flags["state-dir"] === "string" ? flags["state-dir"] : stateDirPath();

	const store = await reconstructRepositoryStore(stateDir, repo);
	const snapshot = store.snapshotsByAssessmentKey.get(id);
	if (snapshot) return { code: 0, stdout: `${JSON.stringify(snapshot, null, 2)}\n` };
	const attempt = store.attempts.find((a) => a.attemptId === id);
	if (attempt) return { code: 0, stdout: `${JSON.stringify(attempt, null, 2)}\n` };
	return { code: 1, stdout: "" };
}

export async function runLandAssessmentCli(args: string[]): Promise<void> {
	const [sub, ...rest] = args;
	let result: CliResult;
	switch (sub) {
		case "replay":
			result = await cmdReplay(rest);
			break;
		case "inspect": {
			result = await cmdInspect(rest);
			if (result.code !== 0 && !result.stdout) {
				const id = rest[0];
				process.stderr.write(id ? `land-assessment inspect: no assessmentKey or attemptId "${id}" found\n` : `land-assessment inspect: missing <assessmentId|attemptId>\n\n${HELP}`);
			}
			break;
		}
		case "help":
		case "-h":
		case "--help":
		case undefined:
			result = { code: 0, stdout: HELP };
			break;
		default:
			process.stderr.write(`land-assessment: unknown subcommand "${sub}"\n\n${HELP}`);
			result = { code: 1, stdout: "" };
	}
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.code !== 0) process.exit(result.code);
}
