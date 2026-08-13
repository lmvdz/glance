/**
 * The boundary-sync lane — turn-boundary wiring, per-checkout serialization, and the attention
 * surface for `here`-class casual sessions (daily-onramp 03) — extracted from SquadManager
 * (concern 18 of plans/deepen-modules, round-2 rank 1). The decision core stays in
 * boundary-sync.ts; this lane is everything the manager used to wire around it: one-directional
 * per-turn patch-apply into the operator's real checkout (`options.realTreePath` is the marker —
 * plain fleet units never carry it). Fail-closed throughout: every branch that is not
 * "fingerprints provably match" ends in hold + attention, never an apply.
 *
 * The manager is visible only through the five-closure deps port (log, agent-by-id, emit,
 * recordAudit, friction) plus the structural `BoundarySyncSession` slice of AgentRecord — no
 * AgentRecord, roster map, or event bus ever crosses the seam. Every fail-closed incident
 * annotation (N2/N3/N4/M1/C1/S5/S6, concern 02's exactly-once friction accounting) moved
 * VERBATIM with its code — they are load-bearing.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { applyHeldNow, beginTurn, type BoundaryTurnStart, captureWorktreeTree, discardHeldNow, type HeldSync, HeldSyncStore, pruneDivergenceCaptures, syncTurnEnd } from "./boundary-sync.ts";
import { errText } from "./err-text.ts";
import type { Actor, AgentDTO } from "./types.ts";

/** The per-session slice the lane reads/writes — kept structural so AgentRecord stays inside the
 *  manager. The three `boundarySync*` fields live on the record (they are per-session turn state
 *  and must die with it), documented at their AgentRecord declarations. */
export interface BoundarySyncSession {
	dto: AgentDTO;
	options: { worktree: string; realTreePath?: string };
	boundarySyncTurn?: number;
	boundarySyncStart?: BoundaryTurnStart;
	boundarySyncEndTree?: string;
}

export interface BoundarySyncLaneDeps {
	log(level: "info" | "warn", msg: string): void;
	/** Roster lookup for the by-id affordances (apply/discard/ack). */
	agent(id: string): BoundarySyncSession | undefined;
	/** DTO changed (attention rows) — broadcast it. */
	emit(rec: BoundarySyncSession): void;
	recordAudit(actor: Actor, action: string, target: string | null, outcome: "ok" | "error", detail?: string): Promise<void>;
	/** Auto-friction origin events, context fixed to "auto:boundary-sync-held" by the manager's
	 *  adapter (the funnel and its fail-open contract stay manager-side — shared with ACP-timeout
	 *  and session-loss captures). */
	friction(agentId: string | undefined, repo: string, gripe: string): void;
}

export class BoundarySyncLane {
	/** Durable held-patch ledger for turn patches that could not be safely auto-applied. */
	private readonly held: HeldSyncStore;
	/** Serialization chains, keyed by realpath(realDir) — lane-global, NOT per agent record:
	 *  `realTreePath` is shared state (nothing stops two `here` sessions on one repo), and
	 *  per-record chains let both pass their fingerprint checks and run `git apply` into the same
	 *  checkout concurrently — same-file writes interleaving at machine speed, past git's context
	 *  check (both check, then both write). Keying by the real directory makes every capture and
	 *  apply targeting one checkout strictly sequential across sessions. Entries are removed when
	 *  their chain drains (see queue), so the map never grows past live checkouts. */
	private readonly chains = new Map<string, Promise<void>>();

	constructor(
		root: string,
		private readonly deps: BoundarySyncLaneDeps,
	) {
		this.held = new HeldSyncStore(root);
	}

	/** The held-patch store root — used in operator-facing messages and by tests. */
	get root(): string {
		return this.held.root;
	}

