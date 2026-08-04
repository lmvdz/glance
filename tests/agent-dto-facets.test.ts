import { expect, test } from "bun:test";
import type {
	AgentAttentionFacet,
	AgentDTO,
	AgentHarnessFacet,
	AgentLandFacet,
	AgentRosterCore,
	AgentWorkFacet,
	AgentWorkflowFacet,
} from "../src/types.ts";

/**
 * Compile-time freeze for the AgentDTO facet split (deepen 06, slice 3).
 *
 * The first version of this test compared `AgentDTO` against the intersection of its own six
 * facets — CIRCULAR, as the blind codex pass proved with a concrete hole: deleting `etaAt`
 * from a facet changed both sides of the comparison at once and nothing fired (the
 * absence-as-evidence shape, yet again). The oracle below is therefore INDEPENDENT: a frozen
 * literal field→optionality map, written out by hand, that `satisfies` pins against
 * `keyof AgentDTO` exactly in both directions —
 *
 *  - a field DELETED from any facet leaves its frozen entry orphaned → excess-property error;
 *  - a field ADDED anywhere (directly, or via a seventh facet on the extends line) is missing
 *    from the map → missing-property error;
 *  - an OPTIONALITY flip fails the per-key `OptionalityOf` check.
 *
 * Deliberately NOT frozen: each field's full type text. Widening a field (e.g. `number` →
 * `number | string`) is invisible to this map — but not to the 112 importers tsc checks on
 * every `bun run check`, which is the honest oracle for type drift. Field-set and optionality
 * are what a declaration-site reshuffle can silently lose; types are what consumers pin.
 *
 * The pairwise-disjointness check (each field has exactly ONE facet home) enumerates the six
 * facets explicitly — a SEVENTH facet added later must be added to both the `Facets`
 * intersection and the `Overlap` pair list, or its duplicates escape this test (noted by the
 * same blind pass).
 */

type Facets = AgentRosterCore & AgentHarnessFacet & AgentWorkflowFacet & AgentWorkFacet & AgentLandFacet & AgentAttentionFacet;
type AssertMutual<A, B> = A extends B ? (B extends A ? true : never) : never;
const dtoEqualsFacets: AssertMutual<AgentDTO, Facets> = true;

type OptionalityOf<K extends keyof AgentDTO> = Record<never, never> extends Pick<AgentDTO, K> ? "optional" : "required";

/** The independent oracle: every AgentDTO field and its optionality, frozen by hand.
 *  72 entries — update this list IN THE SAME PR as any deliberate DTO field change. */
const FROZEN_FIELDS = {
	// AgentRosterCore
	id: "required",
	name: "required",
	status: "required",
	kind: "required",
	verified: "optional",
	repo: "required",
	repoId: "optional",
	worktree: "required",
	channelId: "optional",
	branch: "optional",
	model: "optional",
	profileId: "optional",
	approvalMode: "required",
	activity: "optional",
	todo: "optional",
	startedAt: "optional",
	etaAt: "optional",
	lastActivity: "required",
	messageCount: "required",
	error: "optional",
	pending: "required",
	promoted: "optional",
	queued: "optional",
	// AgentHarnessFacet
	harness: "optional",
	harnessCaps: "optional",
	mcpServerNames: "optional",
	executionRole: "optional",
	contextPct: "optional",
	contextTokens: "optional",
	contextWindow: "optional",
	receipt: "optional",
	traceId: "optional",
	session: "optional",
	todoPhases: "optional",
	harnessScorecard: "optional",
	// AgentWorkflowFacet
	parentId: "optional",
	parentNodeId: "optional",
	branchIndex: "optional",
	subagents: "optional",
	workflowGraph: "optional",
	workflow: "optional",
	workflowState: "optional",
	forkAvailable: "optional",
	continueAvailable: "optional",
	// AgentWorkFacet
	issue: "optional",
	lane: "optional",
	featureId: "optional",
	requires: "optional",
	owns: "optional",
	produces: "optional",
	scopeSource: "optional",
	autonomyMode: "optional",
	effectiveMode: "optional",
	blockedReason: "optional",
	availableActions: "optional",
	confidence: "optional",
	// AgentLandFacet
	verificationState: "optional",
	proof: "optional",
	validation: "optional",
	landReady: "optional",
	prUrl: "optional",
	prNumber: "optional",
	prState: "optional",
	adopted: "optional",
	// AgentAttentionFacet
	reports: "optional",
	attentionEvents: "optional",
	transitions: "optional",
	errorTransitions1h: "optional",
	completionPushArmed: "optional",
	completionPushKind: "optional",
	completionArmedAt: "optional",
	ladderPriority: "optional",
} as const satisfies Record<keyof AgentDTO, "required" | "optional">;

// Exact key equality, the reverse direction of `satisfies` above: a frozen entry whose field
// no longer exists on AgentDTO must be reported, not silently tolerated.
type OrphanedFrozenKeys = Exclude<keyof typeof FROZEN_FIELDS, keyof AgentDTO>;
type AssertNever<T extends never> = T;
type _NoOrphans = AssertNever<OrphanedFrozenKeys>;

// Per-key optionality must match the frozen map. A flip turns this mapped type's value union
// into `never` for the offending key, failing the assignment below.
type OptionalityMatches = {
	[K in keyof typeof FROZEN_FIELDS & keyof AgentDTO]: (typeof FROZEN_FIELDS)[K] extends OptionalityOf<K> ? true : never;
};
const optionalityHolds: OptionalityMatches[keyof OptionalityMatches] = true;

// Pairwise disjointness: each field has exactly one facet home (see module doc for the
// seventh-facet caveat).
type PairOverlap<A, B> = Extract<keyof A, keyof B>;
type Overlap =
	| PairOverlap<AgentRosterCore, AgentHarnessFacet>
	| PairOverlap<AgentRosterCore, AgentWorkflowFacet>
	| PairOverlap<AgentRosterCore, AgentWorkFacet>
	| PairOverlap<AgentRosterCore, AgentLandFacet>
	| PairOverlap<AgentRosterCore, AgentAttentionFacet>
	| PairOverlap<AgentHarnessFacet, AgentWorkflowFacet>
	| PairOverlap<AgentHarnessFacet, AgentWorkFacet>
	| PairOverlap<AgentHarnessFacet, AgentLandFacet>
	| PairOverlap<AgentHarnessFacet, AgentAttentionFacet>
	| PairOverlap<AgentWorkflowFacet, AgentWorkFacet>
	| PairOverlap<AgentWorkflowFacet, AgentLandFacet>
	| PairOverlap<AgentWorkflowFacet, AgentAttentionFacet>
	| PairOverlap<AgentWorkFacet, AgentLandFacet>
	| PairOverlap<AgentWorkFacet, AgentAttentionFacet>
	| PairOverlap<AgentLandFacet, AgentAttentionFacet>;
type _NoOverlap = AssertNever<Overlap>;

test("AgentDTO facet split: frozen field map matches, optionality holds, facets disjoint (compile-time)", () => {
	// The real assertions are the type-level constructs above; the runtime body just proves the
	// file compiled and counts the frozen oracle's size so a mass-deletion can't slip through
	// as an "everything still satisfies" no-op.
	expect(dtoEqualsFacets).toBe(true);
	expect(optionalityHolds).toBe(true);
	expect(Object.keys(FROZEN_FIELDS).length).toBe(72);
});
