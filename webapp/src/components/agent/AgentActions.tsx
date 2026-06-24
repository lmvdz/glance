import { useState } from "react";
import type { AgentDTO } from "@/lib/dto";
import type { SquadState } from "@/hooks/useSquad";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { apiPost } from "@/lib/api";

export function AgentActions({ agent, squad }: { agent: AgentDTO; squad: SquadState }) {
  const { toast } = useToast();
  const [msg, setMsg] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [hi, setHi] = useState(-1); // -1 = live draft; >=0 = browsing prior sends

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    squad.send({ type: "prompt", id: agent.id, message: trimmed });
    setHistory((h) => [...h, trimmed]);
    setHi(-1);
    setMsg("");
  };

  const land = async () => {
    const res = await apiPost<{ ok?: boolean; detail?: string }>(
      `/api/agents/${encodeURIComponent(agent.id)}/land`,
      {},
    );
    toast({
      title: res?.ok ? "Landed" : "Land failed",
      description: res?.detail,
      tone: res?.ok ? "success" : "danger",
    });
  };

  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
      <form
        className="flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit(msg);
        }}
      >
        <textarea
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          rows={1}
          placeholder="Send a message or steer…"
          onKeyDown={(e) => {
            // Enter sends (Shift+Enter = newline); Cmd/Ctrl+Enter always sends. Up/Down recall prior sends.
            if (e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit(msg);
            } else if (e.key === "ArrowUp" && history.length > 0 && (msg === "" || hi >= 0)) {
              e.preventDefault();
              const ni = hi < 0 ? history.length - 1 : Math.max(0, hi - 1);
              setHi(ni);
              setMsg(history[ni]);
            } else if (e.key === "ArrowDown" && hi >= 0) {
              e.preventDefault();
              const ni = hi + 1;
              if (ni >= history.length) {
                setHi(-1);
                setMsg("");
              } else {
                setHi(ni);
                setMsg(history[ni]);
              }
            }
          }}
          className="min-h-[40px] flex-1 resize-none rounded-[var(--radius-sm)] border border-border bg-secondary px-3 py-2 text-sm text-text-1 outline-none focus:border-accent"
        />
        <Button type="submit" variant="primary" size="sm">
          Send
        </Button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => squad.send({ type: "interrupt", id: agent.id })}>
          Interrupt
        </Button>
        <Button size="sm" variant="secondary" onClick={() => squad.send({ type: "restart", id: agent.id })}>
          Restart
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void land()}>
          Land
        </Button>
        <Button size="sm" variant="danger" onClick={() => squad.send({ type: "kill", id: agent.id })}>
          Kill
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={() => squad.send({ type: "remove", id: agent.id, deleteWorktree: true })}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}
