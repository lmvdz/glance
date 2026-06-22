/**
 * Git supply-chain hardening for read-only git invocations.
 *
 * A repo's own config can hijack plain git to run arbitrary code
 * (core.fsmonitor, diff.external, hooks, a pager). When we only ever read an
 * untrusted clone, spread these args/env onto every `git` call to neutralize
 * those vectors and never prompt or page. Ported from recall's _GIT_HARDENING /
 * _GIT_ENV.
 */

export const GIT_HARDEN_ARGS: string[] = [
	"-c",
	"core.fsmonitor=",
	"-c",
	"diff.external=",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.pager=cat",
];

export const GIT_HARDEN_ENV: Record<string, string> = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_PAGER: "cat",
	PAGER: "cat",
};
