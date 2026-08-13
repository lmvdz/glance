/**
 * Pure render/formatting helpers for the `glance` CLI. Split out of src/index.ts (deepen
 * concern 22): every one of these takes already-fetched data and turns it into the text a
 * terminal prints — no fetch, no daemon, no process.exit. That's the deletion test this module
 * passes: delete it and every proxy verb in src/cli/client.ts loses its human-readable output,
 * so the formatting logic earns its own file rather than vanishing as a pass-through.
 */
import type { AgentDTO } from "../types.ts";
import type { FileDiff } from "../explore.ts";
import type { FabricSearchResult } from "../memory/fabric-search.ts";

export function renderAgentRoster(agents: AgentDTO[], opts: { json?: boolean } = {}): string {
	if (opts.json) return `${JSON.stringify(agents, null, 2)}\n`;
	if (!agents.length) return "no agents\n";
	const rows = agents.map((a) => ({
		status: a.status,
		name: a.name,
		branch: a.branch ?? "—",
		activity: a.activity ?? a.todo?.active ?? "—",
		pend: a.pending.length ? `⛔${a.pending.length}` : "",
	}));
	const w = {
		status: Math.max(6, ...rows.map((r) => r.status.length)),
		name: Math.max(4, ...rows.map((r) => r.name.length)),
		branch: Math.max(6, ...rows.map((r) => r.branch.length)),
	};
	return rows
		.map((r) => `${r.status.padEnd(w.status)}  ${r.name.padEnd(w.name)}  ${r.branch.padEnd(w.branch)}  ${r.pend.padEnd(4)}  ${r.activity}`)
		.join("\n") + "\n";
}

/** GET /api/harnesses shape (server.ts's noFleet handler) — the tier fields are additive to the
 *  pre-existing name/protocol/verified/capabilities/note response. */
export interface HarnessListingRow {
	name: string;
	protocol: string;
	verified: boolean;
	tier?: "verified" | "detected-unverified" | "registered-unverified";
	binDetected?: boolean;
	usageVerified?: boolean;
	alert?: string;
	note?: string;
}

const TIER_LABEL: Record<string, string> = {
	verified: "verified",
	"detected-unverified": "detected",
	"registered-unverified": "registered",
};

export function renderHarnessTable(rows: HarnessListingRow[], defaultHarness: string, opts: { json?: boolean } = {}): string {
	if (opts.json) return `${JSON.stringify(rows, null, 2)}\n`;
	if (!rows.length) return "no harnesses registered\n";
	const nameW = Math.max(4, ...rows.map((r) => r.name.length));
	const tierW = Math.max(4, ...rows.map((r) => (TIER_LABEL[r.tier ?? ""] ?? "—").length));
	const lines = rows.map((r) => {
		const name = (r.name === defaultHarness ? `${r.name}*` : r.name).padEnd(nameW + 1);
		const tier = (TIER_LABEL[r.tier ?? ""] ?? "—").padEnd(tierW);
		const usage = r.usageVerified ? "usage-verified" : "usage-unconfirmed";
		const alert = r.alert ? `  ⚠ ${r.alert}` : "";
		return `${name} ${tier}  ${r.protocol.padEnd(7)} ${usage}${alert}`;
	});
	return `${lines.join("\n")}\n`;
}

// ── ANSI (CLI-only; distinct from tui.ts's `c()` so a one-shot verb never pulls in pi-tui) ────────
const CLI_ESC = "\x1b[";
const CLI_RESET = `${CLI_ESC}0m`;
const CLI_CODES = { dim: "2", bold: "1", red: "91", green: "92", cyan: "96" } as const;
function cliColor(name: keyof typeof CLI_CODES, s: string, enabled: boolean): string {
	return enabled ? `${CLI_ESC}${CLI_CODES[name]}m${s}${CLI_RESET}` : s;
}

const DIFF_STATUS_LABEL: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type-changed", U: "unmerged" };
/** `FileDiff.status` is a git porcelain code — `"M "` from a tracked diff's name-status, `"??"` for
 *  an untracked file (see explore.ts's `worktreeDiffSinceFork`/`worktreeDiff`). Renders the human word. */
