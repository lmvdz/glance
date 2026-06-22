/**
 * agent-host — a detached, per-agent supervisor that outlives the daemon.
 *
 * It owns the `omp --mode rpc` child (holding its stdio) and exposes a Unix
 * domain socket. The daemon's RpcAgent connects as a client. Because the host is
 * spawned detached (setsid + unref), it survives a daemon restart/upgrade — so
 * the agent keeps running with full in-flight context, and the relaunched daemon
 * just reconnects.
 *
 * Wire protocol over the socket (newline-delimited JSON), bidirectional:
 *   host → client : omp stdout frames forwarded verbatim, plus control frames
 *                   `{"__sq":"meta", ready, pid, exited}`.
 *   client → host : omp RPC commands forwarded verbatim to omp stdin, plus
 *                   control `{"__sq":"shutdown"}` (terminate omp + host).
 * On connect the host sends a meta frame then replays its ring buffer, so a
 * reconnecting daemon rebuilds the agent's state.
 *
 * UDS chosen over TCP loopback (~3x lower local latency, bidirectional) and over
 * tmux pane-scraping (we keep omp's structured JSON-RPC frames).
 */

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Socket } from "bun";
import type { ApprovalMode, ThinkingLevel } from "./types.ts";

export interface AgentHostOptions {
	id: string;
	cwd: string;
	socket: string;
	model?: string;
	approvalMode?: ApprovalMode;
	thinking?: ThinkingLevel;
	bin?: string;
}

const RING_MAX = 4000;
const SQ_SHUTDOWN = '{"__sq":"shutdown"}';


/** Directory holding one Unix socket per live agent host. */
export function squadSocketDir(): string {
	return path.join(os.homedir(), ".omp", "squad", "sockets");
}

/** Deterministic socket path for an agent id (so discovery on restart is just a connect). */
export function socketPathFor(id: string): string {
	return path.join(squadSocketDir(), `${id}.sock`);
}
interface ClientState {
	buf: string;
}

/** True if an agent host is accepting connections on its socket (used to discover survivors). */
export async function hostAlive(socket: string): Promise<boolean> {
	try {
		const s = await Bun.connect<undefined>({ unix: socket, socket: { data: () => {}, close: () => {}, error: () => {} } });
		s.end();
		return true;
	} catch {
		return false;
	}
}

/** Remove socket files whose host no longer responds; returns the pruned paths. */
export async function pruneStaleSockets(): Promise<string[]> {
	const dir = squadSocketDir();
	let entries: string[];
	try {
		entries = await fsp.readdir(dir);
	} catch {
		return [];
	}
	const pruned: string[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".sock")) continue;
		const p = path.join(dir, entry);
		if ((await hostAlive(p)) === false) {
			await fsp.rm(p, { force: true });
			pruned.push(p);
		}
	}
	return pruned;
}

/** Tell a host to terminate (kills its omp child; the host then exits and removes its own socket). */
async function shutdownHost(socket: string): Promise<void> {
	try {
		const s = await Bun.connect<undefined>({ unix: socket, socket: { data: () => {}, close: () => {}, error: () => {} } });
		s.write(`${SQ_SHUTDOWN}\n`);
		await Bun.sleep(100); // let the host read the frame + kill omp before we drop the connection
		s.end();
	} catch {
		/* host vanished between the liveness check and connect */
	}
}

/**
 * Reap agent-hosts no longer referenced by the live roster. A LIVE orphan (host still serving its
 * socket but no daemon agent owns it — left by a crash, a re-exec, or a re-spawn under a fresh id)
 * is shut down over the wire; a DEAD socket file is removed. Returns the reaped ids. Without this,
 * detached hosts accumulate across cycles (observed: dozens of phantom omp processes at load 160).
 *
 * `liveIds` MUST contain every current/starting agent id — an agent is added to the roster before
 * its host spawns, so a just-spawned agent is never reaped. A workflow run's inner thread lives at
 * `<id>-wf`; it is kept iff its owner `<id>` is live.
 * ponytail: graceful shutdown over the existing protocol — no SIGKILL / pid bookkeeping.
 */
