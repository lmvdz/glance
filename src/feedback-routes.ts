/**
 * Authenticated Feedback Loop REST routes — extracted from the server god-file's handle()
 * chain. Owns everything under /api/feedback/* that runs AFTER auth + manager resolution
 * (the public widget submit + widget.js stay in server.ts: they are pre-auth and need the
 * server's rate limiter). Returns undefined when the request isn't a feedback route.
 */

import type { Actor } from "./types.ts";
import type { SquadManager } from "./squad-manager.ts";

export async function handleFeedbackRoutes(url: URL, req: Request, manager: SquadManager, actor: Actor): Promise<Response | undefined> {
	if (url.pathname === "/api/feedback/campaigns" && req.method === "GET") return Response.json(await manager.listFeedbackCampaigns());
	if (url.pathname === "/api/feedback/campaigns" && req.method === "POST") {
		const body: unknown = await req.json().catch(() => null);
		if (!body || typeof body !== "object") return new Response("campaign body required", { status: 400 });
		if (!("name" in body) || typeof body.name !== "string" || !("repo" in body) || typeof body.repo !== "string" || !("token" in body) || typeof body.token !== "string") return new Response("name, repo, token required", { status: 400 });
		const allowedOrigins = "allowedOrigins" in body && Array.isArray(body.allowedOrigins) ? body.allowedOrigins.filter((x): x is string => typeof x === "string") : undefined;
		const rewardCents = "rewardCents" in body && typeof body.rewardCents === "number" ? body.rewardCents : undefined;
		const rewardCurrency = "rewardCurrency" in body && typeof body.rewardCurrency === "string" ? body.rewardCurrency : undefined;
		const id = "id" in body && typeof body.id === "string" ? body.id : undefined;
		return Response.json(await manager.seedFeedbackCampaign({ id, name: body.name, repo: body.repo, token: body.token, allowedOrigins, rewardCents, rewardCurrency }));
	}
	if (url.pathname === "/api/feedback/items" && req.method === "GET") return Response.json(await manager.listFeedbackItems());
	const mfitem = url.pathname.match(/^\/api\/feedback\/items\/([^/]+)(?:\/(.+))?$/);
	if (mfitem) {
		const id = decodeURIComponent(mfitem[1]);
		const action = mfitem[2] ?? "";
		try {
			if (!action && req.method === "GET") {
				const list = await manager.listFeedbackItems();
				const item = list.raw.find((x) => x.id === id);
				return item ? Response.json(item) : new Response("feedback item not found", { status: 404 });
			}
			if (action === "validate" && req.method === "POST") {
				const body: unknown = await req.json().catch(() => ({}));
				const input = body && typeof body === "object" ? {
					respondent: "respondent" in body ? body.respondent : undefined,
					vote: "vote" in body ? body.vote : undefined,
					wouldUse: "wouldUse" in body ? body.wouldUse : undefined,
					pain: "pain" in body ? body.pain : undefined,
					note: "note" in body ? body.note : undefined,
				} : {};
				return Response.json(await manager.addFeedbackValidation(id, input, actor));
			}
			if (action === "reward/approve" && req.method === "POST") return Response.json(await manager.approveFeedbackReward(id, actor));
			if (action === "reward/void" && req.method === "POST") return Response.json(await manager.voidFeedbackReward(id, actor));
			if (action === "reward/mark-paid" && req.method === "POST") {
				const body: unknown = await req.json().catch(() => ({}));
				const provider = body && typeof body === "object" && "provider" in body && typeof body.provider === "string" && ["manual", "stripe", "tremendous"].includes(body.provider) ? body.provider : undefined;
				const externalRef = body && typeof body === "object" && "externalRef" in body && typeof body.externalRef === "string" ? body.externalRef : undefined;
				return Response.json(await manager.markFeedbackRewardPaid(id, { provider, externalRef }, actor));
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return new Response(message, { status: /not found/.test(message) ? 404 : 400 });
		}
	}
	return undefined;
}
