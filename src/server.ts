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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { ClientCommand, FeatureStage, IssueRef, SquadEvent } from "./types.ts";
import { worktreeDiff, worktreeTree } from "./explore.ts";
import { parsePlanConcerns } from "./features.ts";
import { listPlaneIssues } from "./plane.ts";
import { proofGate, runProof } from "./proof.ts";
import { detectVerify } from "./intake.ts";
import { all, claim, release, who } from "./presence.ts";
import { landAgent } from "./land.ts";
import { leasesFor } from "./leases.ts";
import { discoverRepos, planSpawn } from "./smart-spawn.ts";
import { gitState, pullLatest, reexecDaemon } from "./upgrade.ts";
import type { SquadManager } from "./squad-manager.ts";
import { requestToken, tokenOk } from "./auth.ts";
import type { PushPayload, PushService } from "./push.ts";
import type { AgentDTO, AgentStatus } from "./types.ts";

const INDEX_HTML = path.join(import.meta.dir, "web", "index.html");
const WEB_DIR = path.join(import.meta.dir, "web");
/** Files served without a token so the PWA can install + bootstrap before sign-in. */
const PUBLIC_ASSETS: Record<string, string> = {
	"/manifest.webmanifest": "application/manifest+json",
	"/sw.js": "text/javascript; charset=utf-8",
	"/icon.svg": "image/svg+xml",
	"/icon-192.png": "image/png",
	"/icon-512.png": "image/png",
	"/icon-maskable-512.png": "image/png",
};

interface SocketData {
	id: number;
}

export interface SquadServerOptions {
	port?: number;
	hostname?: string;
	/** Bearer secret required on every /api request + the WS handshake. Omit to disable auth (loopback unit tests). */
	token?: string;
	/** Terminate TLS in-process (paths to PEM files). Omit to serve plain HTTP (e.g. behind `tailscale serve`). */
	tls?: { cert: string; key: string };
	/** Background Web Push registry; alerts fire when an agent needs a human. */
	push?: PushService;
}

/** Pure: a short, stable fingerprint of the served UI. Changes whenever index.html changes,
 *  letting connected tabs detect a post-upgrade asset change and self-refresh. */
export function computeUiVersion(html: string): string {
	return createHash("sha256").update(html).digest("hex").slice(0, 12);
}

