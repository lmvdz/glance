/**
 * `glance promote` — one-shot Tier-1/Tier-2 enrichment with a human release gate
 * (plans/adw-factory-borrows concern 05).
 *
 * A human (or, later, an automation) points this at a Backlog Plane ticket and gets back a body
 * carrying agent-authored Tier-1 (reviewer narrative) + Tier-2 (agent implementation schema)
 * context — fail-closed validated against the SAME truncation `dispatchSpec` applies at spawn time
 * (squad-manager.ts:1354-1366), so a draft that only validates before the cut is refused, not shipped
 * silently broken. The ticket itself never moves state: Backlog stays Backlog. Release to Todo — the
 * gate concern 03 taught the dispatcher to require — is a human dragging the card, never this code.
 *
 * Runs the enrichment through the manager's real `ask()` seam, not a raw `create({ask})`: `ask()` is
 * the only path that sets `executionRole: "observer"` + `track: false` + `autoRoute: false` together,
 * so the promoting unit gets a real worktree to investigate the repo in (plan docs, source, CLAUDE.md)
 * but can never land, never gets routed into a build workflow, and never occupies the WIP-tracked
 * roster the way a build unit does. Replicating that trio by hand here would be one flag away from
 * silently auto-routing the promoter into landing its own draft.
 *
 * Prompt-injection chain (DESIGN.md risk table): a Scout finding could ride Backlog → promoter →
 * Tier-2 spec → a yolo dispatched unit's system prompt. Three mitigations, all here: (1) quarantined
 * titles (`do-not-auto-land` / `[scout]` / `[observer]`) are refused outright — a human must strip the
 * marker first if they truly mean it; (2) the draft is validated in the exact truncated shape
 * `dispatchSpec` will inject, not the full draft — a body that only validates before the cut is a
 * refusal, not a silent injection of a half-formed spec; (3) release still requires a human drag to
 * Todo. The residual risk (a human drags a bad promotion anyway) is accepted and documented, not
 * engineered around — the human tap IS the trust boundary here.
 */

import { envInt } from "./config.ts";
import { errText } from "./err-text.ts";
import { LOCAL_ACTOR } from "./federation.ts";
import { fetchIssueBodyHtml, fetchIssueDetail, hashPlaneBody, listPlaneIssues, noAutoDispatchName, updatePlaneIssueBody } from "./plane.ts";
import { parseTier2 } from "./tier2.ts";
import type { Actor, AgentDTO, IssueRef, TaskDetail } from "./types.ts";
import type { Answer } from "./answers.ts";

export type PromoteError =
	| "not-configured" // Plane isn't configured for this repo
	| "not-found" // no open issue matches the given id/identifier
	| "quarantined" // do-not-auto-land / [scout] / [observer] — a human must strip the marker first
	| "already-promoted" // Tier-2 sections already present; re-running would waste a unit and risk clobbering a reviewed draft
	| "fleet-busy" // WIP cap / host pressure at spawn time — the caller should retry, not treat this as a hard failure
	| "no-answer" // the promoting unit ended (or errored) without ever answering
	| "timed-out" // the unit is still running past the wait window; the caller can read the answer later
	| "validation-failed" // parseTier2 came back empty on the injectable (truncated) form
	| "write-failed"; // updatePlaneIssueBody refused (conflict / request-failed / multi-org / …)

export type PromoteResult =
	| { ok: true; issue: string; message: string }
	| { ok: false; error: PromoteError; message: string; draft?: string };

/** The minimal manager surface `promoteIssue` needs — narrow on purpose so tests can supply a fake
 *  without booting a real `SquadManager` (state dir, worktrees, RPC). `SquadManager` satisfies this
 *  structurally; no adapter needed at the call sites. */
export interface PromoteManager {
	ask(opts: { repo: string; question: string; model?: string; harness?: string; name?: string }, actor?: Actor): Promise<AgentDTO>;
	answer(id: string): Promise<Answer | undefined>;
	list(): AgentDTO[];
}