	/** Serialize boundary-sync work (turn-start capture → turn-end sync → explicit apply/discard)
	 *  PER REAL DIRECTORY, so an apply can never interleave with a capture — including across two
	 *  `here` sessions that target the same checkout (see `chains`). The key is the realpath of
	 *  the real directory (symlinked and literal paths to one checkout must share a chain); a
	 *  vanished directory falls back to the resolved literal path — captures against it fail
	 *  closed anyway. The returned promise carries `fn`'s own failure to callers that await it;
	 *  the stored chain swallows it (logged) so one failure never wedges the lane. */
	private queue(rec: BoundarySyncSession, realDir: string, fn: () => Promise<void>): Promise<void> {
		// Chain under BOTH the realpath and the literal resolved path when they differ (and under
		// the literal path alone when realpath fails, e.g. the directory is briefly gone — captures
		// against it fail closed anyway). Linking both closes the alias gap: an op queued by literal
		// path during a realpath outage still serializes with later realpath-keyed ops through the
		// shared literal key, so one checkout never runs two chains.
		const resolved = path.resolve(realDir);
		let keys: string[];
		try {
			const real = realpathSync(resolved);
			keys = real === resolved ? [resolved] : [real, resolved];
		} catch {
			keys = [resolved];
		}
		const priors = keys.map((k) => this.chains.get(k)).filter((p): p is Promise<void> => p !== undefined);
		const run = Promise.all(priors).then(fn);
		const stored = run.catch((err) => {
			this.deps.log("warn", `boundary-sync (${rec.dto.name}): ${errText(err)}`);
		});
		for (const key of keys) this.chains.set(key, stored);
		void stored.finally(() => {
			// Drop the drained chain iff nothing queued behind it — keeps the map bounded by live
			// checkouts without ever detaching a chain something else is already linked onto.
			for (const key of keys) if (this.chains.get(key) === stored) this.chains.delete(key);
		});
		return run;
	}

	/** The sync target, iff this record is a `here`-class session AND the target is not the agent's
	 *  own worktree. The self-apply guard is defensive (OMPSQ-40 means a here-session always gets a
	 *  standard worktree today): if the two ever alias, "apply the turn's patch to the real tree"
	 *  would re-apply changes onto the tree that already contains them — `git apply --check` would
	 *  refuse and every turn would raise a spurious hold. Skipping is the honest no-op: the "real
	 *  tree" already sees every edit directly. */
	private target(rec: BoundarySyncSession): string | undefined {
		const realDir = rec.options.realTreePath;
		if (!realDir) return undefined;
		if (rec.options.worktree && path.resolve(realDir) === path.resolve(rec.options.worktree)) return undefined;
		return realDir;
	}

	/** N4: the real-dir to use for the EXPLICIT Apply/Discard affordances specifically — unlike
	 *  `target` (turn start/end wiring, which must stay live-session-only), these two affordances
	 *  must keep working for a session's PRE-EXISTING holds even after `promote()` clears
	 *  `options.realTreePath` (S5 — a promoted unit is a fleet unit by contract, so future turns
	 *  correctly stop auto-syncing). The commit that shipped S5 claimed existing holds "remain
	 *  Apply-able" because they carry their own `realDir` straight off the ledger — true of the
	 *  ledger record, but `applyHeld`/`discardHeld` never actually READ it: they gated on
	 *  `target(rec)`, which returns `undefined` post-promote regardless of what's held, so the
	 *  claim was false in practice (every call errored "no boundary sync"). Falling back to the
	 *  first held patch's own `realDir` when the live option is gone makes the claim true without
	 *  touching the live-session wiring at all. */
	private async resolveDir(rec: BoundarySyncSession): Promise<string | undefined> {
		const live = this.target(rec);
		if (live) return live;
		const held = await this.held.listHeld(rec.dto.id).catch(() => []);
		return held[0]?.realDir;
	}

	/** agent_start/turn_start: capture the turn's baselines. Failures are recorded on the record
	 *  (NOT defaulted) so turn end holds with the precise reason — a failed capture can never
	 *  compare equal to anything. */
	turnStart(rec: BoundarySyncSession): void {
		const realDir = this.target(rec);
		if (!realDir) return;
		// First turn only (later turns reuse the prior end tree): start the WORKTREE snapshot NOW,
		// off-chain — the queue below can be parked behind another session's replay on this same
		// checkout, and a baseline captured only when the chain drains would already contain the
		// agent's first edits, silently excluding them from the turn patch (a lost update, not a
		// hold). The worktree is this session's own; only real-tree reads/writes need the chain.
		const earlyTree = rec.boundarySyncEndTree === undefined ? captureWorktreeTree(rec.options.worktree).catch((err) => ({ ok: false as const, reason: errText(err) })) : undefined;
		void this.queue(rec, realDir, async () => {
			// M1: stamped INSIDE the per-checkout chain, not before it. A synchronous increment here
			// (outside the chain) would race the NEXT turn's own start against THIS turn's still-queued
			// end-sync closure — the chain serializes per REAL DIRECTORY, not per call, so a fast next
			// turn's synchronous bump could land before a backlogged end-sync closure ever reads it,
			// mislabeling turn N's held record as turn N+1's. Stamping inside the same FIFO chain both
			// turns share pins the number to true execution order instead of wall-clock call order.
			rec.boundarySyncTurn = (rec.boundarySyncTurn ?? 0) + 1;
			rec.boundarySyncStart = await beginTurn(realDir, rec.options.worktree, rec.boundarySyncEndTree, earlyTree);
		});
	}

