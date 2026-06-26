/** Subsequence score: lower = better; -1 = no match. Penalizes gaps between matched chars. */
export function subseqScore(text: string, q: string): number {
  let from = 0;
  let score = 0;
  let last = -1;
  for (const ch of q) {
    const idx = text.indexOf(ch, from);
    if (idx < 0) return -1;
    score += idx - last - 1;
    last = idx;
    from = idx + 1;
  }
  return score;
}

/** Filter + rank items by a query against their label; empty query keeps input order (capped). */
export function fuzzyRank<T>(items: T[], q: string, label: (t: T) => string, cap = 50): T[] {
  const s = q.trim().toLowerCase();
  if (!s) return items.slice(0, cap);
  const scored: { item: T; score: number }[] = [];
  for (const it of items) {
    const sc = subseqScore(label(it).toLowerCase(), s);
    if (sc >= 0) scored.push({ item: it, score: sc });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, cap).map((x) => x.item);
}