/** Same quarantine set the red team named (S7): a promoter that enriches LLM-self-filed work is
 *  injection amplification, not triage. `noAutoDispatchName` already covers the do-not-auto-land /
 *  human-review phrasing; scout and observer findings carry their own bracket tags instead. */
function isQuarantined(name: string): boolean {
	return noAutoDispatchName(name) || /\[scout\]|\[observer\]/i.test(name);
}

/** True once this issue already carries Tier-2 content — either the concern-04 HTML marker (best
 *  effort: Plane's `description_stripped` typically drops HTML comments entirely, so this rarely
 *  fires on its own) or non-empty `parseTier2` sections (the reliable signal: `fetchIssueDetail`
 *  parses `tier2` off the raw `description_html` when Plane returns one). Either signal is sufficient
 *  — re-promoting an already-promoted ticket wastes a unit and risks clobbering a human-reviewed draft. */
function alreadyPromoted(detail: Pick<TaskDetail, "body" | "tier2">): boolean {
	if (/<!--\s*promoted:/i.test(detail.body)) return true;
	const { acceptanceCriteria, verification, scope } = detail.tier2;
	return !!(acceptanceCriteria || verification || scope);
}

function findIssue(refs: IssueRef[], idOrIdentifier: string): IssueRef | undefined {
	const want = idOrIdentifier.toLowerCase();
	return refs.find((r) => r.id.toLowerCase() === want || r.identifier?.toLowerCase() === want);
}

/** The promote-issue skill's checklist (`~/.claude/skills/promote-issue`), ported into a self-contained
 *  prompt for an ask-mode unit that has a real worktree but no interactive human beside it — it must
 *  investigate (read the ticket, any linked plan doc, source, CLAUDE.md) and derive the schema itself,
 *  fabricating nothing. Tier-2 headings are exact-matched by `parseTier2`'s regexes (`accept`,
 *  `verif|gate`, `scope|boundary`) — renaming them silently breaks the fail-closed validator downstream. */
function promotePrompt(issue: IssueRef, detail: TaskDetail): string {
	return [
		`Promote the Plane ticket "${issue.name}"${issue.identifier ? ` (${issue.identifier})` : ""} from triage-ready to implementation-ready.`,
		"",
		"Current ticket body:",
		"```",
		detail.body || "(empty body)",
		"```",
		"",
		"Investigate before writing anything: look for a `Source:` line or a referenced plan doc under plans/ and",
		"read it in full; open the source files it names and resolve real line numbers (plan docs drift, source",
		"doesn't); read the relevant package CLAUDE.md for its verification gate command. If no plan doc or source",
		"evidence exists, say so plainly in Tier-1 rather than inventing one.",
		"",
		"Your FINAL MESSAGE must be raw HTML (no markdown fences, no commentary before or after it) using EXACTLY",
		"this structure — the headings below are parsed by a regex, so keep their wording:",
		"",
		"<h2>Tier-1 origin &amp; research context</h2>",
		"<h3>Discovery</h3><p>...date + how this was found (audit / review / incident)...</p>",
		"<h3>Why the fix is non-trivial</h3><p>...the constraint that makes options exist...</p>",
		"<h3>Options considered</h3><ul><li>...each option, cost, tradeoff...</li></ul>",
		"<h3>Recommendation rationale</h3><p>...why this option, why now...</p>",
		"",
		"<h2>Tier-2 implementation context</h2>",
		"<h3>Touches (files + lines)</h3><ul><li><code>path/to/file.ts:12-40</code> — what changes there</li></ul>",
		"<h3>Acceptance test</h3><pre><code>the exact command that passes once this is done</code></pre>",
		"<h3>Verification gate</h3><pre><code>the package's standard check/test command</code></pre>",
		"<h3>Scope</h3><p><strong>Allowed:</strong> ...</p><p><strong>Denied:</strong> ...</p>",
		"<h3>Expected vs. actual</h3><p><strong>Actual:</strong> ...</p><p><strong>Expected:</strong> ...</p>",
		"",
		"If you genuinely cannot derive a real acceptance test or verification gate (not \"run the suite\" — that's",
		"too broad), say so explicitly inside those sections instead of inventing one. A ticket that can't carry a",
		"real Tier-2 will correctly be refused promotion rather than handed to an agent blind — that is the",
		"intended outcome, not a failure on your part.",
	].join("\n");
}

