/**
 * Locks the door behind the lifecycle-write-path migration: every `.dto.status =` / `.dto.pending =`
 * assignment in squad-manager.ts must live inside transition()/setPending() or the one remaining
 * whitelisted DTO-literal construction site (restoreFlueMember — there is no prior state to transition
 * *from* at construction time).
 *
 * `attachExisting` was whitelisted here too until #lifecycle-truth finding 3: its `finally` block did a
 * raw `rec.dto.status = this.derive(rec)` immediately before calling transition(), which (a) made every
 * recorded "reattach" entry from===to by construction and (b) was itself a third raw-write site outside
 * the two guarded methods. Fixed to call `this.transition(rec, this.derive(rec), "reattach")` directly
 * and let transition() assign — attachExisting no longer needs an exemption.
 *
 * A CI grep is bypassable ((rec.dto as any).status =, destructured aliases) and the local `rtk` hook
 * mangles bash grep output, so enforcement is a `bun test` that parses the source file directly and
 * survives line drift.
 */

import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

const ALLOWED_METHODS = new Set(["transition", "setPending", "restoreFlueMember"]);

/** Method-declaration lines in this file are exactly one tab deep (`\tprivate foo(...): T {`), and
 *  nested code inside a method body is indented two-plus tabs — so a line matching this pattern is
 *  never mistaken for a nested arrow function/callback declared inside some other method. */
const METHOD_DECL_RE = /^\t(?:private |protected |public )?(?:static )?(?:async )?([A-Za-z_$][\w$]*)\s*\(/;
const RAW_WRITE_RE = /\.dto\.(status|pending)\s*=\s*[^=]/;
const CLASS_START_RE = /^export class SquadManager\b/;

function findRawLifecycleWrites(src: string): string[] {
	const lines = src.split("\n");
	const offenders: string[] = [];
	let inClass = false;
	let currentMethod: string | undefined;
	let methodDepth = 0; // brace depth since currentMethod's own declaration line; 0 ⇒ not inside a tracked method

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!inClass) {
			if (CLASS_START_RE.test(line)) inClass = true;
			continue;
		}
		const trimmed = line.trim();
		const isCommentLine = trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/**");
		if (methodDepth === 0 && !isCommentLine) {
			const m = METHOD_DECL_RE.exec(line);
			if (m) currentMethod = m[1];
		}
		if (!isCommentLine && RAW_WRITE_RE.test(line)) {
			const enclosing = currentMethod ?? "<top-level>";
			if (!ALLOWED_METHODS.has(enclosing)) offenders.push(`squad-manager.ts:${i + 1} (in ${enclosing}): ${line.trim()}`);
		}
		if (currentMethod) {
			const opens = (line.match(/{/g) ?? []).length;
			const closes = (line.match(/}/g) ?? []).length;
			methodDepth += opens - closes;
			if (methodDepth <= 0) {
				methodDepth = 0;
				currentMethod = undefined;
			}
		}
	}
	return offenders;
}

test("no raw AgentStatus/pending writes outside transition()/setPending()", () => {
	const src = readFileSync(new URL("../src/squad-manager.ts", import.meta.url), "utf8");
	const offenders = findRawLifecycleWrites(src);
	expect(offenders).toEqual([]);
});

test("the parser itself finds the whitelisted raw writes (sanity: it isn't just vacuously passing)", () => {
	const src = readFileSync(new URL("../src/squad-manager.ts", import.meta.url), "utf8");
	const lines = src.split("\n");
	const rawWriteLineCount = lines.filter((l) => RAW_WRITE_RE.test(l)).length;
	// If this ever hits 0, the regex itself has gone stale (e.g. formatting changed) and the enforcement
	// test above would pass for the wrong reason — fail loudly instead of silently trusting an empty list.
	expect(rawWriteLineCount).toBeGreaterThan(0);
});
