/**
 * SquadServer — HTTP + WebSocket bridge over a SquadManager.
 *
 * Wire protocol (JSON):
 *   server → client : SquadEvent (plus a `roster` snapshot on connect)
 *   client → server : ClientCommand
 *
 * The web dashboard and any remote viewer are just WS clients. (Federation
 * peers are a separate transport — see federation.ts — not this local server.)
 */

import * as path from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { ClientCommand, FeatureStage, IssueRef, SquadEvent } from "./types.ts";
import { worktreeDiff, worktreeTree } from "./explore.ts";
import { parsePlanConcerns } from "./features.ts";
import { listPlaneIssues } from "./plane.ts";
import { all, claim, release, who } from "./presence.ts";
import { landAgent } from "./land.ts";
import { leasesFor } from "./leases.ts";
import { discoverRepos, planSpawn } from "./smart-spawn.ts";
import { gitState, pullLatest, reexecDaemon } from "./upgrade.ts";
import type { SquadManager } from "./squad-manager.ts";

const INDEX_HTML = path.join(import.meta.dir, "web", "index.html");

interface SocketData {
	id: number;
}

export interface SquadServerOptions {
	port?: number;
	hostname?: string;
}

export class SquadServer {
	private readonly manager: SquadManager;
	private readonly clients = new Set<ServerWebSocket<SocketData>>();
	private server?: Server<SocketData>;
	private readonly opts: SquadServerOptions;
	private sockSeq = 0;
	private readonly onEvent: (e: SquadEvent) => void;
	private presenceTimer?: Timer;
	private presenceDebounce?: Timer;
	/** agentId → repo it's claimed under, so we can release the claim on removal. */
	private readonly claimed = new Map<string, string>();
	/** Agent ids present when the server booted = survivors the daemon reattached to (vs spawned later). */
	private readonly startupAgentIds = new Set<string>();

	constructor(manager: SquadManager, opts: SquadServerOptions = {}) {
		this.manager = manager;
		this.opts = opts;
		this.onEvent = (e: SquadEvent) => this.broadcast(e);
	}

	get url(): string {
		const host = this.opts.hostname ?? "127.0.0.1";
		return `http://${host}:${this.server?.port ?? this.opts.port ?? 0}`;
	}

