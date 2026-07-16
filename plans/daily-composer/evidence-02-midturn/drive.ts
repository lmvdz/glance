/**
 * Mid-turn send-semantics live drive (plans/daily-composer/02).
 * Creates a fresh ephemeral console chat unit (harness claude-code, same as `glance here` /
 * the webapp composer's console lane), sends scenario-timed prompts over the SAME WebSocket
 * surface the webapp composer + IntervenceView steer use, and records:
 *   - every send with a wall-clock timestamp
 *   - agent dto.status changes (300ms poll)
 *   - transcript delta entries (300ms poll of GET /api/agents/:id/transcript?since=)
 * Output: /tmp/midturn/<scenario>.log.jsonl + <scenario>.transcript.json
 */

const BASE = "http://127.0.0.1:7997";
const TOKEN = await Bun.file("/tmp/glance-scratch-owAg/access-token").text().then((s) => s.trim());
const HDRS = { "content-type": "application/json", Authorization: `Bearer ${TOKEN}` };
const scenario = process.argv[2];
if (!scenario) throw new Error("usage: bun drive.ts <s1|s2|s3|s4>");

const t0 = Date.now();
const lines: string[] = [];
function log(kind: string, data: Record<string, unknown>): void {
  const rec = { t: Date.now() - t0, kind, ...data };
  lines.push(JSON.stringify(rec));
  console.log(`[+${(rec.t / 1000).toFixed(1)}s] ${kind} ${JSON.stringify(data).slice(0, 220)}`);
}

