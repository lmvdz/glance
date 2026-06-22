/**
 * Rough completion-time estimate for an agent, from its progress rate.
 *
 * The only quantifiable signal we have is workflow progress (tasks/nodes done vs total) over elapsed
 * wall-clock. estimateEta assumes the remaining units take the average time of the completed ones — a
 * linear extrapolation. It's noisy early (one sample) and blind to uneven task sizes, so it's a HINT,
 * not a deadline. Returns ms remaining, or undefined when it can't be estimated.
 */

/** Estimated ms remaining; undefined when there's no progress yet, nothing to do, it's done, or no time elapsed. */
export function estimateEta(done: number, total: number, elapsedMs: number): number | undefined {
	if (done <= 0 || total <= 0 || done >= total || elapsedMs <= 0) return undefined;
	return Math.round((elapsedMs / done) * (total - done));
}
