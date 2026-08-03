/**
 * roomState.ts — the state pane's copy and grouping, as pure functions.
 *
 * THE COPY IS THE DESIGN, so the strings live here rather than in JSX, where they can be tested
 * against the rules they have to satisfy. Every one of these states a fact AND what it means. A
 * string that only names a state is unfinished, and that is a thing a test can check.
 *
 * The six patterns from DESIGN.md are requirements, not suggestions:
 *
 * - **Autonomy is a streak, not a count.** Zero waiting is an achievement, shown as elapsed unbroken
 *   autonomy beside the month's best run — not an empty list with a zero on it.
 * - **Every control says what it will do** before it is pressed.
 * - **Every decision offers a free-text option**, so it stays part of a conversation.
 * - **Evidence carries its age** and what to do about it.
 * - **Blast radius, unprompted** — what is NOT affected, before anyone asks.
 * - **A folded run carries a verdict**, not just a count.
 */

/**
 * `idle` is the state a live unit sits in BETWEEN turns — connected, not producing. It is deliberately
 * distinct from `in-flight`: it stays on the working surface (a unit that exists must be visible) but
 * it is not work in progress, so `fleetSummary` must not count it. Collapsing the two is what made the
 * top bar claim "7 units working" for a fleet where nothing at all was running.
 */
export type NodeState = "needs-you" | "in-flight" | "idle" | "settled" | "blocked" | "parked";

export interface RoomNode {
	id: string;
	/** Spoken address — "3.2" — so a person and an agent can mean the same unit out loud. */
	address: string;
	title: string;
	state: NodeState;
	/** Agent currently holding it, when one is. */
	owner?: string;
	/** Addresses this node is waiting on. */
	waitingOn?: string[];
	/** When it last moved. */
	lastMovementAt?: number;
	/** Addresses that depend on this one — the blast radius of it stalling. */
	dependents?: string[];
}

/** The three regions of the state pane. Settled work leaves the working surface. */
export interface RoomGroups {
	needsYou: RoomNode[];
	inFlight: RoomNode[];
	settled: RoomNode[];
}

/**
 * State picks the region; velocity only orders WITHIN it. A single "hot" score would let a chatty
 * healthy thread outrank a silent blocked one, which is precisely the failure a feed already has.
 */
export function groupByState(nodes: readonly RoomNode[]): RoomGroups {
	const byRecency = (a: RoomNode, b: RoomNode) => (b.lastMovementAt ?? 0) - (a.lastMovementAt ?? 0) || a.address.localeCompare(b.address);
	return {
		needsYou: nodes.filter((n) => n.state === "needs-you").sort(byRecency),
		// `idle` belongs to the working region, not to settled: the unit still exists and is still
		// yours to act on. It just isn't producing, which is a counting question (fleetSummary), not a
		// visibility question.
		inFlight: nodes.filter((n) => n.state === "in-flight" || n.state === "idle" || n.state === "blocked" || n.state === "parked").sort(byRecency),
		settled: nodes.filter((n) => n.state === "settled").sort(byRecency),
	};
}

/**
 * The alarm band: one full-width sentence that EXPLAINS, never a labelled counter.
 *
 * At zero it is not an empty state. It reports a streak, because in an autonomous system work waiting
 * on a human is a defect and zero of them is an achievement worth naming.
 */
export function alarmBand(
	needsYou: readonly RoomNode[],
	autonomy: { sinceMs?: number; bestRunMs?: number; now: number },
): string {
	if (needsYou.length === 0) {
		const since = autonomy.sinceMs === undefined ? undefined : autonomy.now - autonomy.sinceMs;
		if (since === undefined) {
			return "Nothing has needed you. The fleet has not had to stop for anyone.";
		}
		const best = autonomy.bestRunMs === undefined ? "" : ` · longest run this month ${duration(autonomy.bestRunMs)}`;
		return `Nothing has needed you for ${duration(since)} of unbroken autonomy${best}.`;
	}
	if (needsYou.length === 1) {
		return `One thing is waiting on you. Everything else in the fleet is still moving.`;
	}
	// Several at once is a statement about the WORK, not a list for the human to manage.
	return `${needsYou.length} things are waiting on you at once. That is a defect in the work, not a list for you to keep — they should not have arrived together.`;
}

