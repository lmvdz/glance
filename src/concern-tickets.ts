/**
 * Plan-concern → Plane-issue rendering + matching — extracted from the squad-manager
 * god-file. The HTML body a filed concern issue carries, and the fingerprint test that
 * stops a re-run from filing a duplicate.
 */

import type { IssueRef, PersistedFeature } from "./types.ts";
import type { PlanConcern } from "./features.ts";

export function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function htmlList(title: string, items: string[]): string {
	const clean = items.map((item) => item.trim()).filter(Boolean);
	if (!clean.length) return "";
	return `<h3>${escapeHtml(title)}</h3><ul>${clean.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

export function renderPlanConcernIssueHtml(feature: PersistedFeature, concern: PlanConcern): string {
	return [
		"<h2>Plan concern</h2>",
		`<p><strong>Feature:</strong> ${escapeHtml(feature.title)}</p>`,
		`<p><strong>Plan path:</strong> ${escapeHtml(concern.path)}</p>`,
		`<p><strong>Status:</strong> ${escapeHtml(concern.status)}</p>`,
		htmlList("Acceptance Criteria", concern.acceptanceCriteria),
		htmlList("Prerequisites", concern.prerequisites),
		htmlList("Touches", concern.touches),
		"<h3>Scope</h3>",
		`<p>Implement the concern described by <code>${escapeHtml(concern.path)}</code>. Keep plan text as context; repo instructions and operator prompts remain authoritative.</p>`,
	].filter(Boolean).join("\n");
}

export function planConcernTicketMatches(concern: PlanConcern, issue: IssueRef, body: string): boolean {
	return issue.name.trim() === concern.title.trim() && body.includes(concern.path);
}
