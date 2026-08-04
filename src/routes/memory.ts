/**
 * Memory-lane observability routes (plans/deepen-modules/05, slice 1) — the durable teaching
 * surfaces' read side, moved verbatim from server.ts's handle() chain: answers, after-action
 * reports, symptom search/browse, weekly episodes, and the horizon×reliability curve. This is
 * the SECOND lane adapter at the route seam (feedback-routes.ts was the first), which is what
 * makes routes/table.ts a real seam by the two-adapter rule.
 *
 * Every incident-bought comment moved with its route. All routes here are GETs at the authz.ts
 * viewer floor; repo scoping stays actor-derived (attentionVisibleRepos) exactly as inline —
 * a foreign `?repo=` reads as "nothing", never as another tenant's data.
 */
import { computeHorizonCurve, samplesFromReceipts } from "../horizon-curve.ts";
import { rankKbDocs, type EpisodeMeta, type KbDoc, type SymptomEntry, type SymptomSearchHit } from "../memory/index.ts";
import { normalizeRepoPath } from "../project-registry.ts";
import type { SquadManager } from "../squad-manager.ts";
import type { Actor } from "../types.ts";
import { boundedNumber, dispatchRoutes, type Route, type RouteContext } from "./table.ts";

/** Actor-derived repo scoping shared by symptom/episode reads: a `?repo=` outside the visible
 *  set yields nothing, and no param means "everything visible", never "everything on the
 *  manager" (batch-2 review discipline, same as /api/fog). */
function scopedRepos(ctx: RouteContext): string[] {
	const visible = ctx.manager.attentionVisibleRepos(ctx.actor);
	const repoParam = ctx.url.searchParams.get("repo");
	return repoParam ? (visible.has(normalizeRepoPath(repoParam)) ? [repoParam] : []) : [...visible];
}