/** How long to wait for the promoting unit's answer before giving up (the caller can still read it
 *  later via `glance ask --read`/`GET /api/answers/:id` — the answer is durable). Shares
 *  `GLANCE_ASK_TIMEOUT_MS` with `glance ask`: this is the same underlying ask-mode primitive, so a
 *  second timeout env would just be two names for one knob. */
function askTimeoutMs(): number {
	return envInt("GLANCE_ASK_TIMEOUT_MS", 30 * 60_000);
}

type WaitOutcome = { kind: "answered"; answer: Answer } | { kind: "no-answer" } | { kind: "timed-out" };

/** Poll the durable answer, not the roster row (mirrors `glance ask`'s CLI wait loop, index.ts
 *  cmdAsk): an ended unit that never answered must not hang the caller until the timeout, and a
 *  unit that errors mid-run is the same "no answer coming" outcome as one that got reaped. Checks
 *  BEFORE sleeping on every iteration — a unit that already finished (or a fake, in tests) resolves
 *  without paying the poll interval at all. */
async function waitForAnswer(manager: PromoteManager, agentId: string): Promise<WaitOutcome> {
	const deadline = Date.now() + askTimeoutMs();
	for (;;) {
		const answer = await manager.answer(agentId);
		if (answer?.answeredAt && answer.markdown) return { kind: "answered", answer };
		const live = manager.list().find((a) => a.id === agentId);
		if (!live || live.status === "error") return { kind: "no-answer" };
		if (Date.now() >= deadline) return { kind: "timed-out" };
		await new Promise((r) => setTimeout(r, 2_000));
	}
}

/**
 * Enrich one Backlog Plane issue with Tier-1/Tier-2 context and write it back. Never moves the
 * issue's state — Backlog stays Backlog; a human dragging it to Todo is the release (concern 03's
 * dispatcher state gate is what makes that drag meaningful).
 */