	start(): string {
		for (const a of this.manager.list()) this.startupAgentIds.add(a.id);
		const manager = this.manager;
		const clients = this.clients;
		const indexFile = Bun.file(INDEX_HTML);

		this.server = Bun.serve<SocketData>({
			port: this.opts.port ?? 7878,
			hostname: this.opts.hostname ?? "127.0.0.1",
			fetch: async (req, server) => {
				const url = new URL(req.url);
				if (url.pathname === "/ws") {
					if (server.upgrade(req, { data: { id: ++this.sockSeq } })) return undefined;
					return new Response("websocket upgrade failed", { status: 426 });
				}
				if (url.pathname === "/" || url.pathname === "/index.html") {
					return new Response(indexFile, { headers: { "content-type": "text/html; charset=utf-8" } });
				}
				if (url.pathname === "/api/agents") return Response.json(manager.list());
				if (url.pathname === "/api/projects") return Response.json(manager.projects());
				if (url.pathname === "/api/features" && req.method === "GET") return Response.json(await manager.features(url.searchParams.get("repo") ?? undefined));
				if (url.pathname === "/api/features" && req.method === "POST") {
					const body: unknown = await req.json().catch(() => null);
					if (!body || typeof body !== "object" || !("title" in body) || typeof body.title !== "string") return new Response("title required", { status: 400 });
					const repo = "repo" in body && typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
					const planDir = "planDir" in body && typeof body.planDir === "string" ? body.planDir : undefined;
					manager.createFeature({ title: body.title, repo, planDir });
					return Response.json({ ok: true });
				}
				if (url.pathname === "/api/features/from-plan" && req.method === "POST") {
					const body: unknown = await req.json().catch(() => null);
					if (!body || typeof body !== "object" || !("planDir" in body) || typeof body.planDir !== "string") return new Response("planDir required", { status: 400 });
					const repo = "repo" in body && typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
					const title = "title" in body && typeof body.title === "string" && body.title.trim() ? body.title.trim() : path.basename(body.planDir);
					const pf = manager.createFeature({ title, repo, planDir: body.planDir });
					return Response.json(pf);
				}
				if (url.pathname === "/api/features/auto" && req.method === "POST") {
					const body: unknown = await req.json().catch(() => null);
					if (!body || typeof body !== "object" || !("goal" in body) || typeof body.goal !== "string" || !body.goal.trim()) return new Response("goal required", { status: 400 });
					const repo = "repo" in body && typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
					const title = "title" in body && typeof body.title === "string" && body.title.trim() ? body.title.trim() : body.goal.trim().slice(0, 48);
					const model = "model" in body && typeof body.model === "string" && body.model ? body.model : undefined;
					const { feature, agent } = await manager.createAutoFeature({ title, repo, goal: body.goal.trim(), model });
					return Response.json({ feature, agentId: agent.id });
				}
				const mfpatch = url.pathname.match(/^\/api\/features\/([^/]+)$/);
				if (mfpatch && req.method === "PATCH") {
					const body: unknown = await req.json().catch(() => null);
					const patch: { title?: string; stageOverride?: FeatureStage | null; archived?: boolean } = {};
					if (body && typeof body === "object") {
						if ("title" in body && typeof body.title === "string") patch.title = body.title;
						if ("archived" in body && typeof body.archived === "boolean") patch.archived = body.archived;
						if ("stageOverride" in body) patch.stageOverride = typeof body.stageOverride === "string" ? (body.stageOverride as FeatureStage) : null;
					}
					const pf = manager.updateFeature(decodeURIComponent(mfpatch[1]), patch);
					return pf ? Response.json(pf) : new Response("no such feature", { status: 404 });
				}
				const mflink = url.pathname.match(/^\/api\/features\/([^/]+)\/agents$/);
				if (mflink && req.method === "POST") {
					const id = decodeURIComponent(mflink[1]);
					const body: unknown = await req.json().catch(() => null);
					if (body && typeof body === "object" && "task" in body && typeof body.task === "string" && body.task.trim()) {
						const repo = "repo" in body && typeof body.repo === "string" && body.repo ? body.repo : process.cwd();
						const name = "name" in body && typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
						const dto = await manager.create({ repo, name, task: body.task.trim(), featureId: id, approvalMode: "yolo" });
						manager.linkAgent(id, dto.id);
						return Response.json({ agent: dto });
					}
					if (!body || typeof body !== "object" || !("agentId" in body) || typeof body.agentId !== "string") return new Response("agentId required", { status: 400 });
					const unlink = "unlink" in body && body.unlink === true;
					return Response.json({ ok: manager.linkAgent(id, body.agentId, unlink) });
				}
				const mfland = url.pathname.match(/^\/api\/features\/([^/]+)\/land$/);
				if (mfland && req.method === "POST") {
					const body: unknown = await req.json().catch(() => null);
					const force = !!(body && typeof body === "object" && "force" in body && body.force === true);
					return Response.json(await manager.landFeature(decodeURIComponent(mfland[1]), force));
				}
				const mftickets = url.pathname.match(/^\/api\/features\/([^/]+)\/tickets$/);
				if (mftickets && req.method === "GET") return Response.json(await manager.featurePlaneTickets(decodeURIComponent(mftickets[1])));
				const mfmodule = url.pathname.match(/^\/api\/features\/([^/]+)\/module$/);
				if (mfmodule && req.method === "POST") {
					const out = await manager.createFeatureModule(decodeURIComponent(mfmodule[1]));
					return out ? Response.json(out) : new Response("module create failed (Plane not configured?)", { status: 501 });
				}
				const mfpipe = url.pathname.match(/^\/api\/features\/([^/]+)\/pipeline$/);
				if (mfpipe && req.method === "GET") {
					const repo = url.searchParams.get("repo") ?? process.cwd();
					const list = await manager.features(repo);
					const f = list.find((x) => x.id === decodeURIComponent(mfpipe[1]));
					if (!f) return new Response("no such feature", { status: 404 });
					const concerns = f.planDir ? await parsePlanConcerns(f.repo, f.planDir) : [];
					const ids = f.issueIdentifiers;
					let issues: IssueRef[] = [];
					if (ids && ids.length) {
						const planeIssues = await listPlaneIssues(f.repo);
						if (planeIssues) issues = planeIssues.filter((i) => i.identifier !== undefined && ids.includes(i.identifier));
					}
					return Response.json({ concerns, issues, agentIds: f.agentIds });
				}
				if (url.pathname === "/api/info") return Response.json({ cwd: process.cwd() });
				if (url.pathname === "/api/health") return Response.json({ ok: true, agents: manager.list().length, projects: manager.projects().length, uptimeSec: Math.round(process.uptime()) });
				if (url.pathname === "/api/presence") {
					const repo = url.searchParams.get("repo");
					return Response.json(repo ? await who(repo) : await all());
				}
				if (url.pathname === "/api/leases") return Response.json(await leasesFor(url.searchParams.get("repo") ?? process.cwd()));
				if (url.pathname === "/api/spawn" && req.method === "POST") {
					const body: unknown = await req.json().catch(() => null);
					const prompt = body && typeof body === "object" && "prompt" in body && typeof body.prompt === "string" ? body.prompt.trim() : "";
					if (prompt.length === 0) return new Response("empty prompt", { status: 400 });
					const tracked = manager.projects().map((p) => p.repo);
					const plan = await planSpawn(prompt, { cwd: process.cwd(), candidates: discoverRepos(process.cwd(), tracked) });
					try {
						const dto = await manager.create(plan);
						return Response.json({ agent: dto, plan });
					} catch (err) {
						return new Response(err instanceof Error ? err.message : String(err), { status: 409 });
					}
				}
				const mt = url.pathname.match(/^\/api\/agents\/([^/]+)\/transcript$/);
				if (mt) return Response.json(manager.getTranscript(decodeURIComponent(mt[1])));
				const msub = url.pathname.match(/^\/api\/agents\/([^/]+)\/subagents$/);
				if (msub) return Response.json(manager.subagents(decodeURIComponent(msub[1])));
				const mcmd = url.pathname.match(/^\/api\/agents\/([^/]+)\/commands$/);
				if (mcmd) return Response.json(manager.commandsFor(decodeURIComponent(mcmd[1])) ?? []);
				const mdiff = url.pathname.match(/^\/api\/agents\/([^/]+)\/(diff|tree)$/);
				if (mdiff) {
					const dto = manager.getAgent(decodeURIComponent(mdiff[1]));
					if (!dto) return new Response("no such agent", { status: 404 });
					return Response.json(mdiff[2] === "diff" ? await worktreeDiff(dto.worktree) : await worktreeTree(dto.worktree));
				}
				const mland = url.pathname.match(/^\/api\/agents\/([^/]+)\/land$/);
				if (mland && req.method === "POST") {
					const dto = manager.getAgent(decodeURIComponent(mland[1]));
					if (!dto) return new Response("no such agent", { status: 404 });
					let message = `squad(${dto.name}): ${dto.issue?.name ?? "agent changes"}`;
					const body: unknown = await req.json().catch(() => null);
					if (body && typeof body === "object" && "message" in body && typeof body.message === "string" && body.message.trim()) {
						message = body.message.trim();
					}
					const busy = dto.status === "working" || dto.status === "starting" || dto.status === "input";
					const result = await landAgent({ repo: dto.repo, worktree: dto.worktree, branch: dto.branch, message, commitWip: !busy });
					return Response.json(result);
				}
				if (url.pathname === "/api/plane/issues") {
					const issues = await listPlaneIssues(url.searchParams.get("project") ?? "");
					if (issues === null) return new Response("plane not configured", { status: 501 });
					return Response.json(issues);
				}
				if (url.pathname === "/api/upgrade/status") return Response.json(await gitState(process.cwd()));
				if (url.pathname === "/api/upgrade" && req.method === "POST") {
					const repo = process.cwd();
					const pull = await pullLatest(repo);
					const after = await gitState(repo);
					// Detach agents (their hosts survive), free the port, and re-exec — the
					// relaunched daemon reconnects to the live agents with full context.
					setTimeout(() => {
						void (async () => {
							await manager.stop();
							this.server?.stop(true);
							reexecDaemon({ cmd: process.argv, cwd: repo });
							process.exit(0);
						})();
					}, 300);
					return Response.json({ ok: true, pull, git: after, restarting: true });
				}
				if (url.pathname === "/api/command" && req.method === "POST") {
					let cmd: ClientCommand;
					try {
						cmd = (await req.json()) as ClientCommand;
					} catch {
						return new Response("bad json", { status: 400 });
					}
					if (cmd.type === "create") {
						const dto = await manager.create(cmd.options);
						return Response.json(dto);
					}
					if (cmd.type === "commission") {
						const result = await manager.commission(cmd.spec, { install: true });
						return Response.json(result);
					}
					await manager.applyCommand(cmd);
					return Response.json({ ok: true });
				}
				return new Response("not found", { status: 404 });
			},
			websocket: {
				open: (ws) => {
					clients.add(ws);
					ws.send(JSON.stringify({ type: "roster", agents: manager.list() } satisfies SquadEvent));
					for (const a of manager.list()) {
						const commands = manager.commandsFor(a.id);
						if (commands?.length) ws.send(JSON.stringify({ type: "commands", id: a.id, commands } satisfies SquadEvent));
					}
				},
				close: (ws) => {
					clients.delete(ws);
				},
				message: (ws, raw) => {
					let cmd: ClientCommand;
					try {
						cmd = JSON.parse(typeof raw === "string" ? raw : raw.toString());
					} catch {
						return;
					}
					// Transcript replay is unicast to the requesting socket.
					if (cmd.type === "subscribe") {
						for (const entry of manager.getTranscript(cmd.id)) {
							ws.send(JSON.stringify({ type: "transcript", id: cmd.id, entry } satisfies SquadEvent));
						}
						return;
					}
					// All surfaces today are local; federation peers carry their own actor.
					void manager.applyCommand(cmd);
				},
			},
		});

		manager.on("event", this.onEvent);
		void this.syncPresence();
		this.presenceTimer = setInterval(() => void this.syncPresence(), 25_000);
		this.presenceTimer.unref?.();
		return this.url;
	}

