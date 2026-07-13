/**
 * The report deliverable (R5): *"half of engineering is read/judge/decide work, and glance has no
 * primitive for it."*
 *
 * A unit could only ever produce a BRANCH. So every audit, every "why is this slow", every "does this
 * design hold" had to be run as an in-harness subagent — outside the fleet, outside the roster, outside
 * every receipt and transcript and cost ledger glance keeps. The fleet could build things it could not
 * think about.
 *
 * An answer is durable, addressable, and cannot mutate the repo. These tests drive the real
 * `captureAnswer` seam the frame loop calls at `agent_end` — not a parallel reimplementation of it.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { answerBrief, listAnswers, readAnswer, saveAnswer } from "../src/answers.ts";
import { isLandingUnit } from "../src/is-landing-unit.ts";
import type { AgentDTO, PersistedAgent, TranscriptEntry } from "../src/types.ts";

const { SquadManager } = await import("../src/squad-manager.ts");

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), "answers-"));
	dirs.push(d);
	return d;
}

/** Exposes the protected capture seam the `agent_end` frame handler calls. */
class AnswerManager extends SquadManager {
	capture(rec: unknown): Promise<void> {
		return this.captureAnswer(rec as never);
	}
}

function record(opts: { id: string; ask?: string; transcript: TranscriptEntry[] }): {
	dto: Partial<AgentDTO>;
	options: Partial<PersistedAgent>;
	transcript: TranscriptEntry[];
} {
	return {
		dto: { id: opts.id, name: opts.id, repo: "/srv/app", model: "sonnet", harness: "omp" },
		options: { ask: opts.ask },
		transcript: opts.transcript,
	};
}

const say = (kind: TranscriptEntry["kind"], text: string): TranscriptEntry => ({ kind, text, ts: 1 }) as TranscriptEntry;

// ── the artifact ────────────────────────────────────────────────────────────────────────────────

test("a durable answer round-trips, and is listed newest-first", async () => {
	const dir = await tmpDir();
	await saveAnswer(dir, { id: "a1", question: "why is dispatch slow?", repo: "/srv/app", markdown: "Because the spawn loop is serial.", askedAt: 100, answeredAt: 200 });
	await saveAnswer(dir, { id: "a2", question: "is the gate real?", repo: "/srv/app", markdown: "Yes.", askedAt: 300, answeredAt: 400 });

	expect((await readAnswer(dir, "a1"))?.markdown).toBe("Because the spawn loop is serial.");
	expect((await listAnswers(dir)).map((a) => a.id)).toEqual(["a2", "a1"]);
	expect((await listAnswers(dir, { repo: "/other" })).length).toBe(0);
});

test("a missing or corrupt answer reads as absent — never a crashed daemon", async () => {
	const dir = await tmpDir();
	expect(await readAnswer(dir, "nope")).toBeUndefined();

	await fs.mkdir(path.join(dir, "answers"), { recursive: true });
	await fs.writeFile(path.join(dir, "answers", "bad.json"), "{ not json");
	expect(await readAnswer(dir, "bad")).toBeUndefined();
	expect(await listAnswers(dir)).toEqual([]); // the corrupt one is skipped, not fatal
});

/** Ids come from agent ids, and an id reaching a `path.join` is a traversal waiting to happen.
 *  Proven through the public surface: a hostile id is written INSIDE the answers dir under a
 *  defanged name, and reads back through the same raw id. */
test("an id cannot escape the answers directory", async () => {
	const dir = await tmpDir();
	const evil = "../../etc/passwd";
	expect(await saveAnswer(dir, { id: evil, question: "q", repo: "/r", markdown: "m", askedAt: 1 })).toBe(true);
	expect(await fs.readdir(path.join(dir, "answers"))).toEqual([".._.._etc_passwd.json"]);
	expect((await readAnswer(dir, evil))?.markdown).toBe("m"); // round-trips via the raw id
	// a real agent id survives untouched
	expect(await saveAnswer(dir, { id: "ompsq-445-mre9s8ze-1-158946d8", question: "q", repo: "/r", markdown: "m", askedAt: 1 })).toBe(true);
	expect((await readAnswer(dir, "ompsq-445-mre9s8ze-1-158946d8"))?.markdown).toBe("m");
});

