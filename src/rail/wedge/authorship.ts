/**
 * The agent-authorship gate (glance#337, rail T9; design: R1's fallback chain,
 * plans/landing-rail/research/github-app-wedge.md "What identifies a PR as agent-authored").
 *
 * THIS IS AN ALLOWLIST, NOT A CLASSIFIER. There is no universal, spoof-proof signal that a PR was
 * authored by an agent rather than a human; R1's research pass found none. The chain below checks
 * three signals in order of reliability and stops at the first match:
 *
 *   1. bot login    — the PR author's GitHub login matches a configured bot-account allowlist
 *                      (e.g. `copilot-swe-agent[bot]`). Strongest signal WHEN it applies: GitHub
 *                      itself enforces the Copilot coding agent's login and its `copilot/` branch
 *                      prefix, so this one can't be spoofed by an arbitrary PR author. Other agents'
 *                      bot accounts are operator-asserted, not GitHub-enforced, and must be added to
 *                      the allowlist explicitly.
 *   2. branch prefix — the head branch starts with a configured prefix (`agent/`, `copilot/`,
 *                      `codex/`, …). Operator convention, not GitHub-enforced (except Copilot's own
 *                      prefix) — a human can name a branch `agent/whatever` and pass this check.
 *   3. commit trailer — a commit in the PR carries a configured trailer key (default
 *                      `co-authored-by`). The WEAKEST signal: purely advisory metadata a human can
 *                      add or omit freely, and the ecosystem has no consensus trailer convention.
 *
 * None of these signals is spoof-proof except (1) for GitHub-enforced bot accounts. The wedge's own
 * threat model (R1, open question notes) is single-operator/single-repo for v1: glance is meant to be
 * the only agent posting to the pilot repo's PRs, so the gate's job is triage (which PRs need a
 * receipt), not adversarial attribution. A future multi-agent/multi-repo iteration that needs to trust
 * this gate against an ADVERSARIAL author needs a stronger signal than any of the three above —
 * documented as an open question, not solved here.
 */

import type { PullRequestInfo } from "./pull-request.ts";

export interface AuthorshipConfig {
	/** Case-insensitive exact-match bot logins, e.g. "copilot-swe-agent[bot]". */
	botLogins: string[];
	/** Case-insensitive branch-name prefixes, e.g. "agent/", "copilot/", "codex/". */
	branchPrefixes: string[];
	/** Case-insensitive commit-trailer keys (without the trailing colon), e.g. "co-authored-by". The
	 *  trailer's VALUE is never inspected — its presence is the (weak) signal, per R1. */
	trailerKeys: string[];
}

export const DEFAULT_AUTHORSHIP_CONFIG: AuthorshipConfig = {
	botLogins: ["copilot-swe-agent[bot]"],
	branchPrefixes: ["agent/", "copilot/", "codex/"],
	trailerKeys: ["co-authored-by"],
};

export type AuthorshipSignal = "bot-login" | "branch-prefix" | "co-authored-by-trailer" | "none";

export interface AuthorshipVerdict {
	isAgentAuthored: boolean;
	signal: AuthorshipSignal;
	/** One-line human-readable justification — rendered into the "no receipt" check-run output so an
	 *  operator can see WHY a PR was gated. */
	detail: string;
}

export function classifyAgentAuthorship(pr: PullRequestInfo, config: AuthorshipConfig = DEFAULT_AUTHORSHIP_CONFIG): AuthorshipVerdict {
	const login = pr.authorLogin.toLowerCase();
	if (login && config.botLogins.some((b) => b.toLowerCase() === login)) {
		return { isAgentAuthored: true, signal: "bot-login", detail: `author login "${pr.authorLogin}" matches the bot-login allowlist` };
	}

	const headRefLower = pr.headRef.toLowerCase();
	const prefix = config.branchPrefixes.find((p) => headRefLower.startsWith(p.toLowerCase()));
	if (prefix) {
		return { isAgentAuthored: true, signal: "branch-prefix", detail: `head branch "${pr.headRef}" matches configured prefix "${prefix}"` };
	}

	const trailerKey = config.trailerKeys.find((key) => pr.commitTrailerLines.some((line) => line.toLowerCase().startsWith(`${key.toLowerCase()}:`)));
	if (trailerKey) {
		return { isAgentAuthored: true, signal: "co-authored-by-trailer", detail: `a commit carries a "${trailerKey}:" trailer` };
	}

	return { isAgentAuthored: false, signal: "none", detail: "no bot-login, branch-prefix, or commit-trailer signal matched — treated as human-authored" };
}
