// Time/liveness helpers ported from src/web/index.html (the live SPA).

/** Working but silent longer than this = stalled (matches TUI / OMPSQ-5). */
export const STALL_MS = 120_000;

import type { AgentStatus } from "./dto";
export type { AgentStatus };

/** Compact relative age: "12s" / "3m" / "2h"; "—" for non-finite input. */
export function ago(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/** Compact duration of an elapsed span in ms: "4.2s" / "3m" / "1.5h"; "" for nullish. */
export function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return "";
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
}

/** A working agent that hasn't reported activity within STALL_MS. */
export function isStalled(a: { status: AgentStatus; lastActivity: number }, now: number): boolean {
  return a.status === "working" && now - a.lastActivity > STALL_MS;
}

/** Context-usage color var: red >90%, warning >70%, muted otherwise / unknown. */
export function ctxColor(p: number | null | undefined): string {
  return p == null
    ? "var(--text-2)"
    : p > 0.9
      ? "var(--danger)"
      : p > 0.7
        ? "var(--warning)"
        : "var(--text-2)";
}