export async function reapOrphanHosts(liveIds: Set<string>, dir = squadSocketDir()): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fsp.readdir(dir);
	} catch {
		return [];
	}
	const reaped: string[] = [];
	await Promise.all(
		entries.map(async (entry) => {
			if (!entry.endsWith(".sock")) return;
			const id = entry.slice(0, -".sock".length);
			const owner = id.endsWith("-wf") ? id.slice(0, -"-wf".length) : id;
			if (liveIds.has(owner)) return;
			const p = path.join(dir, entry);
			if (await hostAlive(p)) {
				await shutdownHost(p);
				reaped.push(id);
			} else {
				await fsp.rm(p, { force: true });
			}
		}),
	);
	return reaped;
}

/** Run the host until the omp child exits. Resolves on exit (process should then exit). */
export async function runAgentHost(opts: AgentHostOptions): Promise<void> {
	const args = ["--mode", "rpc", "--cwd", opts.cwd];
	if (opts.model) args.push("--model", opts.model);
	if (opts.approvalMode) args.push("--approval-mode", opts.approvalMode);
	if (opts.thinking) args.push("--thinking", opts.thinking);
	// Squad agents participate in soft file leasing (claim on edit, ⚠ on conflict).
	args.push("-e", path.join(import.meta.dir, "lease-hook.ts"));

	const proc = Bun.spawn([opts.bin ?? "omp", ...args], {
		cwd: opts.cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PI_RPC_EMIT_TITLE: "0" },
	});

	let ready = false;
	let exited: number | false = false;
	const ring: string[] = [];
	const clients = new Map<Socket<ClientState>, ClientState>();

	const meta = (): string => JSON.stringify({ __sq: "meta", ready, pid: proc.pid, exited });

	const broadcast = (line: string): void => {
		ring.push(line);
		if (ring.length > RING_MAX) ring.shift();
		for (const [sock] of clients) {
			try {
				sock.write(`${line}\n`);
			} catch {
				/* dropped */
			}
		}
	};

	await fsp.mkdir(path.dirname(opts.socket), { recursive: true });
	await fsp.rm(opts.socket, { force: true }).catch(() => {});

	const server = Bun.listen<ClientState>({
		unix: opts.socket,
		socket: {
			open: (sock) => {
				const state: ClientState = { buf: "" };
				clients.set(sock, state);
				sock.data = state;
				try {
					sock.write(`${meta()}\n`);
					for (const line of ring) sock.write(`${line}\n`);
				} catch {
					/* client vanished */
				}
			},
			data: (sock, chunk) => {
				const state = clients.get(sock);
				if (!state) return;
				state.buf += chunk.toString();
				let nl: number;
				while ((nl = state.buf.indexOf("\n")) >= 0) {
					const line = state.buf.slice(0, nl).trim();
					state.buf = state.buf.slice(nl + 1);
					if (!line) continue;
					if (line === SQ_SHUTDOWN || line.includes('"__sq":"shutdown"')) {
						proc.kill();
						continue;
					}
					try {
						proc.stdin.write(`${line}\n`);
						proc.stdin.flush();
					} catch {
						/* omp gone */
					}
				}
			},
			close: (sock) => {
				clients.delete(sock);
			},
		},
	});

	// Opportunistic GC: a freshly-started host prunes any dead sibling sockets
	// (its own is now live, so hostAlive() spares it).
	void pruneStaleSockets().catch(() => []);

	// Pump omp stdout → ring + clients; detect readiness.
	void (async () => {
		const decoder = new TextDecoder();
		let buf = "";
		try {
			for await (const chunk of proc.stdout) {
				buf += decoder.decode(chunk, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line) continue;
					if (!ready && line.includes('"type":"ready"')) {
						ready = true;
						broadcast(meta());
					}
					broadcast(line);
				}
			}
		} catch {
			/* stream ended */
		}
	})();

	const code = await proc.exited;
	exited = code ?? 0;
	broadcast(meta());
	server.stop();
	await fsp.rm(opts.socket, { force: true }).catch(() => {});
}

