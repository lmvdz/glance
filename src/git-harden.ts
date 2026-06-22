/**
 * Git invocation hardening — shared `-c` args + env overlaid on every squad git
 * call so plumbing behaves deterministically regardless of the operator's global
 * config: never GPG-sign (would block/fail on a box with commit.gpgsign=true),
 * never fire repo hooks on our own plumbing, never block on an interactive prompt.
 *
 * Extracted because land.ts, proof.ts, and worktree.ts each spawn git and must
 * agree on this; previously only land.ts forced `commit.gpgsign=false` inline.
 */

/** `-c` overrides prepended to every `git` invocation: `git ...GIT_HARDEN_ARGS <cmd>`. */
export const GIT_HARDEN_ARGS: readonly string[] = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

/** Environment overlaid on every `git` invocation. */
export const GIT_HARDEN_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
