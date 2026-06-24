/**
 * Auto-land policy: in autonomous-land mode a workflow run that finishes
 * successfully lands its OWN branch — closing the intake → build → verify → LAND
 * loop with no operator in it. Pure, so the decision is unit-tested without git or
 * omp; the manager injects `land` (the serialized landAgent seam) and `log`.
 *
 * ponytail: clean lands (fast-forward, or a disjoint merge when main moved) are
 * fully autonomous here. A real CONTENT conflict still surfaces (logged, branch
 * left intact). Upgrade path: on a conflict result, run the bundled resolve-conflict
 * workflow on the branch and retry the land, so even that needs no human.
 */
import type { LandResult } from "./land.ts";

export interface AutoLandDeps {
	/** Land an agent's branch (serialized landAgent seam); also closes its tracking issue. */
	land: (id: string) => Promise<LandResult>;
	log: (msg: string) => void;
}

export interface AutoLandAgent {
	id: string;
	name: string;
}

/**
 * Land the agent's branch iff auto-land mode is on AND the run succeeded.
 * Returns the LandResult, or null when it did not attempt (mode off / not a success).
 */
export async function autoLandOnSuccess(
	enabled: boolean,
	outcome: string | undefined,
	agent: AutoLandAgent,
	deps: AutoLandDeps,
): Promise<LandResult | null> {
	if (!enabled || outcome !== "succeeded") return null;
	const res = await deps.land(agent.id);
	if (res.ok) deps.log(`auto-landed ${agent.name}: ${res.detail ?? "merged"}`);
	else if (res.staged) deps.log(`auto-land staged ${agent.name}: ${res.detail ?? "conflict auto-resolved"} — ready for one-tap Land`);
	else deps.log(`auto-land blocked on ${agent.name}: ${res.detail ?? "land failed"} — needs conflict resolution`);
	return res;
}