// ── session ──────────────────────────────────────────────────────────────────
// Pure-generation scenarios ride POST /api/console exactly like `glance here`. Tool-call
// scenarios (s2) mirror the same console-create options but add approvalMode:"yolo" (the
// scratch-daemon skill's prescribed mode for controlled runs) so the scripted `sleep` tool
// call doesn't stall on a permission gate with the supervisor off.
let agentId: string;
if (scenario === "s2" || scenario === "s0tool" || scenario === "s0long") {
  const res = await fetch(`${BASE}/api/command`, {
    method: "POST",
    headers: HDRS,
    body: JSON.stringify({ type: "create", options: { repo: "/tmp/midturn-target", name: "chat", harness: "claude-code", autoRoute: false, approvalMode: "yolo" } }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  agentId = ((await res.json()) as { id: string }).id;
} else {
  const createRes = await fetch(`${BASE}/api/console`, {
    method: "POST",
    headers: HDRS,
    body: JSON.stringify({ repo: "/tmp/midturn-target", harness: "claude-code", ephemeral: true }),
  });
  if (!createRes.ok) throw new Error(`console create failed: ${createRes.status} ${await createRes.text()}`);
  agentId = ((await createRes.json()) as { agentId: string }).agentId;
}
log("session", { agentId, scenario });

// ── websocket (composer-fidelity command channel) ────────────────────────────
const ws = new WebSocket(`ws://127.0.0.1:7997/ws`, ["ompsq-token", TOKEN]);
await new Promise<void>((res, rej) => {
  ws.onopen = () => res();
  ws.onerror = (e) => rej(new Error(`ws error ${String(e)}`));
});
ws.onmessage = () => {}; // we observe via HTTP polling; WS is the send path under test
function wsSend(cmd: Record<string, unknown>, label: string): void {
  ws.send(JSON.stringify(cmd));
  log("send", { label, cmd });
}

// ── observers ────────────────────────────────────────────────────────────────
let lastStatus = "";
let seenSeq = -1;
const textProgress = new Map<number, number>(); // seq -> chars already logged
let observing = true;
const observer = (async () => {
  while (observing) {
    try {
      type RosterRow = { id: string; status: string; activity?: string; error?: string; pending?: Array<{ id: string; kind?: string; title?: string; options?: string[] }> };
      const agents = (await (await fetch(`${BASE}/api/agents`, { headers: HDRS })).json()) as RosterRow[];
      const me = agents.find((a) => a.id === agentId);
      if (me && me.status !== lastStatus) {
        log("status", { from: lastStatus || "(new)", to: me.status, activity: me.activity, error: me.error });
        lastStatus = me.status;
      }
      // Log (never answer) any permission ask — the unit is created approvalMode:"yolo" per the
      // scratch-daemon skill, so none should arise; if one does, the scenario stalls visibly.
      for (const p of me?.pending ?? []) {
        log("pending", { requestId: p.id, kind: p.kind, title: p.title, options: p.options });
      }
      const entries = (await (await fetch(`${BASE}/api/agents/${agentId}/transcript?since=${seenSeq}`, { headers: HDRS })).json()) as Array<{ seq: number; role: string; text: string; status?: string; tool?: { name?: string } }>;
      for (const e of entries) {
        const prev = textProgress.get(e.seq) ?? 0;
        if (!textProgress.has(e.seq)) {
          log("entry", { seq: e.seq, role: e.role, status: e.status, tool: e.tool?.name, head: e.text.slice(0, 160) });
        } else if (e.text.length > prev || e.status !== "running") {
          log("entry-grow", { seq: e.seq, role: e.role, status: e.status, len: e.text.length, tail: e.text.slice(Math.max(prev, e.text.length - 120)) });
        }
        textProgress.set(e.seq, e.text.length);
        if (e.status !== "running" && e.seq > seenSeq) seenSeq = e.seq; // only advance past settled entries
      }
    } catch (err) {
      log("observer-error", { err: String(err) });
    }
    await Bun.sleep(300);
  }
})();

const sleep = (ms: number) => Bun.sleep(ms);
async function waitIdle(minQuietMs: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let quietSince = Date.now();
  let last = JSON.stringify([...textProgress.entries()]) + lastStatus;
  while (Date.now() - start < timeoutMs) {
    await sleep(500);
    const now = JSON.stringify([...textProgress.entries()]) + lastStatus;
    if (now !== last || lastStatus === "working" || lastStatus === "starting") {
      last = now;
      quietSince = Date.now();
    } else if (lastStatus === "idle" && Date.now() - quietSince >= minQuietMs) return;
  }
  log("waitIdle-timeout", { after: timeoutMs });
}

// wait for spawn → idle
await waitIdle(2_000, 90_000);
log("ready", { status: lastStatus });

const LONG_GEN = "Write a plain-prose story of about 600 words describing a day in the life of a lighthouse keeper on a remote island. No tools, no code blocks, no headings - just flowing prose, and do not stop early.";
const NUM_LIST = "Write out the numbers 1 through 150 as words (one, two, three, ...), one per line, as plain text in your reply. No tools, no code blocks - just the plain list, every single number, do not stop early and do not summarize.";

// ── scenarios ────────────────────────────────────────────────────────────────
if (scenario === "s0") {
  // control: the long-generation probe ALONE, no mid-turn send
  wsSend({ type: "prompt", id: agentId, message: LONG_GEN }, "A-long-generation-alone");
  await waitIdle(6_000, 180_000);
} else if (scenario === "s0num") {
  // control: the number-list probe alone (did s1's content-filter 400 come from the probe itself?)
  wsSend({ type: "prompt", id: agentId, message: NUM_LIST }, "A-number-list-alone");
  await waitIdle(6_000, 180_000);
} else if (scenario === "s0tool") {
  // control: a tool-call turn with NO mid-turn send (attributes any stuck-"running" tool entries)
  wsSend({ type: "prompt", id: agentId, message: "Use your shell tool to run exactly this command: sleep 10 && echo SLEEP_DONE . Wait for it to finish, then tell me its output verbatim." }, "A-tool-alone");
  await waitIdle(6_000, 180_000);
} else if (scenario === "s0long") {
  // control: ONE turn that takes >60s wall-clock, no mid-turn send — does the driver-side
  // session/prompt 60s timeout kill even a healthy single long turn?
  wsSend({ type: "prompt", id: agentId, message: "Use your shell tool to run exactly this command: sleep 75 && echo SLEEP_DONE . Wait for it to finish, then tell me its output verbatim." }, "A-75s-tool-alone");
  await waitIdle(6_000, 240_000);
} else if (scenario === "s1") {
  wsSend({ type: "prompt", id: agentId, message: LONG_GEN }, "A-long-generation");
  await sleep(4_000);
  wsSend({ type: "prompt", id: agentId, message: "NEW INSTRUCTION: stop writing the story immediately, wherever you are, and instead reply with exactly the single word PINEAPPLE." }, "B-midturn-send");
  await waitIdle(6_000, 180_000);
} else if (scenario === "s2") {
  wsSend({ type: "prompt", id: agentId, message: "Use your shell tool to run exactly this command: sleep 40 && echo SLEEP_DONE . Wait for it to finish, then tell me its output verbatim." }, "A-long-tool-call");
  await sleep(15_000); // let it reach the tool call (spawn->plan->tool takes a few seconds)
  wsSend({ type: "prompt", id: agentId, message: "While that command runs: also say the word MANGO in your next reply so I know you received this." }, "B-mid-tool-send");
  await waitIdle(6_000, 240_000);
} else if (scenario === "s3") {
  wsSend({ type: "prompt", id: agentId, message: LONG_GEN }, "A-long-generation");
  await sleep(3_000);
  wsSend({ type: "prompt", id: agentId, message: "Second message: include the word APPLE in your final reply." }, "B-rapid-1");
  await sleep(700);
  wsSend({ type: "prompt", id: agentId, message: "Third message: include the word BANANA in your final reply." }, "C-rapid-2");
  await sleep(700);
  wsSend({ type: "prompt", id: agentId, message: "Fourth message: include the word CHERRY in your final reply." }, "D-rapid-3");
  await waitIdle(6_000, 240_000);
} else if (scenario === "s4") {
  wsSend({ type: "prompt", id: agentId, message: LONG_GEN }, "A-long-generation");
  await sleep(4_000);
  // The webapp fires both through the same WS via sendConsoleCommand; steer (IntervenceView
  // diff-line comment) is steerCommand -> {type:"prompt"} with no clientTurnId. Chat send goes
  // FIRST here - the worst case for the "steer never queued behind chat" constraint.
  wsSend({ type: "prompt", id: agentId, message: "Chat message racing the steer: include the word DRAGONFRUIT in your reply.", clientTurnId: `turn:${Date.now()}:race`, displayText: "Chat message racing the steer: include the word DRAGONFRUIT in your reply." }, "B-chat-send");
  wsSend({ type: "prompt", id: agentId, message: "Re `README.md`, this changed line:\n\n    # midturn drive target\n\nSTEER: this heading is wrong - acknowledge this steer by saying STEER-RECEIVED." }, "C-steer-same-tick");
  await waitIdle(6_000, 240_000);
} else {
  throw new Error(`unknown scenario ${scenario}`);
}

// ── evidence dump ────────────────────────────────────────────────────────────
observing = false;
await observer;
const full = await (await fetch(`${BASE}/api/agents/${agentId}/transcript?since=-1`, { headers: HDRS })).json();
await Bun.write(`/tmp/midturn/${scenario}.transcript.json`, JSON.stringify(full, null, 2));
await Bun.write(`/tmp/midturn/${scenario}.log.jsonl`, lines.join("\n") + "\n");
log("done", { entries: (full as unknown[]).length });

// teardown this scenario's agent (fresh unit per scenario keeps context clean)
await fetch(`${BASE}/api/command`, { method: "POST", headers: HDRS, body: JSON.stringify({ type: "remove", id: agentId, deleteWorktree: false }) });
ws.close();
process.exit(0);