// ── capture: the unit's final message IS the deliverable ────────────────────────────────────────

test("the final assistant message is captured verbatim as the answer", async () => {
	const dir = await tmpDir();
	const mgr = new AnswerManager({ stateDir: dir } as never);
	await mgr.capture(
		record({
			id: "u1",
			ask: "why is dispatch slow?",
			transcript: [say("user", "..."), say("assistant", "first pass, still looking"), say("tool", "▸ grep"), say("assistant", "  Because the spawn loop is serial.  ")],
		}),
	);

	const a = await readAnswer(dir, "u1");
	expect(a?.markdown).toBe("Because the spawn loop is serial."); // the LAST assistant message, trimmed
	expect(a?.question).toBe("why is dispatch slow?");
	expect(a?.answeredAt).toBeGreaterThan(0);
	expect(a?.model).toBe("sonnet");
});

/** Re-answering overwrites: an operator who asks again wants the new answer, not two. */
test("a later turn replaces the answer, and keeps the original askedAt", async () => {
	const dir = await tmpDir();
	const mgr = new AnswerManager({ stateDir: dir } as never);
	await saveAnswer(dir, { id: "u1", question: "q", repo: "/srv/app", markdown: "", askedAt: 42 });

	await mgr.capture(record({ id: "u1", ask: "q", transcript: [say("assistant", "first answer")] }));
	await mgr.capture(record({ id: "u1", ask: "q", transcript: [say("assistant", "corrected answer")] }));

	const a = await readAnswer(dir, "u1");
	expect(a?.markdown).toBe("corrected answer");
	expect(a?.askedAt).toBe(42); // duration is measured from the QUESTION, not the last turn
	expect((await listAnswers(dir)).length).toBe(1);
});

test("a unit that was never asked anything writes no answer", async () => {
	const dir = await tmpDir();
	const mgr = new AnswerManager({ stateDir: dir } as never);
	await mgr.capture(record({ id: "builder", transcript: [say("assistant", "I refactored the thing")] }));
	expect(await readAnswer(dir, "builder")).toBeUndefined();
});

/** A unit that dies mid-thought has nothing to say. Persisting an empty answer would be worse than
 *  persisting none: `glance ask` waits on `answeredAt`, and an empty one reads as "done, and useless". */
test("an answer unit that ends with no message saves nothing", async () => {
	const dir = await tmpDir();
	const mgr = new AnswerManager({ stateDir: dir } as never);
	await mgr.capture(record({ id: "u1", ask: "q", transcript: [say("tool", "▸ grep"), say("assistant", "   ")] }));
	expect(await readAnswer(dir, "u1")).toBeUndefined();
});

/** Capture runs inside the frame ingest loop. A disk fault there must never take the loop down. */
test("a disk failure is logged, never thrown into the frame loop", async () => {
	const mgr = new AnswerManager({ stateDir: "/proc/definitely-not-writable" } as never);
	await mgr.capture(record({ id: "u1", ask: "q", transcript: [say("assistant", "an answer")] })); // must not reject
});

// ── it can never land ───────────────────────────────────────────────────────────────────────────

/**
 * I nearly shipped this feature on a safety claim that was FALSE.
 *
 * `is-landing-unit.ts` reads exactly like the rule I wanted — "an observer never commits" — and I cited it
 * as the guarantee. It is a metrics DENOMINATOR: it exists so a unit that never lands by design is not
 * counted as a failed land. **No land path ever consulted it.** Meanwhile an answer unit runs with
 * `--approval yolo` in a worktree whose origin is the operator's real repository. Nothing but a sentence
 * in a prompt stood between an answer and a merge.
 *
 * The refusal now lives in `land()`, the one door every land goes through — the operator UI, the
 * orchestrator's auto-land, and `autoLandWorkflow` alike. `--force` does not open it: refusing to land a
 * unit that was never supposed to produce a commit is not a valve an operator should talk their way past.
 */