/** Pure: does this status transition warrant a human-attention push, and with what payload? */
export function escalationPayload(prev: AgentStatus | undefined, a: AgentDTO, seeded: boolean): PushPayload | null {
	if (!seeded || prev === undefined || prev === a.status) return null;
	if (a.status !== "input" && a.status !== "error") return null;
	const title = a.status === "input" ? `⛔ ${a.name} needs you` : `⚠ ${a.name} errored`;
	const body = a.status === "input" ? a.pending[0]?.title ?? "waiting for input" : a.error ?? "agent error";
	return { title, body, url: `/#/agent/${a.id}`, tag: a.id };
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
	/** agentId → last status seen, so a push fires only on the transition into a blocking state. */
	private readonly lastStatus = new Map<string, AgentStatus>();
	/** agentId → last push epoch ms, throttling repeat alerts. */
	private readonly lastPush = new Map<string, number>();
	/** seeded after the first roster so a reconnect replay never alerts in bulk. */
	private pushSeeded = false;
	/** Fingerprint of the served UI at boot; sent on every roster so stale tabs self-refresh after an upgrade. */
	private uiVersion = "";

	constructor(manager: SquadManager, opts: SquadServerOptions = {}) {
		this.manager = manager;
		this.opts = opts;
		this.onEvent = (e: SquadEvent) => this.broadcast(e);
	}

	get url(): string {
		const host = this.opts.hostname ?? "127.0.0.1";
		const scheme = this.opts.tls ? "https" : "http";
		return `${scheme}://${host}:${this.server?.port ?? this.opts.port ?? 0}`;
	}

	start(): string {
		for (const a of this.manager.list()) this.startupAgentIds.add(a.id);
		const manager = this.manager;
		const clients = this.clients;
		const indexFile = Bun.file(INDEX_HTML);
		this.uiVersion = computeUiVersion(readFileSync(INDEX_HTML, "utf8"));

		this.server = Bun.serve<SocketData>({
			port: this.opts.port ?? 7878,
			hostname: this.opts.hostname ?? "127.0.0.1",
			tls: this.opts.tls ? { cert: Bun.file(this.opts.tls.cert), key: Bun.file(this.opts.tls.key) } : undefined,
			fetch: async (req, server) => {
				const url = new URL(req.url);
				if (url.pathname === "/ws") {
					if (this.opts.token && !tokenOk(requestToken(req), this.opts.token)) return new Response("unauthorized", { status: 401 });
					if (server.upgrade(req, { data: { id: ++this.sockSeq } })) return undefined;
					return new Response("websocket upgrade failed", { status: 426 });
				}
				if (url.pathname === "/" || url.pathname === "/index.html") {
					return new Response(indexFile, { headers: { "content-type": "text/html; charset=utf-8" } });
				}
				const asset = PUBLIC_ASSETS[url.pathname];
				if (asset) return new Response(Bun.file(path.join(WEB_DIR, url.pathname.slice(1))), { headers: { "content-type": asset } });
				// Auth gate. Public bootstrap surface (the SPA shell, plus the manifest / service
				// worker / icons added just above this in the static block) loads without a token so
				// the PWA can install and prompt for it; everything under /api requires the token.
				if (this.opts.token && !tokenOk(requestToken(req), this.opts.token)) return new Response("unauthorized", { status: 401 });
				if (url.pathname === "/api/auth/check") return Response.json({ ok: true });
				if (url.pathname === "/api/push/key") return Response.json({ publicKey: this.opts.push?.publicKey ?? "" });
				if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
					if (!this.opts.push) return new Response("push unavailable", { status: 501 });
					const sub: unknown = await req.json().catch(() => null);
					if (!sub || typeof sub !== "object" || !("endpoint" in sub) || typeof sub.endpoint !== "string") return new Response("invalid subscription", { status: 400 });
					if (!("keys" in sub) || typeof sub.keys !== "object" || !sub.keys) return new Response("invalid subscription", { status: 400 });
					const keys = sub.keys;
					if (!("p256dh" in keys) || typeof keys.p256dh !== "string" || !("auth" in keys) || typeof keys.auth !== "string") return new Response("invalid subscription", { status: 400 });
					await this.opts.push.subscribe({ endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
					return Response.json({ ok: true });
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
						const dto = await manager.create({ repo, name, task: body.task.trim(), featureId: id, approvalMode: "yolo", track: true });
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
				if (url.pathname === "/api/version") return Response.json({ version: this.uiVersion });
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
						const dto = await manager.create({ ...plan, track: true });
						return Response.json({ agent: dto, plan });
					} catch (err) {
						return new Response(err instanceof Error ? err.message : String(err), { status: 409 });
					}
				}
				const mt = url.pathname.match(/^\/api\/agents\/([^/]+)\/transcript$/);
				if (mt) return Response.json(manager.getTranscript(decodeURIComponent(mt[1])));
				const msub = url.pathname.match(/^\/api\/agents\/([^/]+)\/subagents$/);
				if (msub) return Response.json(manager.subagents(decodeURIComponent(msub[1])));
				const mrec = url.pathname.match(/^\/api\/agents\/([^/]+)\/receipts$/);
				if (mrec) return Response.json(await manager.receipts(decodeURIComponent(mrec[1])));
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
					const force = !!(body && typeof body === "object" && "force" in body && body.force === true);
					if (!force) {
						const reason = await proofGate(dto.repo, dto.worktree, dto.branch);
						if (reason) return Response.json({ ok: false, committed: false, merged: false, message, detail: reason }, { status: 409 });
					}
					const busy = dto.status === "working" || dto.status === "starting" || dto.status === "input";
					const result = await landAgent({ repo: dto.repo, worktree: dto.worktree, branch: dto.branch, message, commitWip: !busy });
					if (result.ok) void manager.closeLandedIssue(dto.issue); // landed ⇒ close its tracking issue (idempotent, best-effort)
					return Response.json(result);
				}
				const mverify = url.pathname.match(/^\/api\/agents\/([^/]+)\/verify$/);
				if (mverify && req.method === "POST") {
					const dto = manager.getAgent(decodeURIComponent(mverify[1]));
					if (!dto) return new Response("no such agent", { status: 404 });
					const command = await detectVerify(dto.repo);
					if (!command) return new Response("no acceptance command detected for this repo", { status: 422 });
					const proof = await runProof({ repo: dto.repo, worktree: dto.worktree, command });
					return Response.json(proof);
				}
				const mfverify = url.pathname.match(/^\/api\/features\/([^/]+)\/verify$/);
				if (mfverify && req.method === "POST") {
					const out = await manager.verifyFeature(decodeURIComponent(mfverify[1]));
					return out ? Response.json(out) : new Response("no such feature", { status: 404 });
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
						const dto = await manager.create({ ...cmd.options, track: true });
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
					ws.send(JSON.stringify({ type: "roster", agents: manager.list(), version: this.uiVersion } satisfies SquadEvent));
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
		// Stamp the live UI version onto roster snapshots (manager-emitted ones leave it blank).
		const s = JSON.stringify(e.type === "roster" ? { ...e, version: this.uiVersion } : e);
		for (const ws of this.clients) {
			try {
				ws.send(s);
			} catch {
				/* dropped client */
			}
		}
		this.maybePushAlert(e);
		if (e.type === "agent" || e.type === "removed" || e.type === "roster") this.schedulePresence();
	}

	/** Fire a background push when an agent transitions into a state that needs a human. Mirrors the
	 *  client's seed-then-notify guard so a reconnect/roster replay never alerts in bulk. */
	private maybePushAlert(e: SquadEvent): void {
		const push = this.opts.push;
		if (!push) return;
		if (e.type === "roster") {
			for (const a of e.agents) this.lastStatus.set(a.id, a.status);
			this.pushSeeded = true;
			return;
		}
		if (e.type !== "agent") return;
		const a = e.agent;
		const prev = this.lastStatus.get(a.id);
		this.lastStatus.set(a.id, a.status);
		const payload = escalationPayload(prev, a, this.pushSeeded);
		if (!payload) return;
		const now = Date.now();
		if (now - (this.lastPush.get(a.id) ?? 0) < 3000) return;
		this.lastPush.set(a.id, now);
		void push.notify(payload);
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
