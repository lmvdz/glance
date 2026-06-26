import { useTick } from "@/lib/tick";
import { cn } from "@/lib/cn";

// Braille spinner frames, ported from the SPA; advanced by the shared 120ms tick.
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ className }: { className?: string }) {
  const tick = useTick();
  return (
    <span aria-hidden="true" className={cn("text-warning", className)}>
      {SPIN[tick % SPIN.length]}
    </span>
  );
}