test("land() refuses an observer, and refuses an answer unit, even with --force", async () => {
	const dir = await tmpDir();

	class LandManager extends SquadManager {
		seed(rec: unknown): void {
			(this as unknown as { agents: Map<string, unknown> }).agents.set("u1", rec);
		}
	}
	const mgr = new LandManager({ stateDir: dir } as never);

	const observer = { dto: { id: "u1", name: "ask-1", repo: "/srv/app", branch: "squad/ask-1" }, options: { executionRole: "observer" } };
	mgr.seed(observer);
	const auto = await mgr.land("u1");
	expect(auto.ok).toBe(false);
	expect(auto.merged).toBe(false);
	expect(auto.committed).toBe(false);
	expect(auto.detail).toContain("report, not a branch");

	const forced = await mgr.land("u1", "ship it", { force: true, reason: "I really mean it" });
	expect(forced.ok).toBe(false); // force is not a key to this door
});

/** And a unit carrying a question is refused even if its role was somehow lost — belt and braces, because
 *  the cost of being wrong here is a merge nobody asked for. */
test("a unit with a question never lands, whatever its role says", async () => {
	const dir = await tmpDir();
	class LandManager extends SquadManager {
		seed(rec: unknown): void {
			(this as unknown as { agents: Map<string, unknown> }).agents.set("u1", rec);
		}
	}
	const mgr = new LandManager({ stateDir: dir } as never);
	mgr.seed({ dto: { id: "u1", name: "ask-1", repo: "/srv/app", branch: "squad/ask-1" }, options: { ask: "why?" } });
	expect((await mgr.land("u1")).ok).toBe(false);
});

/** The metrics helper still says what it always said — it is just not, and never was, the gate. */
test("isLandingUnit excludes an observer from the land-rate denominator", () => {
	expect(isLandingUnit({ executionRole: "observer", branch: "squad/ask-1" } as never)).toBe(false);
	expect(isLandingUnit({ branch: "squad/build-1" } as never)).toBe(true);
});

// ── the brief ───────────────────────────────────────────────────────────────────────────────────

/** An observer that "helpfully" edits a file has produced nothing — its worktree is discarded. It must
 *  be told, or it will spend the run writing code no one will ever see. */
test("the brief tells the unit its edits are discarded and its last message is the product", () => {
	const brief = answerBrief("why is dispatch slow?");
	expect(brief).toContain("Do NOT edit");
	expect(brief).toContain("discarded");
	expect(brief).toContain("FINAL MESSAGE");
	expect(brief).toContain("why is dispatch slow?");
});

// ── the wiring, not a reimplementation of it ────────────────────────────────────────────────────

/**
 * The unit tests above drive `captureAnswer` directly. This one pushes a real `agent_end` frame through
 * the real frame handler, because "the function works" and "the function is called" are different claims
 * — and this project has shipped the first while believing the second more than once (`primer-empty` had
 * zero records because the metric lived inside the branch it measured).
 */
test("an agent_end frame actually triggers the capture", async () => {
	const dir = await tmpDir();

	class WiringManager extends SquadManager {
		captured: string[] = [];
		protected override async captureAnswer(rec: { dto: { id: string } }): Promise<void> {
			this.captured.push(rec.dto.id);
		}
		fire(rec: unknown): void {
			this.onAgentEvent(rec as never, { type: "agent_end" });
		}
	}

	const mgr = new WiringManager({ stateDir: dir } as never);
	const base = record({ id: "u1", ask: "q", transcript: [say("assistant", "the answer")] });
	const rec = {
		...base,
		dto: { ...base.dto, pending: [], status: "working", attentionEvents: [] },
		streaming: true,
		assistantBuf: "",
		thinkingBuf: "",
		subs: { snapshot: () => undefined },
		toolEntries: new Map(),
		run: undefined,
	};
	mgr.fire(rec);

	expect(mgr.captured).toEqual(["u1"]);
});