/** A per-node line that says what it is doing AND what that means for anyone else. */
export function nodeStatusLine(node: RoomNode, now: number): string {
	switch (node.state) {
		case "needs-you":
			return `Waiting on you${node.owner ? ` — ${node.owner} stopped rather than guess` : ""}. ${blastRadius(node)}`;
		case "blocked": {
			const waiting = node.waitingOn?.length ? node.waitingOn.join(" and ") : "something nobody has named";
			return `Holding — cannot start until ${waiting} is decided. ${blastRadius(node)}`;
		}
		case "parked":
			// Parked carries NO stall number, because parked is a decision (concern 13).
			return `Parked. Someone decided this waits, so nothing here is overdue.`;
		case "idle": {
			// Idle is NOT parked: nobody decided this waits. The unit is alive and between turns, which
			// is a fact worth stating plainly rather than dressing up as progress.
			const since = node.lastMovementAt === undefined ? "" : ` Last moved ${duration(now - node.lastMovementAt)} ago.`;
			return `${node.owner ?? "This unit"} is idle — alive, but not working on anything right now.${since} ${blastRadius(node)}`;
		}
		case "in-flight": {
			if (!node.owner) return `Queued — nobody has picked it up yet. ${blastRadius(node)}`;
			// Healthy work still states its blast radius. "Wren is working on it" names a state and stops
			// there, which is the failure mode this whole rule exists to prevent.
			const moved = node.lastMovementAt === undefined ? " No movement recorded yet." : ` Last moved ${duration(now - node.lastMovementAt)} ago.`;
			return `${node.owner} is working on it.${moved} Nothing is waiting on you for this.`;
		}
		case "settled":
			return `Settled. It is off the working surface and stays readable.`;
	}
}

/** What is NOT affected. Answer the anxious question before it is asked. */
function blastRadius(node: RoomNode): string {
	const dependents = node.dependents ?? [];
	if (dependents.length === 0) return "Nothing else in the tree depends on it.";
	if (dependents.length === 1) return `Only ${dependents[0]} is waiting behind it.`;
	return `${dependents.length} pieces of work are waiting behind it: ${dependents.slice(0, 3).join(", ")}${dependents.length > 3 ? ", and others" : ""}.`;
}

/**
 * A folded run of machine events ends in a JUDGEMENT, not a count. "38 events" tells a person
 * nothing about whether to open it; "nothing unusual" is a claim they can disagree with.
 */
export function foldVerdict(run: { count: number; agents: readonly string[]; kinds: readonly string[]; unusual?: string }): string {
	const agents = run.agents.slice(0, 3).join(", ");
	const more = run.agents.length > 3 ? ` +${run.agents.length - 3}` : "";
	const what = run.kinds.slice(0, 3).join(", ");
	const head = `${run.count} event${run.count === 1 ? "" : "s"} · ${agents}${more} · ${what}`;
	return run.unusual ? `${head} · ${run.unusual}` : `${head} · nothing unusual`;
}

/**
 * Selecting is a reversible inspection; entering changes what you are reading (concern 07). The
 * preview says both, so a person learns the difference without being taught it.
 */
export function selectionPreview(node: RoomNode): string {
	return `Selected: ${node.title}. Press Enter to read its conversation; the room timeline stays where you are.`;
}

/** Back is history, not graph traversal. */
export function backLabel(title: string): string {
	return `Back to ${title} — return to the message you were reading.`;
}

/**
 * The quiet screen is a HANDOVER — what got done while you were not looking — and it says what it
 * left out, so a bounded summary never reads as a complete one.
 */
export function handoverSummary(input: {
	awayMs: number;
	finished: readonly string[];
	changedDirection: readonly string[];
	wentUnanswered: readonly string[];
	omitted: number;
}): string[] {
	const lines = [`While you were away — ${duration(input.awayMs)}.`];
	lines.push(
		input.finished.length === 0
			? "Nothing finished."
			: `Finished: ${input.finished.slice(0, 3).join("; ")}${input.finished.length > 3 ? `; and ${input.finished.length - 3} more` : ""}.`,
	);
	if (input.changedDirection.length > 0) {
		lines.push(`Changed direction: ${input.changedDirection.join("; ")}. Somebody decided differently than the plan assumed.`);
	}
	// The one thing that must be unmissable.
	lines.push(
		input.wentUnanswered.length === 0
			? "Nothing needed you and got no answer."
			: `${input.wentUnanswered.length} thing${input.wentUnanswered.length === 1 ? "" : "s"} needed you and got no answer: ${input.wentUnanswered.join("; ")}. ${input.wentUnanswered.length === 1 ? "It is" : "They are"} still actionable.`,
	);
	// A summary that does not say what it left out reads as complete.
	lines.push(
		input.omitted === 0
			? "That is everything, not a selection."
			: `${input.omitted} quieter event${input.omitted === 1 ? " is" : "s are"} not listed here; ${input.omitted === 1 ? "it is" : "they are"} on ${input.omitted === 1 ? "its" : "their"} own node${input.omitted === 1 ? "" : "s"}.`,
	);
	return lines;
}

