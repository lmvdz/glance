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

	// ponytail: this is an in-memory roster walk. Ceiling is O(n²) for very large fan-out trees;
	// upgrade to a parentId index if a single manager routinely holds thousands of agents.
	let changed = true;
	while (changed) {
		changed = false;
		for (const a of roster) {
			if (a.parentId && out.has(a.parentId) && !out.has(a.id)) {
				out.add(a.id);
				changed = true;
			}
		}
	}
	return out;
}