	/** agent_end (the manager's turn-finished boundary): compute this turn's patch and apply it
	 *  iff the real tree provably has not moved since turn start; otherwise hold + attention. */
	turnEnd(rec: BoundarySyncSession): void {
		const realDir = this.target(rec);
		if (!realDir) return;
		void this.queue(rec, realDir, async () => {
			const start = rec.boundarySyncStart;
			// No live turn start in this process ⇔ a replayed/stale agent_end (reattach replay) — skip
			// rather than fabricate a baseline. A daemon that died mid-turn simply never auto-applies
			// that turn (today's behavior: the real tree is untouched, the diff view still shows all).
			if (!start) return;
			rec.boundarySyncStart = undefined; // consume — one sync decision per live turn
			// Does this turn's patch SPAN the prior end tree? When an uncapturable turn left endTree
			// stale, the next turn's baseline is that same stale tree — its patch therefore CONTAINS
			// the uncapturable turn's edits, so a later applied/noop/held outcome genuinely resolves
			// the standing "worktree-only edits" warning. A first-turn live baseline (no prior end
			// tree) does NOT: edits from an earlier uncapturable turn are inside the baseline and
			// will never sync, so the warning must stand.
			const spannedPrior = start.startTree !== undefined && rec.boundarySyncEndTree !== undefined && start.startTree === rec.boundarySyncEndTree;
			const outcome = await syncTurnEnd({ realDir, worktree: rec.options.worktree, start, store: this.held, agentId: rec.dto.id, turn: rec.boundarySyncTurn ?? 0 }).catch((err) => {
				// syncTurnEnd already holds on any internal throw it can (S6) — this backstop only fires
				// if something escapes even THAT (e.g. a throw before its own try block). Same fail-closed
				// direction — the real tree was never touched — but the failure must be VISIBLE, not a
				// daemon-log-only whisper: the operator would otherwise believe syncing is live while
				// turns silently evaporate.
				return { kind: "uncapturable", reason: `sync bookkeeping failed: ${errText(err)}` } as const;
			});
			// N3: the S6 ledger-append-failed sub-case of "held" (patch body written, but the ledger line
			// that would track it never landed) must NOT advance endTree — advancing it here was a
			// RECOVERY REGRESSION vs. pre-C1 behavior: it made this turn's edits invisible to
			// backlog/listHeld/Apply/boot-sweep (nothing durable points at them) AND, by moving the
			// baseline forward, made it impossible for a LATER spanning patch to ever carry them again —
			// silently and permanently skipping turn N even though pre-fix (`uncapturable`, endTree left
			// stale) the very next turn's spanning patch would have recovered them. Leaving endTree stale
			// here keeps this turn's edits inside the NEXT turn's baseline→worktree delta, exactly like a
			// genuine `uncapturable` outcome already does.
			const ledgerAppendFailed = outcome.kind === "held" && outcome.held === undefined && outcome.patchFile !== undefined;
			if (outcome.kind !== "uncapturable" && !ledgerAppendFailed && outcome.endTree) rec.boundarySyncEndTree = outcome.endTree;
			switch (outcome.kind) {
				case "noop":
					// spannedPrior + empty patch ⇒ the worktree equals the already-synced prior end
					// tree — any earlier uncapturable turn's edits were nil/reverted; the warning is moot.
					if (spannedPrior) this.clearAttention(rec, "uncapturable");
					return;
				case "applied":
					// N2: "held" clears unconditionally — an "applied" outcome only happens when
					// `syncTurnEnd` verified the backlog was empty (step 2 of its precondition), so no held
					// row can legitimately still be standing. "uncapturable" clears only when this patch
					// actually spanned it. Passing `undefined` here used to blanket-clear EVERY
					// boundary-sync row regardless of kind — including "divergence", whose whole point is to
					// persist until the operator explicitly acts on it — so a critical divergence notice
					// raised at turn N was silently swept by the very next clean turn N+1 (every ordinary
					// consecutive turn has `spannedPrior` true). `clearAttention`'s `only` parameter is now
					// required — no call site can ever again reintroduce a blanket clear.
					this.clearAttention(rec, "held");
					if (spannedPrior) this.clearAttention(rec, "uncapturable");
					this.deps.log("info", `boundary-sync (${rec.dto.name}): turn ${rec.boundarySyncTurn} applied to ${realDir} (${outcome.patchBytes} patch bytes)`);
					if (outcome.divergence) {
						// C1: the write happened, but a concurrent edit to one of these exact paths may have
						// interleaved with it — critical, never auto-restored, always named.
						this.raiseAttention(
							rec,
							"divergence",
							`sync divergence detected: ${outcome.divergence.paths.length} path${outcome.divergence.paths.length === 1 ? "" : "s"} may have been clobbered`,
							`A concurrent edit to ${outcome.divergence.paths.join(", ")} in ${realDir} may have interleaved with this turn's write. Nothing was rolled back automatically. ` +
								`The pre-write copy is retained at ${outcome.divergence.captureDir} — compare it against your current file(s) by hand before deciding whether to restore from it.`,
						);
						// Concern 02: a genuinely NEW divergence, discovered exactly once at the moment this
						// turn's own write happened — never re-raised (a restart never replays a live turn's
						// agent_end; the `!start` guard above already returns before this switch on any replay).
						this.deps.friction(rec.dto.id, realDir, `boundary sync divergence: a concurrent edit to ${outcome.divergence.paths.join(", ")} in ${realDir} may have interleaved with this turn's write (agent ${rec.dto.name})`);
					}
					return;
				case "held": {
					// The held patch spans the prior end tree, so it CONTAINS any uncapturable turn's
					// edits — Apply will deliver them; the standalone warning is superseded.
					if (spannedPrior) this.clearAttention(rec, "uncapturable");
					if (outcome.held === undefined && outcome.patchFile) {
						// S6/N3: the patch body itself is safely on disk; only the ledger append that would
						// normally track it failed. `sync: "uncapturable"`, NOT "held" — the webapp's Apply
						// affordance is gated on the sync kind (`insights.ts`), and offering Apply/Discard here
						// would be a lie: there is no ledger-tracked hold to replay or drop yet, only a
						// dangling patch file `endTree` deliberately did NOT advance for (see above), so the
						// NEXT turn's spanning patch still carries these edits — recoverable that way, by hand
						// (the exact file named below), or by the boot sweep (`sweepOrphanedPatches`, wired in
						// `reattachAtBoot`) once the ledger heals — never "nothing is held", never a false
						// Apply-able affordance either.
						this.raiseAttention(
							rec,
							"uncapturable",
							"sync held: this turn's patch is saved but not yet tracked",
							`${outcome.reason} — the patch itself is safe at ${outcome.patchFile}; it won't show up under Apply/Discard until tracking it succeeds. Inspect ${this.held.root} or retry the turn.`,
						);
						return;
					}
					// Count is display-only; ≥1 is certain (this turn's hold just landed), so a ledger
					// read hiccup must not suppress the row itself.
					const n = await this.held.listHeld(rec.dto.id).then((b) => b.length).catch(() => 1);
					this.raiseAttention(
						rec,
						"held",
						`sync held: ${outcome.reason}`,
						`${n} turn${n === 1 ? "'s changes are" : "s' changes are"} held for ${realDir} — nothing touched your checkout. ` +
							`Apply replays them in order after a fresh safety re-check; Discard drops them (the session worktree keeps every edit). ` +
							`Held patches: ${this.held.root}`,
					);
					// Concern 02: fires only here, at the moment `syncTurnEnd` durably created a BRAND NEW
					// held patch (this branch requires `outcome.held !== undefined` — the ledger-append-failed
					// sub-case returned above as "uncapturable" instead) — never at a re-raise of an
					// already-known hold. `reattachAtBoot` (boot re-raise) and `rekeyOnReattach`
					// (restart-reattach re-key) both call `raiseAttention` directly for EXISTING holds
					// without ever routing through this turn-end origin path, so neither can double-count
					// this — no time-window/id dedup needed, the call graph itself makes it exactly-once.
					this.deps.friction(rec.dto.id, realDir, `boundary sync held: ${outcome.reason} (agent ${rec.dto.name}, ${realDir})`);
					return;
				}
				case "uncapturable":
					// The turn's delta itself couldn't be captured — nothing to hold OR apply, so this
					// row must never claim a patch is waiting (no "held", no Apply). Same fail-closed
					// direction (real tree untouched), surfaced so the operator knows edits exist only
					// in the worktree (visible via the normal diff view).
					this.raiseAttention(
						rec,
						"uncapturable",
						"sync couldn't run: this turn's changes couldn't be captured",
						`${outcome.reason} — nothing is held and your checkout is untouched; this turn's edits live only in the session's worktree (${rec.options.worktree}) and show in the diff view.`,
					);
					return;
			}
		});
	}

