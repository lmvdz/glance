#!/usr/bin/env bun
/**
 * omp-squad CLI.
 *
 *   omp-squad up [--port N] [--no-tui] [--restore]   start the daemon (server + TUI)
 *   omp-squad add <repo> [--name --branch --model --approval --task]
 *   omp-squad list
 *   omp-squad prompt <id> <message…>
 *   omp-squad rm <id> [--delete-worktree]
 *   omp-squad open
 *
 * `up` is the long-lived process that owns the agents. The other verbs are thin
 * HTTP clients that talk to a running daemon's REST surface.
 */

import { SquadServer } from "./server.ts";
import { SquadManager } from "./squad-manager.ts";
import { SquadTui } from "./tui.ts";
import type { AgentDTO, ApprovalMode, ClientCommand, CreateAgentOptions, ThinkingLevel } from "./types.ts";

const DEFAULT_PORT = Number(process.env.OMP_SQUAD_PORT ?? 7878);

const HELP = `omp-squad — manage a fleet of Oh My Pi agents across git worktrees

USAGE
  omp-squad up [--port N] [--no-tui] [--restore]   Start the daemon (web + TUI)
  omp-squad add <repo> [flags]                     Spawn an agent in a new worktree
  omp-squad list                                   Show the roster
  omp-squad prompt <id> <message...>               Send an instruction to an agent
  omp-squad rm <id> [--delete-worktree]            Remove an agent
  omp-squad open                                   Print the dashboard URL

ADD FLAGS
  --name <s>        Agent name (default: agent-N)
  --branch <s>      Worktree branch (default: squad/<name>)
  --model <s>       Model (fuzzy, e.g. opus / gpt-5.2)
  --approval <m>    always-ask | write | yolo (default: write)
  --thinking <l>    minimal | low | medium | high | xhigh (default: low)
  --task <s>        Initial instruction sent once the agent is ready

GLOBAL
  --port <N>        Daemon port (default: ${DEFAULT_PORT}, or $OMP_SQUAD_PORT)
`;

interface ParsedArgs {
	positional: string[];
	flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else {
			positional.push(a);
		}
	}
	return { positional, flags };
}

function base(flags: Record<string, string | boolean>): string {
	const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
	return `http://127.0.0.1:${port}`;
}

async function postCommand(flags: Record<string, string | boolean>, cmd: ClientCommand): Promise<Response> {
	try {
		return await fetch(`${base(flags)}/api/command`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(cmd),
		});
	} catch {
		throw new Error(`No squad daemon on ${base(flags)}. Start one with: omp-squad up`);
	}
}

async function cmdUp(args: string[]): Promise<void> {
	const { flags } = parseArgs(args);
	const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
	const manager = new SquadManager();
	await manager.start();
	if (flags.restore) {
		const n = await manager.loadPersisted();
		if (n) process.stderr.write(`restored ${n} agent(s)\n`);
	}
	const server = new SquadServer(manager, { port });
	const url = server.start();

	const shutdown = async () => {
		await manager.stop();
		server.stop();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	const useTui = !flags["no-tui"] && process.stdin.isTTY;
	if (useTui) {
		process.stdout.write(`omp-squad dashboard: ${url}\n`);
		const tui = new SquadTui(manager);
		await tui.run();
		await shutdown();
	} else {
		process.stdout.write(`omp-squad daemon running\n  dashboard: ${url}\n  add an agent: omp-squad add <repo> --task "…"\n`);
		await new Promise<void>(() => {}); // run until signal
	}
}

async function cmdAdd(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const repo = positional[0] ?? process.cwd();
	const options: CreateAgentOptions = { repo };
	if (typeof flags.name === "string") options.name = flags.name;
	if (typeof flags.branch === "string") options.branch = flags.branch;
	if (typeof flags.model === "string") options.model = flags.model;
	if (typeof flags.task === "string") options.task = flags.task;
	if (typeof flags.approval === "string") options.approvalMode = flags.approval as ApprovalMode;
	if (typeof flags.thinking === "string") options.thinking = flags.thinking as ThinkingLevel;

	const res = await postCommand(flags, { type: "create", options });
	if (!res.ok) {
		process.stderr.write(`add failed: ${res.status} ${await res.text()}\n`);
		process.exit(1);
	}
	const dto = (await res.json()) as AgentDTO;
	process.stdout.write(`spawned ${dto.name} [${dto.status}]\n  id: ${dto.id}\n  worktree: ${dto.worktree}\n`);
}

async function cmdList(args: string[]): Promise<void> {
	const { flags } = parseArgs(args);
	let agents: AgentDTO[];
	try {
		const res = await fetch(`${base(flags)}/api/agents`);
		agents = (await res.json()) as AgentDTO[];
	} catch {
		process.stderr.write(`No squad daemon on ${base(flags)}. Start one with: omp-squad up\n`);
		process.exit(1);
	}
	if (!agents.length) {
		process.stdout.write("no agents\n");
		return;
	}
	const rows = agents.map((a) => ({
		status: a.status,
		name: a.name,
		branch: a.branch ?? "—",
		activity: a.activity ?? a.todo?.active ?? "—",
		pend: a.pending.length ? `⛔${a.pending.length}` : "",
	}));
	const w = {
		status: Math.max(6, ...rows.map((r) => r.status.length)),
		name: Math.max(4, ...rows.map((r) => r.name.length)),
		branch: Math.max(6, ...rows.map((r) => r.branch.length)),
	};
	for (const r of rows) {
		process.stdout.write(
			`${r.status.padEnd(w.status)}  ${r.name.padEnd(w.name)}  ${r.branch.padEnd(w.branch)}  ${r.pend.padEnd(4)}  ${r.activity}\n`,
		);
	}
}

async function cmdPrompt(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0];
	const message = positional.slice(1).join(" ");
	if (!id || !message) {
		process.stderr.write("usage: omp-squad prompt <id> <message...>\n");
		process.exit(1);
	}
	const res = await postCommand(flags, { type: "prompt", id, message });
	process.stdout.write(res.ok ? "sent\n" : `failed: ${await res.text()}\n`);
}

async function cmdRm(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0];
	if (!id) {
		process.stderr.write("usage: omp-squad rm <id> [--delete-worktree]\n");
		process.exit(1);
	}
	const res = await postCommand(flags, { type: "remove", id, deleteWorktree: !!flags["delete-worktree"] });
	process.stdout.write(res.ok ? "removed\n" : `failed: ${await res.text()}\n`);
}

async function main(): Promise<void> {
	const [cmd, ...rest] = process.argv.slice(2);
	switch (cmd) {
		case undefined:
		case "up":
			await cmdUp(rest);
			break;
		case "add":
			await cmdAdd(rest);
			break;
		case "list":
		case "ls":
			await cmdList(rest);
			break;
		case "prompt":
		case "say":
			await cmdPrompt(rest);
			break;
		case "rm":
		case "remove":
			await cmdRm(rest);
			break;
		case "open": {
			const { flags } = parseArgs(rest);
			process.stdout.write(`${base(flags)}\n`);
			break;
		}
		case "help":
		case "-h":
		case "--help":
			process.stdout.write(HELP);
			break;
		default:
			process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
			process.exit(1);
	}
}

void main();
