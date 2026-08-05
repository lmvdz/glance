/**
 * Runtime validation for the wedge's GitHub REST API responses (glance#337, rail T9) — every one of
 * these is an EXTERNAL trust boundary (GitHub's own API, not our own freshly-written state), exactly
 * the class of parsed-and-cast read the effect-migration ratchet (scripts/effect-migration.ts,
 * pattern `json-parse-as-cast`) wants replaced with a real Schema decode rather than a silent cast
 * (not spelled out verbatim here; the ratchet scan is line-regex based — see err-text.ts's note).
 * Mirrors src/schema/external-json.ts / federation-frame.ts's approach and reuses
 * `formatDecodeIssue` from src/schema/client-command.ts for the bounded, single-line error text.
 *
 * Deliberately narrow: only the fields the wedge actually reads are modeled; everything else on
 * GitHub's response is ignored (Schema.Struct is NOT exact — excess keys pass through unremarked).
 */
import { Schema } from "effect";

export const InstallationTokenResponseSchema = Schema.Struct({
	token: Schema.String,
	expires_at: Schema.String,
});

export const PullResponseSchema = Schema.Struct({
	number: Schema.Number,
	user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
	head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
	base: Schema.Struct({ ref: Schema.String }),
});

export const CommitListResponseSchema = Schema.Array(
	Schema.Struct({
		commit: Schema.Struct({ message: Schema.String }),
	}),
);

export const CheckRunListResponseSchema = Schema.Struct({
	check_runs: Schema.Array(
		Schema.Struct({
			id: Schema.Number,
			name: Schema.String,
			app: Schema.NullOr(Schema.Struct({ id: Schema.Number })),
		}),
	),
});

export const CheckRunResponseSchema = Schema.Struct({
	id: Schema.Number,
	html_url: Schema.String,
});
