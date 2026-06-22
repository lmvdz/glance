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

const PATTERNS: [RegExp, string][] = [
	[/\bsk-[A-Za-z0-9_-]{16,}\b/g, R],
	[/\bAKIA[0-9A-Z]{16}\b/g, R],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, R],
	[/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, R],
	[/\b(authorization|bearer)\b\s*[:=]?\s*[A-Za-z0-9._~+/-]{12,}=*/gi, `$1 ${R}`],
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, R],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/gs, R],
];

const ENV_LINE =
	/^([ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*)[ \t]*=[ \t]*.+$/gim;

export function redact(text: string): string {
	if (!text) return text;
	for (const [pattern, repl] of PATTERNS) text = text.replace(pattern, repl);
	return text.replace(ENV_LINE, `$1=${R}`);
}
