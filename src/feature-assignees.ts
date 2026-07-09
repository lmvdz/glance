/**
 * Feature assignees — the human "who owns this feature" list, and the substrate for plan voting
 * (a later vote is majority-of-all-assignees). Identity strings are `db:<userId>` in DB mode and
 * the single operator identity (e.g. `local`) in file mode.
 *
 * This module holds the mode-aware VALIDATION the server applies to a PUT so it's unit-testable
 * and reusable by the later vote units (which count votes over exactly this assignee set).
 */

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
