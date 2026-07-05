import type { Actor, AgentDTO } from "./types.ts";

/** Actor stamped from an authenticated agent host; payloads never get to claim sender identity. */
export function agentActor(agentId: string): Actor {
	return { id: agentId, origin: "agent" };
}

/** Agents this actor may inspect or address. Humans see the local manager roster; agents get their hierarchy slice. */
export function scopeFor(actor: Actor, roster: AgentDTO[]): Set<string> {
	const ids = new Set(roster.map((a) => a.id));
	if (actor.origin !== "agent") return ids;
	if (!ids.has(actor.id)) return new Set();

	const byId = new Map(roster.map((a) => [a.id, a]));
	const out = new Set<string>([actor.id]);
	const self = byId.get(actor.id);

	if (self?.featureId) {
		for (const a of roster) if (a.featureId === self.featureId) out.add(a.id);
	}

	for (let parent = self?.parentId; parent; ) {
		const p = byId.get(parent);
		if (!p) break;
		out.add(p.id);
		parent = p.parentId;
	}

	// Self's OWN descendant subtree — an agent may address/inspect the agents IT spawned, but not its
	// siblings or cousins. Seed the closure from the actor ALONE, then union in: seeding from `out`
	// (which already holds the ancestor chain) would pull in every child of every ancestor — the whole
	// cross-branch subtree — leaking sibling/cousin agents into the message allowlist and the fabric scope.
	// ponytail: in-memory roster walk, O(n²) worst case for very large fan-out; index parentId if a single
	// manager routinely holds thousands of agents.
	const descendants = new Set<string>([actor.id]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const a of roster) {
			if (a.parentId && descendants.has(a.parentId) && !descendants.has(a.id)) {
				descendants.add(a.id);
				changed = true;
			}
		}
	}
	for (const id of descendants) out.add(id);
	return out;
}
