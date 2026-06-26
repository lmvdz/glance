#!/usr/bin/env bun
/**
 * Thin entry for a detached agent-host process (kept separate from index.ts so a
 * host doesn't load the daemon/TUI/server module graph). Launched by RpcAgent:
 *   bun agent-host-main.ts --id <id> --cwd <dir> --socket <path> [--model --approval --thinking --append-system-prompt --bin]
 */

import { runAgentHost } from "./agent-host.ts";
import type { ApprovalMode, ThinkingLevel } from "./types.ts";

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const id = flag("id");
const cwd = flag("cwd");
const socket = flag("socket");
if (!id || !cwd || !socket) {
	process.stderr.write("agent-host: --id, --cwd, --socket are required\n");
	process.exit(1);
}

await runAgentHost({
	id,
	cwd,
	socket,
	model: flag("model"),
	approvalMode: flag("approval") as ApprovalMode | undefined,
	thinking: flag("thinking") as ThinkingLevel | undefined,
	appendSystemPrompt: flag("append-system-prompt"),
	bin: flag("bin"),
});
process.exit(0);
