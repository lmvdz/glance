import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { OrgContext } from "../src/dal/context.ts";
import { DbStore, FileStore } from "../src/dal/store.ts";
import type { DbHandle } from "../src/db/index.ts";
import { openDatabase } from "../src/db/index.ts";
import { hashCampaignToken, normalizeFeedbackInput, summarizeFeedback, type FeedbackSnapshot } from "../src/feedback.ts";

let dir: string;
let handle: DbHandle;
let ctx: OrgContext;
const prevUrl = process.env.DATABASE_URL;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-feedback-"));
	process.env.DATABASE_URL = "sqlite::memory:";
	const h = await openDatabase();
	if (!h) throw new Error("openDatabase returned null in DB mode");
	handle = h;
	ctx = { db: handle.db, type: handle.type };
	for (const id of ["A", "B"]) {
		await handle.db
			.insertInto("organization")
			.values({ id, name: `Org ${id}`, slug: `org-${id.toLowerCase()}`, createdAt: new Date().toISOString() })
			.execute();
	}
});

afterAll(async () => {
	await handle.close();
	await fs.rm(dir, { recursive: true, force: true });
	if (prevUrl === undefined) delete process.env.DATABASE_URL;
	else process.env.DATABASE_URL = prevUrl;
});

function feedback(org: string): FeedbackSnapshot {
	return {
		campaigns: [
			{
				id: `campaign-${org}`,
				name: `Campaign ${org}`,
				repo: `/repo/${org}`,
				tokenHash: `hash-${org}`,
				allowedOrigins: ["https://example.com"],
				rewardCents: 500,
				rewardCurrency: "USD",
				createdAt: 10,
			},
		],
		items: [
			{
				id: `item-${org}`,
				campaignId: `campaign-${org}`,
				repo: `/repo/${org}`,
				kind: "bug",
				title: `Bug ${org}`,
				description: "broken button",
				metadata: { path: "/settings" },
				attachment: { id: `att-${org}`, kind: "screenshot", contentType: "image/png", bytes: 42, sha256: `sha-${org}` },
				status: "new",
				rewardStatus: "pending",
				createdAt: 11,
				updatedAt: 12,
			},
		],
		validations: [
			{
				id: `validation-${org}`,
				feedbackId: `item-${org}`,
				campaignId: `campaign-${org}`,
				repo: `/repo/${org}`,
				respondent: `reviewer-${org}`,
				vote: "valid",
				pain: 4,
				note: "reproduced",
				createdAt: 13,
			},
		],
		rewards: [
			{
				id: `reward-${org}`,
				feedbackId: `item-${org}`,
				campaignId: `campaign-${org}`,
				repo: `/repo/${org}`,
				amount: 500,
				currency: "USD",
				status: "approved",
				provider: "manual",
				reviewer: `reviewer-${org}`,
				createdAt: 14,
				updatedAt: 15,
			},
		],
	};
}

const dbStore = (org: string) => new DbStore(ctx, org, path.join(dir, `org-${org}`));

test("feedback helpers normalize input and summarize evidence", () => {
	expect(hashCampaignToken("secret")).toBe("2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b");
	const normalized = normalizeFeedbackInput({
		campaignId: " campaign-A ",
		repo: " /repo/A ",
		kind: "bug",
		title: " Broken save ",
		description: " Button does nothing ",
		metadata: { tries: 2, path: "/settings" },
	});
	expect(normalized).toMatchObject({ campaignId: "campaign-A", repo: "/repo/A", title: "Broken save", description: "Button does nothing", metadata: { tries: "2", path: "/settings" } });

	const snap = feedback("A");
	expect(summarizeFeedback(snap.items[0], snap.validations, snap.rewards[0])).toMatchObject({
		id: "item-A",
		rewardStatus: "approved",
		validationCount: 1,
		votes: { valid: 1, invalid: 0, unsure: 0 },
		averagePain: 4,
		hasAttachment: true,
	});
});

test("FileStore feedback survives missing file and round-trips feedback.json", async () => {
	const storeDir = path.join(dir, "file-store");
	const store = new FileStore(storeDir);
	expect(await store.loadFeedback()).toEqual({ campaigns: [], items: [], validations: [], rewards: [] });

	const snap = feedback("file");
	await store.saveFeedback(snap);

	expect(existsSync(path.join(storeDir, "feedback.json"))).toBe(true);
	expect(await store.loadFeedback()).toEqual(snap);
	expect(existsSync(path.join(storeDir, "state.json"))).toBe(false);
});

test("DbStore feedback is scoped by org", async () => {
	const a = feedback("A");
	const b = feedback("B");
	await dbStore("A").saveFeedback(a);
	await dbStore("B").saveFeedback(b);

	expect(await dbStore("A").loadFeedback()).toEqual(a);
	expect(await dbStore("B").loadFeedback()).toEqual(b);
	expect((await dbStore("A").loadFeedback()).items.map((item) => item.id)).not.toContain("item-B");

	const rows = await handle.db.selectFrom("feedback_items").select(["org_id", "id"]).orderBy("org_id").execute();
	expect(rows).toEqual([
		{ org_id: "A", id: "item-A" },
		{ org_id: "B", id: "item-B" },
	]);
});