	/** One boundary-sync attention row per agent PER KIND, always the freshest state (a stack of
	 *  stale "sync held" rows for the same session is noise, not signal — but a "held" row and an
	 *  "uncapturable" row state different truths and must never erase each other: an uncapturable
	 *  turn after a held backlog would otherwise hide the only Apply/Discard affordance for real
	 *  patches, and vice versa). `sync` distinguishes rows the webapp can resolve with Apply/Discard
	 *  ("held" — durable patches are waiting) from rows that hold NOTHING ("uncapturable" — Apply
	 *  there would be a lie; the webapp offers View) from rows the write ALREADY happened for
	 *  ("divergence" — C1: nothing pending, nothing to Apply/Discard, only a critical notice + a
	 *  named recovery capture). Non-blocking by design — AttentionEvent never flips agent status; the
	 *  turn itself succeeded (or, for "divergence", already wrote). */
	private raiseAttention(rec: BoundarySyncSession, sync: "held" | "uncapturable" | "divergence", summary: string, detail: string): void {
		const kept = (rec.dto.attentionEvents ?? []).filter((e) => e.source !== "boundary-sync" || (e.sync ?? "held") !== sync);
		rec.dto.attentionEvents = [...kept, { id: randomUUID(), summary, detail, source: "boundary-sync", sync, createdAt: Date.now() }];
		this.deps.emit(rec);
	}

