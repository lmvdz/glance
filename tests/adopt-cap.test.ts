/**
 * Re-adoption cap (src/squad-manager.ts `selectAdoptable`). On restart the daemon must NOT re-spawn
 * every orphaned worktree at once — that simultaneous burst of omp hosts OOM'd the box. It resumes only
 * agents with unlanded work, capped at the agent ceiling; done/clean ones are dropped.
 */

import { expect, test } from "bun:test";
import { selectAdoptable } from "../src/squad-manager.ts";

const ag = (id: string) => ({ id });
const withWork: Record<string, true> = { a: true, c: true, d: true, e: true }; // b is done/clean
const hasWork = (a: { id: string }) => withWork[a.id] === true;

test("resumes only agents with unlanded work", () => {
	const out = selectAdoptable([ag("a"), ag("b"), ag("c")], hasWork, 10);
	expect(out.map((a) => a.id)).toEqual(["a", "c"]); // b (no work) dropped
});

test("caps the number re-adopted at `cap` (the OOM guard)", () => {
	const out = selectAdoptable([ag("a"), ag("c"), ag("d"), ag("e")], hasWork, 2);
	expect(out.map((a) => a.id)).toEqual(["a", "c"]); // 4 with work, but only 2 fit
});

test("cap<=0 adopts nothing (no headroom under the ceiling)", () => {
	expect(selectAdoptable([ag("a"), ag("c")], hasWork, 0)).toEqual([]);
	expect(selectAdoptable([ag("a")], hasWork, -3)).toEqual([]);
});

test("all-done set adopts nothing regardless of cap", () => {
	expect(selectAdoptable([ag("b"), ag("z")], hasWork, 5)).toEqual([]);
});
