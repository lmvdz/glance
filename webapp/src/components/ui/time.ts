/**
 * Compact relative-age formatter shared across the UI primitives, matching the
 * legacy panels' "12m" / "3h" / "2d" style.
 */
export function relativeAge(ts?: number, now = Date.now()): string {
  if (!ts) return '';
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}
