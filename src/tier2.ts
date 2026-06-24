/**
 * Parse a Plane issue body into the sections the planner UI shows.
 *
 * Promote-issue (skill://promote-issue) writes the body as `description_html` with `<h2>`/`<h3>`
 * headings — "Tier-2 implementation context" → "Acceptance test" / "Verification gate" / "Scope".
 * This is a PURE, tolerant parser: a body missing a section yields "" for it, never throws. It
 * handles the HTML shape and falls back to markdown-heading splitting for plain/markdown bodies.
 *
 * ponytail: regex section-splitter, not a DOM parser — the body is our own tightly-structured
 * promote-issue output, not arbitrary HTML. Upgrade path: a real HTML parser if bodies ever get
 * nested headings inside sections.
 */

export interface Tier2 {
	/** Triage description — content before the first Tier heading (or the whole body if none). */
	description: string;
	/** "Acceptance test" section. */
	acceptanceCriteria: string;
	/** "Verification gate" section. */
	verification: string;
	/** "Scope" / boundary section. */
	scope: string;
}

/** Decode the handful of entities promote-issue emits and flatten block tags to newlines. */
function htmlToText(html: string): string {
	return html
		.replace(/<\s*br\s*\/?>/gi, "\n")
		.replace(/<\s*li[^>]*>/gi, "- ")
		.replace(/<\/\s*(p|div|h[1-6]|li|tr|pre|ul|ol)\s*>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

interface Section {
	heading: string;
	body: string;
}

function splitHtml(html: string): { lead: string; sections: Section[] } {
	const re = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
	const marks: { start: number; end: number; heading: string }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) marks.push({ start: m.index, end: re.lastIndex, heading: htmlToText(m[1]) });
	const lead = marks.length ? html.slice(0, marks[0].start) : html;
	const sections = marks.map((mk, i) => ({
		heading: mk.heading,
		body: html.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : html.length),
	}));
	return { lead, sections };
}

function splitMarkdown(text: string): { lead: string; sections: Section[] } {
	const sections: Section[] = [];
	const leadLines: string[] = [];
	let cur: Section | null = null;
	let curLines: string[] = [];
	const flush = (): void => {
		if (cur) {
			cur.body = curLines.join("\n").trim();
			sections.push(cur);
			curLines = [];
		}
	};
	for (const line of text.split("\n")) {
		const h = /^#{2,6}\s+(.*)$/.exec(line);
		if (h) {
			flush();
			cur = { heading: h[1].trim(), body: "" };
		} else if (cur) curLines.push(line);
		else leadLines.push(line);
	}
	flush();
	return { lead: leadLines.join("\n").trim(), sections };
}

export function parseTier2(body: string): Tier2 {
	const out: Tier2 = { description: "", acceptanceCriteria: "", verification: "", scope: "" };
	if (!body || !body.trim()) return out;
	const isHtml = /<h[1-6][^>]*>|<\/p>|<p[^>]*>/i.test(body);
	const { lead, sections } = isHtml ? splitHtml(body) : splitMarkdown(body);
	out.description = isHtml ? htmlToText(lead) : lead.trim();
	// Scope to the Tier-2 block when present: a promoted body has reviewer-facing Tier-1 headings
	// (which can echo "Acceptance test" narratively) before the real Tier-2 schema. After the
	// "Tier-2 implementation context" heading, only the real sections remain. Non-promoted bodies
	// (markdown, plain) have no such marker → scan every section.
	const t2 = sections.findIndex((s) => /tier.?2|implementation context/i.test(s.heading));
	const scoped = t2 >= 0 ? sections.slice(t2 + 1) : sections;
	for (const s of scoped) {
		const h = s.heading.toLowerCase();
		const text = isHtml ? htmlToText(s.body) : s.body.trim();
		if (!text) continue;
		// First match wins so the reviewer-facing Tier-1 narrative can't clobber a real Tier-2 section.
		if (/accept/.test(h) && !out.acceptanceCriteria) out.acceptanceCriteria = text;
		else if (/verif|gate/.test(h) && !out.verification) out.verification = text;
		else if (/scope|boundary/.test(h) && !out.scope) out.scope = text;
	}
	return out;
}
