/**
 * Feature assignees — the human "who owns this feature" list, and the substrate for plan voting
 * (a later vote is majority-of-all-assignees). Identity strings are `db:<userId>` in DB mode and
 * the single operator identity (e.g. `local`) in file mode.
 *
 * This module holds the mode-aware VALIDATION the server applies to a PUT so it's unit-testable
 * and reusable by the later vote units (which count votes over exactly this assignee set).
 */

import type { Actor } from "./types.ts";
import type { OrgMember } from "./org-admin.ts";

/** The identity string for an org member: the `db:<userId>` form the DB-mode actor also carries. */
export function orgMemberAssigneeId(member: OrgMember): string {
	return `db:${member.userId}`;
}

/**
 * DB mode: which of `requested` are NOT valid assignees for this org roster — i.e. not `db:<userId>`
 * of a current member. Returns the rejected ids in input order (empty ⇒ all valid). An empty
 * request is vacuously valid (an admin may clear the list).
 */
export function invalidOrgAssignees(requested: readonly string[], members: readonly OrgMember[]): string[] {
	const valid = new Set(members.map(orgMemberAssigneeId));
	return requested.filter((id) => !valid.has(id));
}

/**
 * File mode: the only valid assignee is the single operator identity — multi-user voting needs DB
 * mode. Returns the rejected ids (empty ⇒ all valid).
 */
export function invalidFileAssignees(requested: readonly string[], operatorId: string): string[] {
	return requested.filter((id) => id !== operatorId);
}

/**
 * Plan-vote membership predicate (the call/cast authz check) — mode-aware, shared by both the
 * `/plan-vote/call` and `/plan-vote/cast` route handlers so the two never drift.
 *
 * DB mode is strict: `actor.id` must literally be one of `assignees` (the `db:<userId>` form a
 * real session actor carries). No fallback — a non-member db actor 403s exactly as before.
 *
 * File mode has exactly one human — the operator — but every file-mode HTTP request resolves to a
 * bearer-token ROLE actor (`web:admin`/`web:operator`/`web:viewer`, see auth.ts's `actorForRole`),
 * never the operator's own identity (`operatorId`, e.g. the OS-derived `local`/username the default
 * assignee is seeded with). A literal `actor.id === assignee` match can therefore never happen for
 * the default-seeded assignee, and without this branch NOBODY could ever call or cast a vote in
 * file mode. So: an admin|operator-tier bearer actor IS the operator, and is authorized whenever
 * the operator identity itself is on the (snapshot) assignee list — regardless of the actor's own
 * literal role-derived id. A viewer-tier actor is never a member (read-only), and an assignee list
 * that does NOT include the operator (e.g. written directly through the manager, bypassing the
 * PUT-time file-mode restriction that normally confines it to the operator) still 403s, unchanged.
 */
export function isVoteAssignee(actor: Actor, assignees: readonly string[], opts: { dbMode: boolean; operatorId: string }): boolean {
	if (assignees.includes(actor.id)) return true;
	if (opts.dbMode) return false;
	return (actor.role === "admin" || actor.role === "operator") && assignees.includes(opts.operatorId);
}
