import { useState } from "react";
import type { SquadState } from "@/hooks/useSquad";
import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api";
import { agentColorVar } from "@/lib/status";
import { AgentDetail } from "@/components/agent/AgentDetail";

/**
 * The browser omp console — talk to a live omp agent like the terminal. Starting a chat spawns a
 * plain conversational agent (POST /api/console); the conversation reuses AgentDetail (transcript +
 * steering composer + answer controls). Free-standing agents (no Plane issue / feature / workflow)
 * are the "conversations" you can resume.
 */
export function ConsoleView({ squad }: { squad: SquadState }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const chats = squad.agents.filter((a) => !a.issue && !a.featureId);
  const selected = selectedId ? (squad.agents.find((a) => a.id === selectedId) ?? null) : null;

  const startChat = async (): Promise<void> => {
    if (!draft.trim()) return;
    setBusy(true);
    const r = await apiPost<{ agentId: string }>("/api/console", { message: draft.trim() });
    setBusy(false);
    if (r) {
      setSelectedId(r.agentId);
      setDraft("");
    }
  };

  if (selected) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <Button size="sm" variant="ghost" onClick={() => setSelectedId(null)}>
            ← Console
          </Button>
          <span className="min-w-0 truncate text-sm text-text-muted">{selected.name}</span>
        </div>
        <div className="min-h-0 flex-1">
          <AgentDetail agent={selected} squad={squad} />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-4 overflow-y-auto p-6">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">Console</h1>
        <p className="text-sm text-text-muted">Talk to an omp agent in this repo — the terminal experience, in the browser.</p>
      </div>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void startChat();
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder="Ask omp anything…  (⌘↵ to start)"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void startChat();
            }
          }}
          className="w-full rounded-[var(--radius-sm)] border border-border bg-secondary px-3 py-2 text-sm text-text-1 outline-none focus:border-accent"
        />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="sm" disabled={busy || !draft.trim()}>
            {busy ? "Starting…" : "Start chat"}
          </Button>
        </div>
      </form>
      {chats.length > 0 ? (
        <div>
          <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-text-muted">Conversations</h2>
          <ul className="flex flex-col gap-0.5">
            {chats.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => setSelectedId(a.id)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-hover">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: agentColorVar(a.status) }} />
                  <span className="min-w-0 flex-1 truncate text-text-primary">{a.name}</span>
                  {a.activity ? <span className="min-w-0 max-w-[50%] truncate text-xs text-text-muted">{a.activity}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