export async function promoteIssue(manager: PromoteManager, repo: string, issueIdOrIdentifier: string, actor: Actor = LOCAL_ACTOR): Promise<PromoteResult> {
	const refs = await listPlaneIssues(repo);
	if (refs === null) return { ok: false, error: "not-configured", message: "Plane is not configured for this repo." };
	const ref = findIssue(refs, issueIdOrIdentifier);
	if (!ref) return { ok: false, error: "not-found", message: `no open issue matching "${issueIdOrIdentifier}".` };

	if (isQuarantined(ref.name)) {
		return {
			ok: false,
			error: "quarantined",
			message: `refusing to promote "${ref.name}" — do-not-auto-land / [scout] / [observer] tickets are LLM-self-filed or human-review-flagged; strip the marker first if you truly mean to promote it.`,
		};
	}

	const detail = await fetchIssueDetail(repo, ref.id);
	if (!detail) return { ok: false, error: "not-configured", message: "could not fetch the issue body from Plane." };
	if (alreadyPromoted(detail)) {
		return { ok: false, error: "already-promoted", message: `${ref.identifier ?? ref.id} already carries Tier-2 content — not re-promoting.` };
	}

	let dto: AgentDTO;
	try {
		dto = await manager.ask({ repo, question: promotePrompt(ref, detail), name: `promote-${(ref.identifier ?? ref.id).toLowerCase()}` }, actor);
	} catch (err) {
		return { ok: false, error: "fleet-busy", message: `fleet busy, retry: ${errText(err)}` };
	}

	const waited = await waitForAnswer(manager, dto.id);
	if (waited.kind === "no-answer") {
		return { ok: false, error: "no-answer", message: `the promotion unit (${dto.id}) ended without answering — check its transcript and retry.` };
	}
	if (waited.kind === "timed-out") {
		return { ok: false, error: "timed-out", message: `still running past the wait window — read it later with: glance ask --read ${dto.id}` };
	}
	const draft = waited.answer.markdown.trim();

	// Fail-closed on the INJECTABLE form (red-team S7): validate exactly the truncation `dispatchSpec`
	// applies at spawn time (squad-manager.ts:1354-1366), not the full draft. A draft that only
	// validates before the cut must be refused, not shipped silently broken past that boundary.
	const cap = envInt("OMP_SQUAD_SPEC_MAX_CHARS", 4000);
	const truncated = draft.length > cap ? `${draft.slice(0, cap)}\n…(spec truncated at ${cap} chars)` : draft;
	const truncatedTier2 = parseTier2(truncated);
	if (!truncatedTier2.acceptanceCriteria || !truncatedTier2.verification) {
		const fullTier2 = parseTier2(draft);
		if (fullTier2.acceptanceCriteria && fullTier2.verification) {
			return {
				ok: false,
				error: "validation-failed",
				message: `the full draft validates but is cut by the ${cap}-char injection cap before its Acceptance test / Verification gate — trim the Tier-1 prose, don't raise the cap. Draft attached.`,
				draft,
			};
		}
		return {
			ok: false,
			error: "validation-failed",
			message: "the draft is missing an Acceptance test or Verification gate section after Tier-2 parsing — refusing to write it to Plane. Draft attached.",
			draft,
		};
	}

	// Re-read-before-write, hash-guarded (audit F5 / code-review [9]): read the RAW live body
	// (`description_html` — the exact representation the PATCH replaces and `hashPlaneBody` compares),
	// re-check the idempotency signal, then write with `expectHash` of exactly what we read. Two
	// concurrent promoters can now both pass the alreadyPromoted check, but only the first PATCH
	// lands — the second gets a typed `conflict`, never a silent clobber. A human's mid-run manual
	// edit changes the hash and refuses the write the same way.
	const fresh = await fetchIssueDetail(repo, ref.id);
	if (fresh && alreadyPromoted(fresh)) {
		return { ok: false, error: "already-promoted", message: `${ref.identifier ?? ref.id} was promoted by someone else while this ran — not overwriting.` };
	}
	const liveHtml = await fetchIssueBodyHtml(repo, ref.id);
	if (liveHtml === undefined) {
		return { ok: false, error: "write-failed", message: "could not read the live issue body to hash-guard the write — refusing to write blind." };
	}

	const marker = `<!-- promoted:${hashPlaneBody(draft).slice(0, 12)}:${new Date().toISOString().slice(0, 10)} -->`;
	// The enrichment PREPENDS: the human's original description survives under its own heading at the
	// TAIL, so dispatch-time truncation (OMP_SQUAD_SPEC_MAX_CHARS cuts the tail) can only ever cut the
	// preserved original, never the validated Tier-2 sections (audit F5: promote must enrich, not
	// destroy).
	const original = liveHtml.trim() ? `\n<hr/>\n<h2>Original description</h2>\n${liveHtml}` : "";
	const write = await updatePlaneIssueBody(repo, ref.id, `${draft}${original}\n${marker}`, { expectHash: hashPlaneBody(liveHtml) });
	if (!write.ok) {
		if (write.error === "conflict") {
			return { ok: false, error: "already-promoted", message: `${ref.identifier ?? ref.id}'s body changed while this ran (another promoter or a human edit) — not overwriting.` };
		}
		return { ok: false, error: "write-failed", message: `Plane write failed: ${write.error}` };
	}

	return { ok: true, issue: ref.identifier ?? ref.id, message: `${ref.identifier ?? ref.id} promoted — stays in Backlog until a human drags it to Todo.` };
}
