import { ago } from "@/lib/time";
import { useNow } from "@/lib/tick";

// Live "<ago> ago" stamp; re-renders on the shared tick. `<time>` for a11y.
export function RelativeTime({ ts, suffix = " ago" }: { ts: number; suffix?: string }) {
  useNow(); // subscribe to the tick so the label refreshes
  const iso = Number.isFinite(ts) ? new Date(ts).toISOString() : undefined;
  return (
    <time dateTime={iso} className="tabular-nums">
      {ago(ts) + suffix}
    </time>
  );
}