function diffStatusLabel(status: string): string {
	const code = status.trim();
	if (code === "??" || code === "?") return "untracked";
	return DIFF_STATUS_LABEL[code[0] ?? ""] ?? (code || "changed");
}

/** `+`/`-` line counts within one file's unified diff body, excluding the `+++`/`---` file headers. */
function diffLineCounts(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** `glance diff --stat` — per-file add/remove summary, no diff bodies. */
export function renderDiffStat(files: FileDiff[]): string {
	if (!files.length) return "no changes\n";
	const nameW = Math.max(4, ...files.map((f) => f.file.length));
	const statusW = Math.max(6, ...files.map((f) => diffStatusLabel(f.status).length));
	const counts = files.map((f) => diffLineCounts(f.diff));
	const lines = files.map((f, i) => `  ${f.file.padEnd(nameW)}  ${diffStatusLabel(f.status).padEnd(statusW)}  +${counts[i]!.added} -${counts[i]!.removed}`);
	const totals = counts.reduce((acc, c) => ({ added: acc.added + c.added, removed: acc.removed + c.removed }), { added: 0, removed: 0 });
	return `${lines.join("\n")}\n\n${files.length} file${files.length === 1 ? "" : "s"} changed, +${totals.added} -${totals.removed}\n`;
}

/** `glance diff` — the full colorized unified diff: dim file headers/hunk markers stay dim, `@@` hunk
 *  headers cyan, `+` lines green, `-` lines red, context lines plain. `opts.color` defaults off so a
 *  test (or a piped consumer) gets plain text without also stubbing `process.stdout.isTTY`. */
export function renderDiff(files: FileDiff[], opts: { color?: boolean } = {}): string {
	if (!files.length) return "no changes\n";
	const color = opts.color ?? false;
	const out: string[] = [];
	for (const f of files) {
		out.push(cliColor("bold", `${diffStatusLabel(f.status)}  ${f.file}`, color));
		if (!f.diff.trim()) {
			out.push(cliColor("dim", "  (no diff body — binary, or a pure rename/mode change)", color));
			out.push("");
			continue;
		}
		for (const line of f.diff.split("\n")) {
			if (line.startsWith("+++") || line.startsWith("---")) out.push(cliColor("dim", line, color));
			else if (line.startsWith("@@")) out.push(cliColor("cyan", line, color));
			else if (line.startsWith("+")) out.push(cliColor("green", line, color));
			else if (line.startsWith("-")) out.push(cliColor("red", line, color));
			else out.push(line);
		}
		out.push("");
	}
	return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

/** Coarse "how long ago" label for a symptom's `landedAt` — mirrors `fabric-search.ts`'s internal
 *  `agoLabel`, kept local here since that one isn't exported (it's fenced-primer-specific). Also
 *  used by `glance symptom` (src/cli/client.ts) directly, not just renderSearchResults below. */
export function symptomAge(landedAt: number): string {
	const mins = Math.round(Math.max(0, Date.now() - landedAt) / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/** `glance search "<query>" [--limit N] [--type T] [--json]` — ranked BM25 results, compact
 *  one-block-per-hit: score, type, title, snippet, then a pointer line (ref/source/age) when any of
 *  those are present. Mirrors `symptomAge`'s "Nm/Nh/Nd ago" scale for `ranAt`. */
export function renderSearchResults(results: FabricSearchResult[], query: string): string {
	if (!results.length) return `no matches for "${query}".\n`;
	const typeW = Math.max(4, ...results.map((r) => r.type.length));
	const blocks = results.map((r) => {
		const score = r.score.toFixed(2).padStart(5);
		const head = `  ${score}  ${r.type.padEnd(typeW)}  ${r.title}`;
		const snippet = r.snippet ? `\n           ${r.snippet}` : "";
		const pointer = [r.ref ? `ref: ${r.ref}` : "", r.source ? `src: ${r.source}` : "", r.ranAt ? symptomAge(r.ranAt) : ""].filter(Boolean).join("  ·  ");
		const pointerLine = pointer ? `\n           (${pointer})` : "";
		return `${head}${snippet}${pointerLine}`;
	});
	return `${blocks.join("\n\n")}\n`;
}
