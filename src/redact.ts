/**
 * Best-effort secret-shape redaction before anything is persisted or displayed.
 *
 * Pure-TS port of recall's redact.py: a conservative safety net so transcripts /
 * digests don't carry an API key, token, JWT, private key, or .env value into a
 * commit or a cold-start prompt. Patterns are applied in order, then a final
 * KEY=value env-line rule. Python inline flags map to JS flags: (?i)->i, (?m)->m,
 * (?s)->s (dotAll), backref \1 -> $1; every pattern is global so all hits go.
 *
 * ponytail: shape-based regex, not entropy detection — catches the common vendor
 * formats, not every conceivable secret. Add an entropy scan only if a leak slips.
 */

const R = "[REDACTED]";

// The bearer/authorization pattern is built from named fragments (rather than one regex literal)
// because the hardening it needs doesn't fit on one line: never cross a newline, require a REAL
// separator (never zero-width — that's what let `authorization/token/userinfo/jwks` in a doc
// comment match), and require the tail to actually look secret-shaped rather than just "12+ chars
// from a wide charset" (that's what let `req.headers.authorization;` and hyphenated English like
// `middleware-check`/`token-refresh` match).
// A folded header (`authorization:\n  <value>`) is allowed to cross exactly ONE newline, but ONLY
// when an explicit ":"/"=" separator is present — the bare-whitespace branch stays same-line, so
// `authorization\n  refreshSessionToken();` (no separator at all) still can't reach across the
// newline (RT2 false positive).
const AUTH_SEP = "(?:[^\\S\\n]*[:=][^\\S\\n]*(?:\\n[^\\S\\n]+)?|[^\\S\\n]+)"; // a real ":"/"=" (optionally spaced, optionally folded onto the next indented line) OR bare same-line whitespace — never zero-width
const AUTH_BEARER_SKIP = "(?:bearer[^\\S\\n]+)?"; // "Authorization: Bearer <token>" — hop over the scheme word so the tail lands on the value
// secret-shaped: `.` is included in the charset (needed for dotted vendor tokens like Google's
// `ya29.a0AfB...`), and the lookahead requires a digit ANYWHERE in the contiguous run of tail-shaped
// chars — not just the first 12 — so a digit past position 12 (`AbCdEfGhIjKlMnOpQrSt99887766`) still
// qualifies. Bare hyphenated/dotted prose with NO digit anywhere in the run (`req.headers.authorization`,
// `middleware-check`) still fails the lookahead and stays safe; the lookahead can't "reach across" a
// space or `[` to borrow a digit from unrelated trailing text (e.g. a `[0.16ms]` timing suffix) because
// those characters aren't in the charset, so the charset run simply ends before them.
const AUTH_TAIL = "(?:(?=[A-Za-z0-9._+/=-]*[0-9])[A-Za-z0-9._+/=-]{12,})";

const PATTERNS: [RegExp, string][] = [
	[/\bsk-[A-Za-z0-9_-]{16,}\b/g, R],
	[/\bAKIA[0-9A-Z]{16}\b/g, R],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, R],
	[/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, R],
	// JWTs run BEFORE the bearer pattern: a real "Authorization: Bearer eyJ....eyJ....sig" value gets
	// fully redacted here (dots and all) so the bearer pattern below never has to reason about dots.
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, R],
	[new RegExp(`\\b(authorization|bearer)\\b${AUTH_SEP}${AUTH_BEARER_SKIP}${AUTH_TAIL}`, "gi"), `$1 ${R}`],
	// Lazy span bounded to 20,000 chars — an UNBOUNDED lazy `.*?` between BEGIN/END markers is O(n²)
	// on input with many unmatched BEGIN markers (each failed END-scan walks the rest of the string);
	// a real private key block is nowhere near 20k chars, so this never clips a genuine match.
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]*PRIVATE KEY-----/g, R],
];

// No `i` flag on the key portion (deliberately `gm`, not `gim`) — a case-insensitive `[A-Z0-9_]`
// also matches lowercase in JS, which let a plain camelCase assignment like
// `voiceTokenTtlWarned = true;` match as a "TOKEN" env line and get its RHS destroyed. Instead the
// key portion is an explicit ALL-CAPS alternative (`[A-Z0-9_]*(?:SECRET|TOKEN|...)[A-Z0-9_]*`, for
// conventional SCREAMING_SNAKE_CASE shell/.env keys) OR an all-lowercase alternative
// (`[a-z0-9_]*(?:secret|token|...)[a-z0-9_]*`, for lowercase shell-style keys like `password=` or
// `api_key=`) — each alternative is internally single-case, so a MIXED-case identifier like
// `voiceTokenTtlWarned` or `Token=xyz` matches neither and passes through untouched. That mixed-case
// miss is a deliberate, accepted false-negative: excluding camelCase is what keeps ordinary JS
// identifiers safe, and a mixed-case shell key is not a convention either format actually uses.
// `(?!(?:""|'')[ \t]*$)` excludes an explicitly-empty init (`TOKEN=""`, common in generated shell
// shims before a value is ever assigned) — there's no secret in an empty string, and redacting it
// destroys the shim script's literal text for no safety gain.
const ENV_LINE =
	/^([ \t]*(?:export[ \t]+)?(?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*|[a-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)[a-z0-9_]*))[ \t]*=[ \t]*(?!(?:""|'')[ \t]*$).+$/gm;

export function redact(text: string): string {
	if (!text) return text;
	for (const [pattern, repl] of PATTERNS) text = text.replace(pattern, repl);
	return text.replace(ENV_LINE, `$1=${R}`);
}