	/** `only` narrows the clear to one row kind — REQUIRED (N2): a blanket clear (no `only`, drop every
	 *  boundary-sync row regardless of kind) used to be reachable by passing `undefined`, and the one
	 *  call site that did (`turnEnd`'s "applied" case, `spannedPrior ? undefined : "held"`) swept a
	 *  critical "divergence" row on the very next clean turn — every ordinary consecutive turn has
	 *  `spannedPrior` true, so a divergence notice was silently gone by the time an operator could act on
	 *  it. A "divergence" row must persist until the operator explicitly resolves it (see
	 *  `acknowledgeDivergence`) or discards its retained capture — it is NEVER an acceptable target for
	 *  an implicit clear, so removing the ability to omit `only` at all is the fail-closed fix: no
	 *  future call site can reintroduce the blanket-clear bug even by accident. The apply/discard
	 *  resolution paths clear "held" only — resolving the backlog says nothing about an "uncapturable"
	 *  warning, whose turn's edits are still worktree-only; clearing it would silently dismiss a true
	 *  statement. The turn-end path clears "uncapturable" once a spanning patch provably covered those
	 *  edits (see turnEnd's spannedPrior). */
	private clearAttention(rec: BoundarySyncSession, only: "held" | "uncapturable" | "divergence"): void {
		const events = rec.dto.attentionEvents ?? [];
		const kept = events.filter((e) => e.source !== "boundary-sync" || (e.sync ?? "held") !== only);
		if (kept.length === events.length) return;
		rec.dto.attentionEvents = kept;
		this.deps.emit(rec);
	}

	/**
	 * N2: the explicit "I've looked at this" affordance a "divergence" row otherwise has no way to
	 * resolve — `clearAttention` can never target it implicitly (see above), and unlike a "held" row
	 * there is no ledger entry an Apply/Discard call resolves; the write already happened, there is
	 * nothing left to apply or drop, only a notice and a retained pre-write capture the operator has
	 * (or hasn't) reconciled by hand. Acknowledging clears ONLY the "divergence" kind — exactly the
	 * row this exists for — never "held"/"uncapturable", so it can never be used to paper over a real
	 * pending backlog.
	 */
	async acknowledgeDivergence(id: string, actor: Actor): Promise<{ ok: boolean; reason?: string }> {
		const rec = this.deps.agent(id);
		if (!rec) return { ok: false, reason: "no such agent" };
		const had = (rec.dto.attentionEvents ?? []).some((e) => e.source === "boundary-sync" && e.sync === "divergence");
		if (!had) return { ok: true };
		this.clearAttention(rec, "divergence");
		void this.deps.recordAudit(actor, "boundary-sync.ack-divergence", id, "ok", "operator acknowledged a boundary-sync divergence notice");
		return { ok: true };
	}