	private broadcast(e: SquadEvent): void {
		const s = JSON.stringify(e);
		for (const ws of this.clients) {
			try {
				ws.send(s);
			} catch {
				/* dropped client */
			}
		}
		if (e.type === "agent" || e.type === "removed" || e.type === "roster") this.schedulePresence();
	}

	private schedulePresence(): void {
		if (this.presenceDebounce) return;
		this.presenceDebounce = setTimeout(() => {
			this.presenceDebounce = undefined;
			void this.syncPresence();
		}, 1500);
		this.presenceDebounce.unref?.();
	}

	/** Mirror live squad agents into the shared presence registry so `who` + the command center see them next to raw omp sessions. */
	private async syncPresence(): Promise<void> {
		const liveIds = new Set<string>();
		for (const a of this.manager.list()) {
			liveIds.add(a.id);
			this.claimed.set(a.id, a.repo);
			await claim({ repo: a.repo, agent: a.name, branch: a.branch, task: a.issue?.name ?? a.activity, source: "squad", id: a.id, reattached: this.startupAgentIds.has(a.id) });
		}
		for (const [id, repo] of this.claimed) {
			if (!liveIds.has(id)) {
				await release(id, repo);
				this.claimed.delete(id);
			}
		}
	}

	stop(): void {
		this.manager.off("event", this.onEvent);
		clearInterval(this.presenceTimer);
		clearTimeout(this.presenceDebounce);
		for (const [id, repo] of this.claimed) void release(id, repo);
		this.claimed.clear();
		this.server?.stop(true);
	}
}
