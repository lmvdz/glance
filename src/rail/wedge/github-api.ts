/**
 * Thin GitHub REST API request helper for the wedge (glance#337, rail T9) — mirrors the codebase's
 * existing per-call `fetch` convention (voice-token.ts's `verifyVoiceProviderKey`,
 * plane-throttle.ts's `throttledFetch`: `AbortSignal.timeout` + try/catch + explicit status check),
 * rather than introducing a new shared HTTP client abstraction the rest of the codebase doesn't use.
 *
 * Every response is decoded through an Effect `Schema` (see schemas.ts), never a bare parsed-and-cast
 * value — GitHub's API is an EXTERNAL trust boundary (the effect-migration ratchet's
 * `json-parse-as-cast` pattern names exactly this class of call site; deliberately not spelled out
 * verbatim here — the ratchet scan is line-regex based, so a doc comment quoting the idiom counts
 * against the baseline same as code, per err-text.ts's own note), and this mirrors
 * src/schema/external-json.ts's `decodeJsonWith` shape rather than re-deriving it.
 *
 * No retry: a wedge call either succeeds or the caller (post-check.ts / the CLI) reports the failure
 * honestly. GitHub's own rate limits are generous enough for one check-run per PR that retrying isn't
 * worth the complexity in a spike.
 */

import { Result, Schema } from "effect";
import { errText } from "../../err-text.ts";
import { formatDecodeIssue } from "../../schema/client-command.ts";

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const API_VERSION = "2022-11-28";

/** Thrown on any non-2xx GitHub response, a network failure, or a response that fails its schema
 *  decode. `status === 0` marks a network failure (DNS, timeout, connection refused) — no HTTP
 *  response was ever received. */
export class WedgeApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: string,
		message?: string,
	) {
		super(message ?? `GitHub API error ${status}: ${body.slice(0, 300)}`);
		this.name = "WedgeApiError";
	}
}

export interface GithubApiOptions {
	apiBase?: string;
	timeoutMs?: number;
	body?: unknown;
	accept?: string;
}

/** `token` is a bearer credential (App JWT or an installation access token) — callers must never log
 *  it; this function doesn't either. `schema` validates the decoded JSON body — a shape mismatch
 *  throws `WedgeApiError` the same as a non-2xx status, never silently returns a wrongly-typed value.
 *  Throws on any failure; never returns a partial/best-effort result, because a wedge caller
 *  (post-check.ts) needs to know definitively whether the check-run was actually posted. */
export async function githubApiRequest<A, I>(method: string, path: string, token: string, schema: Schema.Codec<A, I>, opts: GithubApiOptions = {}): Promise<A> {
	const base = opts.apiBase ?? DEFAULT_API_BASE;
	const url = path.startsWith("http") ? path : `${base}${path}`;
	let res: Response;
	try {
		res = await fetch(url, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				accept: opts.accept ?? "application/vnd.github+json",
				"x-github-api-version": API_VERSION,
				...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
			},
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
			signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
	} catch (err) {
		// Network error / timeout / abort — no response was ever received.
		throw new WedgeApiError(0, "", `GitHub API request failed (network): ${errText(err)}`);
	}
	const text = await res.text();
	if (!res.ok) throw new WedgeApiError(res.status, text);
	let raw: unknown;
	try {
		raw = text ? JSON.parse(text) : undefined;
	} catch (err) {
		throw new WedgeApiError(res.status, text, `GitHub API returned unparsable JSON: ${errText(err)}`);
	}
	const decoded = Schema.decodeUnknownResult(schema)(raw);
	if (Result.isFailure(decoded)) {
		throw new WedgeApiError(res.status, text, `GitHub API response for ${method} ${path} failed shape validation: ${formatDecodeIssue(decoded.failure)}`);
	}
	return decoded.success;
}