/**
 * The safety property, pinned at the source. `is-landing-unit.ts` refuses to land an observer — but only
 * if `ask()` actually marks the unit as one. Nothing else in this feature prevents an answer unit from
 * opening a PR against the operator's repo.
 */
test("ask() spawns an OBSERVER, never routed, never tracked", async () => {
	const dir = await tmpDir();
	let seen: Record<string, unknown> | undefined;

	class SpyManager extends SquadManager {
		override async create(opts: Record<string, unknown>): Promise<AgentDTO> {
			seen = opts;
			return { id: "u1", name: "u1", repo: String(opts.repo), model: "sonnet", harness: "omp" } as AgentDTO;
		}
	}

	const mgr = new SpyManager({ stateDir: dir } as never);
	await mgr.ask({ repo: "/srv/app", question: "why is dispatch slow?" });

	expect(seen?.executionRole).toBe("observer"); // cannot commit, cannot land
	expect(seen?.autoRoute).toBe(false); // the router builds workflows; this is not a build
	expect(seen?.track).toBe(false); // an answer is not backlog work
	expect(seen?.ask).toBe("why is dispatch slow?"); // persisted, so a restart still owes an answer
	expect(String(seen?.task)).toContain("Do NOT edit");

	// The question is recorded before the unit says anything, so `glance answers` shows it as pending.
	const pending = await readAnswer(dir, "u1");
	expect(pending?.question).toBe("why is dispatch slow?");
	expect(pending?.answeredAt).toBeUndefined();
});

test("an empty question is refused", async () => {
	const mgr = new AnswerManager({ stateDir: await tmpDir() } as never);
	await expect(mgr.ask({ repo: "/srv/app", question: "   " })).rejects.toThrow("a question is required");
});

/**
 * Closing the door I found is not closing the doors. `land()` is one of five places the daemon can turn a
 * unit's worktree into a commit or a PR — the others are the pre-verify WIP sweep, the land-ready flag the
 * UI's Land button keys off, the draft-PR float, and the "has unlanded work" predicate that invites the
 * orchestrator to verify-and-land in the first place. (grok-4.5: "the author fixed the discovery path they
 * hit, not the adjacent doors.")
 */
test("every daemon-side door to a commit refuses an answer unit", async () => {
	const dir = await tmpDir();

	class DoorManager extends SquadManager {
		seed(rec: unknown): void {
			(this as unknown as { agents: Map<string, unknown> }).agents.set("u1", rec);
		}
		landReady(): unknown {
			(this as unknown as { markLandReady(id: string): void }).markLandReady("u1");
			return (this as unknown as { agents: Map<string, { dto: { landReady?: boolean } }> }).agents.get("u1")?.dto.landReady;
		}
		hasWork(): Promise<boolean> {
			return this.agentHasUnlandedWork("u1");
		}
	}

	const mgr = new DoorManager({ stateDir: dir } as never);
	mgr.seed({ dto: { id: "u1", name: "ask-1", repo: "/srv/app", worktree: "/wt/ask-1", branch: "squad/ask-1" }, options: { executionRole: "observer", ask: "why?" } });

	expect(await mgr.commitAgentWip("u1")).toBe(false); // the pre-verify sweep does not commit it
	expect(mgr.landReady()).toBeUndefined(); // never flagged ready — the Land button has nothing to press
	expect(await mgr.hasWork()).toBe(false); // the orchestrator is never invited to verify-and-land it
	expect((await mgr.land("u1")).ok).toBe(false); // and the door itself stays shut
});
