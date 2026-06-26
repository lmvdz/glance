import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { renderFeedbackPlaneIssue } from "../src/feedback.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { FeedbackItem, FeedbackReward, FeedbackValidationResponse } from "../src/types.ts";

const PLANE_ENV = ["PLANE_API_KEY", "PLANE_API_TOKEN", "PLANE_WORKSPACE", "PLANE_WORKSPACE_SLUG", "PLANE_PROJECT_MAP", "PLANE_BASE_URL", "PLANE_PROJECT_ID", "PLANE_APP_URL"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of PLANE_ENV) saved[k] = process.env[k];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
	for (const k of PLANE_ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

function item(): FeedbackItem {
	return {
		id: "fb-1",
		campaignId: "camp",
		repo: "/repo/product",
		kind: "bug",
		title: "Checkout breaks",
		description: "Clicking pay does nothing.",
		url: "https://app.example/checkout",
		userEmail: "user@example.com",
		browser: "Chrome",
		viewport: "1440x900",
		metadata: { plan: "pro" },
		attachment: { id: "att", kind: "screenshot", contentType: "image/png", bytes: 12, sha256: "abc", path: "feedback/attachments/fb-1/att.png" },
		status: "accepted",
		rewardStatus: "approved",
		createdAt: 1,
		updatedAt: 2,
	};
}

function validation(vote: FeedbackValidationResponse["vote"], pain: number): FeedbackValidationResponse {
	return { id: `v-${vote}-${pain}`, feedbackId: "fb-1", campaignId: "camp", repo: "/repo/product", respondent: `user-${pain}`, vote, pain, note: "confirmed", createdAt: pain };
}

test("renderer includes evidence, validation, reward, acceptance, verification, and scope sections", () => {
	const reward: FeedbackReward = { id: "r", feedbackId: "fb-1", campaignId: "camp", repo: "/repo/product", amount: 500, currency: "USD", status: "approved", createdAt: 1, updatedAt: 2 };
	const rendered = renderFeedbackPlaneIssue(item(), [validation("valid", 5), validation("invalid", 2)], reward);
	expect(rendered.title).toBe("[Feedback] Checkout breaks");
	for (const section of ["User Feedback", "Evidence", "Validation", "Acceptance Criteria", "Verification", "Scope Boundary"]) expect(rendered.descriptionHtml).toContain(section);
	expect(rendered.descriptionHtml).toContain("feedback/attachments/fb-1/att.png");
	expect(rendered.descriptionHtml).toContain("5.00 USD (approved)");
	expect(rendered.descriptionHtml).toContain("2 (1 valid, 1 invalid, 0 unsure)");
});

test("promotion creates one Plane issue, stores IssueRef, and is idempotent", async () => {
	let posts = 0;
	let seenBody: unknown;
	const plane = Bun.serve({
		port: 0,
		fetch: async (req) => {
			posts++;
			seenBody = await req.json();
			return Response.json({ id: "iss-1", name: "Feedback", sequence_id: 9, project_detail: { identifier: "OMPSQ" } }, { status: 201 });
		},
	});
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feedback-promo-"));
	cleanups.push(async () => {
		plane.stop(true);
		await fs.rm(dir, { recursive: true, force: true });
	});
	process.env.PLANE_API_KEY = "secret";
	process.env.PLANE_WORKSPACE = "acme";
	process.env.PLANE_BASE_URL = `http://127.0.0.1:${plane.port}`;
	process.env.PLANE_PROJECT_MAP = JSON.stringify({ "/repo/product": "proj-9" });
	const manager = new SquadManager({ stateDir: dir, store: new FileStore(dir) });
	await manager.seedFeedbackCampaign({ id: "camp", name: "Beta", repo: "/repo/product", token: "tok", allowedOrigins: ["*"] });
	const submitted = await manager.submitFeedbackItem({ campaignId: "camp", token: "tok", kind: "bug", title: "Checkout breaks", description: "Clicking pay does nothing." }, undefined);
	await manager.acceptFeedback(submitted.id);

	const first = await manager.promoteFeedback(submitted.id);
	const second = await manager.promoteFeedback(submitted.id);

	expect(posts).toBe(1);
	expect(first.status).toBe("promoted");
	expect(second.planeIssue?.identifier).toBe("OMPSQ-9");
	expect(seenBody && typeof seenBody === "object" && "description_html" in seenBody && typeof seenBody.description_html === "string" && seenBody.description_html.includes("Acceptance Criteria")).toBe(true);
});

test("rejected feedback cannot be promoted", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feedback-reject-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const manager = new SquadManager({ stateDir: dir, store: new FileStore(dir) });
	await manager.seedFeedbackCampaign({ id: "camp", name: "Beta", repo: "/repo/product", token: "tok", allowedOrigins: ["*"] });
	const submitted = await manager.submitFeedbackItem({ campaignId: "camp", token: "tok", kind: "bug", title: "Checkout breaks", description: "Clicking pay does nothing." }, undefined);
	await manager.rejectFeedback(submitted.id);
	await expect(manager.promoteFeedback(submitted.id)).rejects.toThrow("rejected feedback cannot be promoted");
});
