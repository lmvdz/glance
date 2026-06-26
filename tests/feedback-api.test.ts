import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { hashCampaignToken } from "../src/feedback.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { feedbackEnabled, SquadServer } from "../src/server.ts";

const saved = {
	feedback: process.env.OMP_SQUAD_FEEDBACK,
	max: process.env.OMP_SQUAD_FEEDBACK_MAX_IMAGE_BYTES,
	rate: process.env.OMP_SQUAD_FEEDBACK_RATE_LIMIT_PER_MIN,
};
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
	if (saved.feedback === undefined) delete process.env.OMP_SQUAD_FEEDBACK;
	else process.env.OMP_SQUAD_FEEDBACK = saved.feedback;
	if (saved.max === undefined) delete process.env.OMP_SQUAD_FEEDBACK_MAX_IMAGE_BYTES;
	else process.env.OMP_SQUAD_FEEDBACK_MAX_IMAGE_BYTES = saved.max;
	if (saved.rate === undefined) delete process.env.OMP_SQUAD_FEEDBACK_RATE_LIMIT_PER_MIN;
	else process.env.OMP_SQUAD_FEEDBACK_RATE_LIMIT_PER_MIN = saved.rate;
});

async function serverWithCampaign() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feedback-api-"));
	const store = new FileStore(dir);
	const manager = new SquadManager({ stateDir: dir, store });
	await manager.seedFeedbackCampaign({ id: "camp", name: "Beta", repo: "/repo/product", token: "secret", allowedOrigins: ["https://app.example"], rewardCents: 500, rewardCurrency: "USD" });
	const server = new SquadServer(manager, { port: 0, token: "admin" });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await manager.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	return { url, store, dir };
}

function payload(overrides: Record<string, unknown> = {}) {
	return {
		campaignId: "camp",
		token: "secret",
		kind: "bug",
		title: "Save button is hidden",
		description: "The primary action disappears below the fold.",
		metadata: { plan: "pro", veryLong: "x".repeat(800) },
		screenshotDataUrl: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
		...overrides,
	};
}

test("public feedback routes are disabled unless OMP_SQUAD_FEEDBACK=1", async () => {
	delete process.env.OMP_SQUAD_FEEDBACK;
	expect(feedbackEnabled()).toBe(false);
	const { url } = await serverWithCampaign();
	const res = await fetch(`${url}/api/feedback/items`, { method: "POST", body: JSON.stringify(payload()), headers: { "content-type": "application/json", origin: "https://app.example" } });
	expect(res.status).toBe(404);
});

test("valid public submission stores one item with campaign repo, reward pending, attachment hash and file", async () => {
	process.env.OMP_SQUAD_FEEDBACK = "1";
	process.env.OMP_SQUAD_FEEDBACK_MAX_IMAGE_BYTES = "100";
	const { url, store, dir } = await serverWithCampaign();
	const res = await fetch(`${url}/api/feedback/items`, { method: "POST", body: JSON.stringify(payload({ repo: "/evil" })), headers: { "content-type": "application/json", origin: "https://app.example" } });
	const json = await res.json();
	expect(res.status).toBe(201);
	expect(json.item.repo).toBe("/repo/product");
	expect(json.item.rewardStatus).toBe("pending");
	expect(json.item.metadata.veryLong.length).toBe(500);
	const snap = await store.loadFeedback();
	expect(snap.items).toHaveLength(1);
	expect(snap.items[0].attachment?.sha256).toBe(hashCampaignToken("png-bytes"));
	expect(snap.rewards).toHaveLength(1);
	expect(existsSync(path.join(dir, snap.items[0].attachment?.path ?? "missing"))).toBe(true);
});

test("bad public submissions fail without writing an item", async () => {
	process.env.OMP_SQUAD_FEEDBACK = "1";
	process.env.OMP_SQUAD_FEEDBACK_MAX_IMAGE_BYTES = "4";
	const { url, store } = await serverWithCampaign();
	const cases = [
		{ body: payload({ token: "wrong", screenshotDataUrl: undefined }), origin: "https://app.example" },
		{ body: payload({ screenshotDataUrl: undefined }), origin: "https://evil.example" },
		{ body: payload(), origin: "https://app.example" },
		{ body: payload({ campaignId: "missing", screenshotDataUrl: undefined }), origin: "https://app.example" },
	];
	for (const c of cases) {
		const res = await fetch(`${url}/api/feedback/items`, { method: "POST", body: JSON.stringify(c.body), headers: { "content-type": "application/json", origin: c.origin } });
		expect(res.status).toBeGreaterThanOrEqual(400);
	}
	expect((await store.loadFeedback()).items).toHaveLength(0);
});

test("public feedback enablement does not expose authenticated squad APIs", async () => {
	process.env.OMP_SQUAD_FEEDBACK = "1";
	const { url } = await serverWithCampaign();
	expect((await fetch(`${url}/api/agents`)).status).toBe(401);
});