	/**
	 * Explicit apply affordance (POST /api/agents/:id/apply-held-sync). Re-runs the fail-closed
	 * precondition with a FRESH capture (never the stale fingerprint the hold was raised with — the
	 * real tree may have moved again since) and replays this agent's held patches in order; the
	 * first conflict stops the run with everything after it still held. See boundary-sync.ts
	 * `applyHeldNow` for why divergence is judged per patch here (the operator's click is the
	 * authorization the auto path lacks).
	 */
	async applyHeld(id: string, actor: Actor): Promise<{ ok: boolean; applied: number; remaining: number; reason?: string; divergences?: { turn: number; paths: string[]; captureDir: string }[] }> {
		const rec = this.deps.agent(id);
		if (!rec) return { ok: false, applied: 0, remaining: 0, reason: "no such agent" };
		const realDir = await this.resolveDir(rec);
		if (!realDir) return { ok: false, applied: 0, remaining: 0, reason: "this unit has no boundary sync (not a here-class session)" };
		let result: Awaited<ReturnType<typeof applyHeldNow>> = { ok: false, applied: 0, remaining: 0, reason: "apply did not run" };
		try {
			await this.queue(rec, realDir, async () => {
				result = await applyHeldNow(this.held, id, realDir);
			});
		} catch (err) {
			// The chain rejected (e.g. the held ledger is unreadable — fail-closed, nothing applied
			// beyond what `result` already recorded). `remaining` from the initializer would LIE
			// ("Still held (0 turns)"), so recount best-effort before reporting.
			const remaining = await this.held.listHeld(id).then((h) => h.length).catch(() => result.remaining);
			result = { ok: false, applied: result.applied, remaining, reason: errText(err) };
		}
		if (result.ok && result.remaining === 0) {
			// "held" only: resolving the backlog must not dismiss an "uncapturable" row — that warning
			// is about a turn whose edits are STILL worktree-only, and it holds nothing to apply.
			this.clearAttention(rec, "held");
		} else if (result.reason) {
			this.raiseAttention(rec, "held", `sync still held: ${result.reason}`, `${result.applied} applied, ${result.remaining} still held for ${realDir}. Held patches: ${this.held.root}`);
		}
		if (result.divergences && result.divergences.length > 0) {
			// C1: at least one replayed patch wrote successfully but diverged from its expected result —
			// critical, never auto-restored, one row naming every affected turn + capture location.
			this.raiseAttention(
				rec,
				"divergence",
				`sync divergence detected across ${result.divergences.length} replayed turn${result.divergences.length === 1 ? "" : "s"}`,
				result.divergences
					.map((d) => `turn ${d.turn}: ${d.paths.join(", ")} (pre-write copy retained at ${d.captureDir})`)
					.join("; ") + ` — nothing was rolled back automatically; compare each capture against the current file(s) by hand.`,
			);
			// Concern 02: a NEW divergence, discovered exactly once at THIS explicit replay (a resolved
			// patch never re-enters the backlog, so a later Apply call can't rediscover the same one).
			this.deps.friction(rec.dto.id, realDir, `boundary sync divergence detected across ${result.divergences.length} replayed turn${result.divergences.length === 1 ? "" : "s"} for ${realDir} (agent ${rec.dto.name})`);
		}
		void this.deps.recordAudit(actor, "boundary-sync.apply", id, result.ok ? "ok" : "error", `${result.applied} applied, ${result.remaining} remaining${result.reason ? ` — ${result.reason}` : ""}`);
		return result;
	}

	/**
	 * Explicit discard affordance (POST /api/agents/:id/discard-held-sync) — the recovery path for a
	 * backlog that can never apply cleanly (operator fixed the divergence by hand; crash between an
	 * apply and its resolve marker makes replay fail `--check` forever). Without it a wedged oldest
	 * patch auto-holds every later turn: auto-sync bricked for the session. Drops the pending write
	 * only — the real tree is untouched and the session worktree keeps every edit. `patchId` narrows
	 * the drop to one held patch; omitted, the agent's whole backlog is discarded.
	 */
	async discardHeld(id: string, patchId: string | undefined, actor: Actor): Promise<{ ok: boolean; discarded: number; remaining: number; reason?: string }> {
		const rec = this.deps.agent(id);
		if (!rec) return { ok: false, discarded: 0, remaining: 0, reason: "no such agent" };
		const realDir = await this.resolveDir(rec);
		if (!realDir) return { ok: false, discarded: 0, remaining: 0, reason: "this unit has no boundary sync (not a here-class session)" };
		let result: { ok: boolean; discarded: number; remaining: number; reason?: string } = { ok: false, discarded: 0, remaining: 0, reason: "discard did not run" };
		try {
			// Same per-checkout chain as capture/apply: a discard must never interleave with a
			// half-finished replay of the very patches it is dropping.
			await this.queue(rec, realDir, async () => {
				result = await discardHeldNow(this.held, id, patchId);
			});
		} catch (err) {
			// Same honesty rule as applyHeld's catch: never report the initializer's counts as
			// if they were observed — recount best-effort.
			const remaining = await this.held.listHeld(id).then((h) => h.length).catch(() => result.remaining);
			result = { ok: false, discarded: result.discarded, remaining, reason: errText(err) };
		}
		if (result.ok && result.remaining === 0) {
			this.clearAttention(rec, "held");
		} else if (result.remaining > 0) {
			this.raiseAttention(
				rec,
				"held",
				`sync held: ${result.remaining} turn${result.remaining === 1 ? "" : "s"} still held`,
				`${result.discarded} discarded, ${result.remaining} still held for ${realDir}. Apply replays them in order after a fresh safety re-check; Discard drops them. Held patches: ${this.held.root}`,
			);
		}
		void this.deps.recordAudit(actor, "boundary-sync.discard", id, result.ok ? "ok" : "error", `${result.discarded} discarded, ${result.remaining} remaining${result.reason ? ` — ${result.reason}` : ""}`);
		return result;
	}