/** Human-readable elapsed time. Deliberately coarse — nobody acts on seconds. */
export function duration(ms: number): string {
	const safe = Math.max(0, ms);
	// Checked BEFORE rounding: 30 seconds rounds to 1 and would read as a minute that has not passed.
	if (safe < 60_000) return "under a minute";
	const mins = Math.round(safe / 60_000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	const rem = mins % 60;
	if (hours < 24) return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "a day" : `${days} days`;
}

/** One row in "WHERE YOU ARE STANDING" — #fleet, another room, or a unit's own conversation. */
export interface RoomView {
	id: string;
	name: string;
	unread: number;
	/** Node channels are a unit's own conversation, not a room you joined. */
	kind: "room" | "node";
	/**
	 * A node channel whose unit is no longer active (or no longer exists at all) — the rail folds it
	 * into a collapsed section rather than growing forever. A plain room (#fleet, or a channel a
	 * person created directly) is never settled — it has no unit to settle.
	 */
	settled: boolean;
}

/**
 * Projects the raw channel list into what the standing tree shows: one row per channel id — a
 * defensive dedupe. The daemon already collapses duplicate-named node channels at list time
 * (src/channels.ts's `reconcileDuplicateNodeChannels`) and never emits two rows sharing an id, but a
 * fetch race, a stale response landing after a newer one, or a daemon that predates the fix must
 * never be able to double a row here either — this is the last line of defense, not the fix itself.
 *
 * The fold is matched by display NAME rather than channel id, because a unit re-dispatched across a
 * restart gets a fresh node id (deliberate — see `spawn-identity.ts`'s `newAgentId`) but keeps the
 * same title, and the fold has to track the UNIT, not whichever id most recently got bound to its
 * channel.
 */
export function roomViewsFrom(
	channels: ReadonlyArray<{ id: string; name: string; unreadCount?: number }>,
	units: ReadonlyArray<{ title: string; state: NodeState }>,
): RoomView[] {
	const activeTitles = new Set(units.filter((unit) => unit.state !== "settled").map((unit) => unit.title));
	const byId = new Map<string, RoomView>();
	for (const entry of channels) {
		const name = entry.name.startsWith("#") ? entry.name : `#${entry.name}`;
		const kind: RoomView["kind"] = entry.id.startsWith("node:") ? "node" : "room";
		byId.set(entry.id, { id: entry.id, name, unread: entry.unreadCount ?? 0, kind, settled: kind === "node" && !activeTitles.has(name.slice(1)) });
	}
	return [...byId.values()];
}

/**
 * The fleet roster, read as room state.
 *
 * Deliberately a projection rather than a second source of truth: the roster already knows what is
 * running, what stopped, and who owns what. Inventing a parallel model is how two views of the same
 * fleet start disagreeing — the bug class this plan has already fixed twice for visibility.
 */
export function agentsToRoomNodes(
	agents: ReadonlyArray<{ id: string; name?: string; status?: string; pending?: unknown[]; parentId?: string; updatedAt?: number; createdAt?: number }>,
): RoomNode[] {
	const childCount = new Map<string, string[]>();
	for (const agent of agents) {
		if (!agent.parentId) continue;
		childCount.set(agent.parentId, [...(childCount.get(agent.parentId) ?? []), agent.name || agent.id]);
	}
	return agents.map((agent, index) => ({
		id: agent.id,
		// Until nodes carry their own spoken address, position is the honest stand-in — it is at least
		// stable within a render and sayable out loud.
		address: `${index + 1}`,
		title: agent.name || agent.id,
		state: roomStateOf(agent),
		owner: agent.name || undefined,
		lastMovementAt: agent.updatedAt ?? agent.createdAt,
		dependents: childCount.get(agent.id),
	}));
}

function roomStateOf(agent: { status?: string; pending?: unknown[] }): NodeState {
	if ((agent.pending?.length ?? 0) > 0) return "needs-you";
	switch (agent.status) {
		case "working":
			return "in-flight";
		// Spinning up IS in flight — the unit was just told to do something and is on its way.
		case "starting":
			return "in-flight";
		case "blocked":
			return "blocked";
		case "input":
			// Asking for input is asking for a PERSON, even before a pending request has materialised.
			return "needs-you";
		case "done":
		case "stopped":
			return "settled";
		case "error":
			// An errored unit needs a person: it stopped in a way it did not choose.
			return "needs-you";
		case "idle":
			return "idle";
		default:
			// Absence-as-answer, in the direction that cannot lie about work: an unrecognised or missing
			// status must NOT read as settled (settled work leaves the working surface and would vanish),
			// and must NOT read as in-flight either (that is a claim that work is happening, which is
			// exactly the claim we cannot support). `idle` is the honest middle — still on the working
			// surface, not counted as working.
			//
			// The bug that prompted this was the `idle` case above, not this one: `idle` had no case of
			// its own and fell through to `in-flight`, so a fleet of live-but-unoccupied units reported
			// as fully busy. This branch is hardened in the same direction rather than left as the one
			// remaining path that can invent work out of a value nobody recognises.
			return "idle";
	}
}
