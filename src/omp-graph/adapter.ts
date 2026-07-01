/**
 * omp-graph adapter SDK — the pluggable-source contract.
 *
 * A SourceAdapter is the ONLY thing you write to bring a new data stream into the
 * living dashboard. Given a time range and a context, it emits normalized tracks
 * (schema.ts). git/receipts/automation are the first three; Stripe (MRR/ARR),
 * Google Calendar (meetings), a CRM (deals), Plane (issues) are just more of the
 * same interface. The renderer and compose layer never special-case any source.
 */

import type { GraphGroup, GraphTrack, TimeRange } from "./schema.ts";

/**
 * Everything an adapter might need to reach its source. Kept minimal, optional,
 * and app-agnostic (no app types leak into the SDK) so a host wires only what it
 * has; adapters MUST degrade to `[]` when their inputs are absent rather than
 * throw. App-specific adapters import their own data types directly.
 */
export interface AdapterContext {
	/** absolute repo path, for repo-scoped adapters (git). */
	repo?: string;
	/** the daemon state dir, for state-backed adapters (receipts, automation). */
	stateDir?: string;
	/** optional cap on how much an adapter should emit (marks/spans), for huge windows. */
	limit?: number;
	/**
	 * Per-adapter config/secrets, keyed by adapter id → { KEY: value } (all strings,
	 * so the SDK stays app-agnostic). External adapters (stripe, google, telegram) read
	 * their credentials here, e.g. `ctx.config?.stripe?.KEY`. The host populates it
	 * (the daemon reads OMP_GRAPH_<ADAPTER>_<KEY> env vars). Never logged.
	 */
	config?: Record<string, Record<string, string>>;
}

/** Convenience: read one config value for an adapter from a context. */
export function adapterConfig(ctx: AdapterContext, adapterId: string, key: string): string | undefined {
	return ctx.config?.[adapterId]?.[key];
}

/** A pluggable data source: range + context → normalized tracks. */
export interface SourceAdapter {
	/** stable id, e.g. "git" | "receipts" | "stripe". */
	id: string;
	/** human label for legend/provenance. */
	label: string;
	/** the group this adapter's tracks default under (tracks may still set their own group). */
	group: GraphGroup;
	/** produce this adapter's tracks for the window. Must tolerate missing data → []. */
	tracks(range: TimeRange, ctx: AdapterContext): Promise<GraphTrack[]>;
}