	/** Boot: attention events are in-memory only, held patches are durable — re-raise the "sync
	 *  held" row for every restored session that still has holds, and (C2) raise a REPO-SCOPED,
	 *  discoverable notice — never just a log line — for holds whose agent no longer exists at all:
	 *  these are exactly the sessions a `here` restart-reattach (`rekeyOnReattach`) will later
	 *  re-key onto a fresh id, so "no live owner yet" is a recoverable, expected state, not a
	 *  loss. `orphaned()` is the durable, queryable half (GET /api/boundary-sync/orphaned in
	 *  server.ts); the warn log is the immediate operational half — both name the exact patch
	 *  files and the recovery path. */
	async reattachAtBoot(): Promise<void> {
		// N3: recover any hold whose ledger-append failed and was never re-tracked before the daemon
		// died/restarted (`HeldLedgerAppendError`'s `.patch` body survives, but with no ledger line —
		// see `HeldSyncStore.sweepOrphanedPatches`'s doc for why this is the honest fix for the boot-
		// sweep recovery this module has long CLAIMED but, before N3, never actually implemented). Runs
		// before the ledger read below so a recovered hold shows up in `all` on this very boot.
		const swept = await this.held.sweepOrphanedPatches().catch((err) => {
			this.deps.log("warn", `boundary-sync: boot sweep for ledgerless patch files failed (${errText(err)})`);
			return { recovered: [], unrecoverable: [] };
		});
		if (swept.recovered.length > 0) {
			this.deps.log("info", `boundary-sync: boot sweep recovered ${swept.recovered.length} previously-untracked held patch(es) (a ledger-append failure survived a restart) — now visible under the normal held-sync affordances`);
		}
		if (swept.unrecoverable.length > 0) {
			this.deps.log("warn", `boundary-sync: boot sweep found ${swept.unrecoverable.length} orphaned patch file(s) with no recoverable metadata — inspect by hand: ${swept.unrecoverable.join(", ")}`);
		}
		// Minor follow-up: divergence-capture GC — C1's retained pre-write captures (retainDivergenceCapture)
		// had no retention bound at all; bounded here at boot, same cadence as the patch-file sweep above.
		const pruned = await pruneDivergenceCaptures(path.join(this.held.root, "divergence")).catch((err) => {
			this.deps.log("warn", `boundary-sync: divergence-capture prune failed (${errText(err)})`);
			return { removed: 0 };
		});
		if (pruned.removed > 0) this.deps.log("info", `boundary-sync: pruned ${pruned.removed} old divergence capture(s)`);
		const all = await this.held.listAllHeld().catch((err) => {
			// Boot must not die on a sick ledger, but swallowing it silently would hide real held
			// patches behind a missing attention row — say so, loudly.
			this.deps.log("warn", `boundary-sync: could not read the held ledger at boot (${errText(err)}) — held patches (if any) have NO attention rows this tenure; inspect ${this.held.root}`);
			return [];
		});
		if (all.length === 0) return;
		const byAgent = new Map<string, HeldSync[]>();
		for (const h of all) {
			const bucket = byAgent.get(h.agentId);
			if (bucket) bucket.push(h);
			else byAgent.set(h.agentId, [h]);
		}
		for (const [agentId, held] of byAgent) {
			const rec = this.deps.agent(agentId);
			if (rec) {
				// N4-adjacent: gate on the record's LIVENESS only, never on `options.realTreePath` — a
				// promoted session (S5) clears that field, but its pre-existing holds are still this
				// session's own and must still surface here; `held[0]!.realDir` (the hold's own recorded
				// checkout, straight off the ledger) is the honest source, not the live option.
				const realDir = held[0]!.realDir;
				this.raiseAttention(
					rec,
					"held",
					`sync held: ${held.length} turn${held.length === 1 ? "" : "s"} from before the daemon restart`,
					`Held for ${realDir} — nothing touched your checkout. Apply replays them in order after a fresh safety re-check; Discard drops them (the session worktree keeps every edit).`,
				);
			} else {
				const realDir = held[0]!.realDir;
				const files = held.map((h) => h.patchFile).join(", ");
				this.deps.log(
					"warn",
					`boundary-sync: ${held.length} held patch(es) for a session that no longer exists (agent ${agentId}, checkout ${realDir}) — nothing was lost. ` +
						`Recover by running \`glance here\` again on that checkout with a restart reattach — reaching this repo re-keys them onto your new session automatically. ` +
						`Patch files: ${files} (ledger: ${this.held.root}).`,
				);
			}
		}
	}

