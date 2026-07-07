/**
 * Runtime validation for small EXTERNAL JSON payloads that historically used
 * `JSON.parse(...) as T` with no shape check — the three flagged real trust
 * boundaries from the json-parse-as-cast ratchet triage:
 *
 *   - a WorkOS JWT payload segment (src/workos.ts — was explicitly tracked as
 *     follow-up debt in scripts/effect-migration.ts),
 *   - `tailscale whois --json` output, i.e. another binary's stdout
 *     (src/federation.ts), and
 *   - the operator-provided PLANE_PROJECT_MAP env JSON (src/plane.ts).
 *
 * Unlike the wire envelopes (client-command.ts / federation-frame.ts) these are
 * single-consumer scalar shapes, so they share one module. Each caller keeps
 * its original failure behavior (null / undefined / `{}` fallback) — only the
 * silent `as`-cast is replaced by a real decode, so a wrong-shaped payload
 * (e.g. a numeric `LoginName` becoming an `Actor.id`) is now rejected instead
 * of flowing through mistyped.
 */
import { Result, Schema } from "effect";

/**
 * Parse `text` as JSON and decode it against `schema`. Returns the typed value,
 * or `null` on ANY failure (malformed JSON or wrong shape) — the shared
 * fail-soft contract all three call sites had for their `try/catch`.
 */
export function decodeJsonWith<A, I>(schema: Schema.Codec<A, I>, text: string): A | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	const r = Schema.decodeUnknownResult(schema)(raw);
	return Result.isSuccess(r) ? r.success : null;
}

/** A decoded JWT payload: any string-keyed claim set. Callers re-narrow individual
 *  claims (they always did — see `str()` in workos.ts); this only guarantees
 *  "a JSON object", rejecting arrays/scalars the old cast waved through. */
export const JwtClaimsSchema = Schema.Record(Schema.String, Schema.Unknown);

/** Shape of `tailscale whois --json <ip>` output we care about (excess keys stripped). */
export const TailscaleWhoisSchema = Schema.Struct({
	UserProfile: Schema.optional(
		Schema.Struct({
			LoginName: Schema.optional(Schema.String),
			DisplayName: Schema.optional(Schema.String),
		}),
	),
});

/** `PLANE_PROJECT_MAP`: `{ "<repo path or basename>": "<plane project id>" }`. */
export const PlaneProjectMapSchema = Schema.Record(Schema.String, Schema.String);