const MEMORY_ROUTES: readonly Route[] = [
	// R5: answers are a deliverable, not a transcript. They outlive the roster row that produced
	// them, which is the single most common way a glance result used to evaporate — the agent
	// reaped before anyone read what it found.
	{
		method: "GET",
		pattern: "/api/answers",
		handler: async ({ manager, actor, url }) => Response.json(await manager.visibleAnswers(actor, url.searchParams.get("repo") ?? undefined)),
	},
	{
		method: "GET",
		pattern: /^\/api\/answers\/(.*)$/,
		handler: async ({ manager, actor }, [id]) => {
			const answer = await manager.visibleAnswer(id!, actor);
			return answer ? Response.json(answer) : new Response("no such answer", { status: 404 });
		},
	},
	// After-action reports mirror answers: durable post-mortems that outlive the (auto-reaped)
	// roster row of the terminal unit that earned them — see memory/after-action.ts.
	{
		method: "GET",
		pattern: "/api/after-action",
		handler: async ({ manager, actor }) => Response.json(await manager.visibleAfterActions(actor)),
	},
	{
		method: "GET",
		pattern: /^\/api\/after-action\/(.*)$/,
		handler: async ({ manager, actor }, [id]) => {
			const report = await manager.visibleAfterAction(id!, actor);
			return report ? Response.json(report) : new Response("no such after-action report", { status: 404 });
		},
	},
	// `glance symptom <query>` (comprehension concern 07): ranking stays server-side, reusing
	// fabric-search's BM25 core (`rankKbDocs`) over symptom+whereToLook text rather than forking
	// a second scorer. An empty/missing `q` returns no results (never the unranked full list) —
	// ranking never degrades to an unranked dump. Browsing is a SEPARATE, explicit contract:
	// `?browse=1` (no `q`) returns the newest entries by `landedAt` under the same actor-visible
	// repo scoping, so the webapp can show recurring failure modes without the operator having
	// to already know what to search for (Fog view's symptom list).
	{
		method: "GET",
		pattern: "/api/symptoms",
		handler: async (ctx) => {
			const { manager, url } = ctx;
			const repos = scopedRepos(ctx);
			const q = url.searchParams.get("q") ?? "";
			const topK = boundedNumber(url.searchParams.get("topK"), 20, 1, 100);
			if (url.searchParams.get("browse") === "1" && !q.trim()) {
				if (repos.length === 0) return Response.json({ symptoms: [] as SymptomEntry[] });
				const all = (await Promise.all(repos.map((r) => manager.symptoms(r)))).flat();
				return Response.json({ symptoms: all.sort((a, b) => b.landedAt - a.landedAt).slice(0, topK) });
			}
			if (!q.trim() || repos.length === 0) return Response.json({ query: q, results: [] as SymptomSearchHit[] });
			const all = (await Promise.all(repos.map((r) => manager.symptoms(r)))).flat();
			const docs: KbDoc[] = all.map((s) => ({ type: "symptom", id: s.id, title: s.symptom, text: `${s.symptom} ${s.whereToLook.join(" ")}`, repo: s.repo, ts: s.landedAt }));
			const byId = new Map(all.map((s) => [s.id, s]));
			const results: SymptomSearchHit[] = rankKbDocs(docs, q, { topK })
				.map((r) => {
					const entry = byId.get(r.id);
					return entry ? { id: entry.id, symptom: entry.symptom, whereToLook: entry.whereToLook, repo: entry.repo, fixedBy: entry.fixedBy, landedAt: entry.landedAt, score: r.score } : undefined;
				})
				.filter((r): r is SymptomSearchHit => r !== undefined);
			return Response.json({ query: q, results });
		},
	},
	// Weekly episodes: metadata list (never full markdown — that's the :id route below), same
	// actor-derived repo scoping as /api/fog and /api/symptoms (fail closed on a foreign ?repo=).
	{
		method: "GET",
		pattern: "/api/episodes",
		handler: async (ctx) => {
			const repos = scopedRepos(ctx);
			const all = (await Promise.all(repos.map((r) => ctx.manager.episodes(r)))).flat();
			const episodes: EpisodeMeta[] = all.sort((a, b) => b.isoWeek.localeCompare(a.isoWeek));
			return Response.json({ episodes });
		},
	},
	// Full markdown for one episode. `repo` is REQUIRED here (unlike the list route's optional
	// filter): an isoWeek id alone isn't globally unique, only unique per repo, so there is no
	// "search every visible repo" fallback — a missing/foreign repo reads as "unknown repo"
	// rather than silently picking one.
	{
		method: "GET",
		pattern: /^\/api\/episodes\/(.*)$/,
		handler: async ({ manager, actor, url }, [id]) => {
			const visible = manager.attentionVisibleRepos(actor);
			const repoParam = url.searchParams.get("repo");
			if (!repoParam || !visible.has(normalizeRepoPath(repoParam))) return new Response("unknown repo", { status: 400 });
			const episode = await manager.episode(repoParam, id!);
			return episode ? Response.json(episode) : new Response("no such episode", { status: 404 });
		},
	},
	// Horizon × reliability curve (CS329A borrow #2, plans/deepen-modules/15): the largest task
	// size the fleet completes at 50%/80% reliability, computed from validated-land receipts
	// only — the module documents the honest-coverage contract (abstains and verdict-less runs
	// are disclosed, never guessed). Viewer-readable like the other observability reads.
	{
		method: "GET",
		pattern: "/api/horizon",
		handler: async ({ manager }) => {
			const { samples, coverage } = samplesFromReceipts(await manager.allReceipts());
			return Response.json(computeHorizonCurve(samples, coverage));
		},
	},
];

/** The memory lane's route adapter — one call from handle(), undefined = fall through. */
export async function handleMemoryRoutes(url: URL, req: Request, manager: SquadManager, actor: Actor): Promise<Response | undefined> {
	return dispatchRoutes(MEMORY_ROUTES, { url, req, manager, actor });
}