	/** C2: held boundary-sync patches whose owning agent isn't (or isn't yet) in the roster — a `here`
	 *  session that hasn't reattached this tenure. Repo-scoped (`realDir`), not id-scoped: the operator
	 *  recovers these by launching `glance here` again on the SAME checkout with a restart reattach
	 *  (server.ts `POST /api/console { reattachOf }` → `rekeyOnReattach`), which re-keys any hold
	 *  whose recorded `realDir` matches the new session's — the old agent id itself is otherwise
	 *  meaningless to them. Read-only, computed fresh from the durable ledger every call (cheap: this
	 *  is a rare-event list, never a hot path). */
	async orphaned(): Promise<{ agentId: string; realDir: string; count: number; patchFiles: string[] }[]> {
		const all = await this.held.listAllHeld().catch(() => []);
		const byAgent = new Map<string, HeldSync[]>();
		for (const h of all) {
			if (this.deps.agent(h.agentId)) continue; // has a live owner — not orphaned
			const bucket = byAgent.get(h.agentId);
			if (bucket) bucket.push(h);
			else byAgent.set(h.agentId, [h]);
		}
		return [...byAgent.entries()].map(([agentId, held]) => ({
			agentId,
			realDir: held[0]!.realDir,
			count: held.length,
			patchFiles: held.map((h) => h.patchFile),
		}));
	}

	/** C2: a predecessor's held boundary-syncs die with their agent id across a `here` restart — ACP
	 *  sessions are non-resumable, so `POST /api/console { reattachOf }` always mints a NEW agent id,
	 *  and a hold keyed by the dead predecessor's id would otherwise be permanently unreachable (no
	 *  live agent ever lists it again; `reattachAtBoot` can only warn about the orphan). Re-key iff
	 *  BOTH hold: explicit lineage (the client NAMES its dead predecessor via `reattachOf`) AND the
	 *  new session's own real checkout (`realDir`, derived server-side from the ephemeral
	 *  registration — never client-supplied) matches the hold's recorded `realDir` exactly. Neither
	 *  alone is safe — explicit lineage with no tree match would hand one checkout's holds to a
	 *  session on a different one; a bare tree match with no named lineage would be guessing from
	 *  nothing. Re-keyed holds are surfaced immediately as the new agent's own held-sync attention,
	 *  exactly like a same-tenure hold — never left to a boot log line the operator has to go find. */
	async rekeyOnReattach(rec: BoundarySyncSession, priorId: string): Promise<void> {
		const realDir = rec.options.realTreePath;
		if (!realDir) return; // the new session isn't a here-class session — nothing to re-key onto
		const priorHeld = await this.held.listHeld(priorId).catch((err) => {
			this.deps.log("warn", `boundary-sync: couldn't read held patches for reattach lineage ${priorId}→${rec.dto.id}: ${errText(err)}`);
			return [];
		});
		const resolvedRealDir = path.resolve(realDir);
		const matching = priorHeld.filter((h) => path.resolve(h.realDir) === resolvedRealDir);
		if (matching.length === 0) return;
		for (const h of matching) {
			try {
				await this.held.rekey(h.id, rec.dto.id);
			} catch (err) {
				this.deps.log("warn", `boundary-sync: re-key of held patch ${h.id} (${priorId}→${rec.dto.id}) failed: ${errText(err)}`);
			}
		}
		const n = await this.held.listHeld(rec.dto.id).then((b) => b.length).catch(() => matching.length);
		if (n > 0) {
			this.raiseAttention(
				rec,
				"held",
				`sync held: ${n} turn${n === 1 ? "'s changes are" : "s' changes are"} recovered from your previous session`,
				`Held for ${realDir} — nothing touched your checkout. Apply replays them in order after a fresh safety re-check; Discard drops them (the session worktree keeps every edit). Held patches: ${this.held.root}`,
			);
		}
	}
}
