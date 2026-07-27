/**
 * costSurface — spend and waste, counted separately.
 *
 * `04-beyond.html` states the whole design in two sentences: *"Spend is what work costs. Waste is what
 * nothing costs. They are counted separately because the first is the point and the second is the only
 * part worth acting on."* The old economics view counted neither — it had one `costUsd` column summed
 * three ways (by unit, by lane, by model), which tells you where money went and nothing about whether
 * any of it was wasted.
 *
 * Three rules the reference is explicit about, and this module enforces:
 *
 * 1. **Waste needs a cause.** The heading is *"WASTE · £312, AND EVERY POUND OF IT HAS A CAUSE"*. A run
 *    is only counted as waste when we can name why it bought nothing. A run that merely looks
 *    unproductive — no files touched, short duration — is NOT waste; review runs and read-only runs
 *    legitimately change nothing, and accusing them would make the number a guess.
 * 2. **An unpriced run is not a free run.** Receipts carry `costUsd` only when the harness reported it.
 *    Summing the ones that did and presenting it as the total is the exact defect this codebase keeps
 *    finding: absence read as an answer. When any run is unpriced the total is reported as a floor.
 * 3. **Nothing optimises for the number.** No agent has been told to spend less. The page says so,
 *    because a cost page that does not say it invites the reader to assume the opposite.
 */

export interface CostReceipt {
  agentId: string;
  name?: string;
  model?: string;
  lane?: string;
  branch?: string;
  status?: string;
  costUsd?: number;
  toolCalls?: number;
  durationMs?: number;
  startedAt?: number;
  endedAt?: number;
  filesTouched?: string[];
  tokens?: { total?: number } | number;
  validation?: { verdict?: string } | null;
}

export interface CostLine {
  key: string;
  text: string;
  meta: string;
  costUsd: number;
  /** Present only on waste: why this bought nothing. Never inferred. */
  cause?: string;
}

export interface CostTotals {
  spendUsd: number;
  wasteUsd: number;
  runs: number;
  units: number;
  /** Runs the harness never priced. The spend is a FLOOR while this is above zero. */
  unpricedRuns: number;
}

const money = (usd: number): string => (usd >= 100 ? `$${Math.round(usd).toLocaleString()}` : usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`);
export { money as formatUsd };

/**
 * Why a run bought nothing — or `undefined`, which means it is not waste.
 *
 * Deliberately narrow. Only two causes are visible in a receipt without guessing, and both are things
 * that HAPPENED rather than things that are missing: the run crashed, or the work it produced was
 * rejected. "Touched no files" is not on this list on purpose — see the module note.
 */
export function wasteCause(receipt: CostReceipt): string | undefined {
  if (receipt.status === 'error') return 'the run ended in an error, so nothing it did survived';
  const verdict = receipt.validation?.verdict;
  if (verdict === 'fail' || verdict === 'veto') return `review ${verdict === 'veto' ? 'vetoed' : 'rejected'} the work, so it was paid for and not used`;
  return undefined;
}

export function totals(receipts: readonly CostReceipt[]): CostTotals {
  let spendUsd = 0;
  let wasteUsd = 0;
  let unpricedRuns = 0;
  const units = new Set<string>();
  for (const receipt of receipts) {
    units.add(receipt.agentId);
    const cost = receipt.costUsd;
    if (cost === undefined || cost === null) unpricedRuns += 1;
    else {
      spendUsd += cost;
      if (wasteCause(receipt)) wasteUsd += cost;
    }
  }
  return { spendUsd, wasteUsd, runs: receipts.length, units: units.size, unpricedRuns };
}

/**
 * The headline. States the spend, what it bought, and the share that went nowhere — in that order,
 * because the last one is the only part worth acting on.
 */
export function headline(t: CostTotals): string {
  if (t.runs === 0) return 'Nothing has been recorded yet. This page fills in as work runs — it is not measuring zero, it has nothing to measure.';
  const floor = t.unpricedRuns > 0 ? 'at least ' : '';
  const spend = `${floor}${money(t.spendUsd)} of machine time`;
  const finished = `${t.units} unit${t.units === 1 ? '' : 's'} of work`;
  if (t.wasteUsd <= 0) return `${spend} across ${finished}, and none of it that we can see went nowhere.`;
  const share = t.spendUsd > 0 ? Math.round((t.wasteUsd / t.spendUsd) * 100) : 0;
  return `${spend} across ${finished}, and about ${share === 0 ? 'a fraction of a percent' : `${share}%`} of the spend went nowhere.`;
}

/**
 * The floor caveat, or nothing.
 *
 * Rendered as its own line rather than a footnote because a total that is silently partial is worse
 * than no total: the reader calibrates on it.
 */
export function floorCaveat(t: CostTotals): string | undefined {
  if (t.unpricedRuns === 0) return undefined;
  const all = t.unpricedRuns === t.runs;
  if (all) return `None of the ${t.runs} runs came back with a price — the harnesses driving them do not report one. This page can show you what ran and not what it cost.`;
  return `${t.unpricedRuns} of ${t.runs} runs came back without a price, so the figure above is a floor rather than a total. An unpriced run is not a free run.`;
}

/** What the spend bought, largest first. Work described by what it was, priced as a footnote. */
export function spendBought(receipts: readonly CostReceipt[], limit = 8): CostLine[] {
  const byUnit = new Map<string, { name: string; cost: number; runs: number; files: Set<string>; lane?: string; model?: string; wasted: boolean }>();
  for (const receipt of receipts) {
    const key = receipt.agentId;
    const entry = byUnit.get(key) ?? { name: receipt.name || receipt.agentId, cost: 0, runs: 0, files: new Set<string>(), lane: receipt.lane, model: receipt.model, wasted: false };
    entry.cost += receipt.costUsd ?? 0;
    entry.runs += 1;
    for (const file of receipt.filesTouched ?? []) entry.files.add(file);
    if (wasteCause(receipt)) entry.wasted = true;
    byUnit.set(key, entry);
  }
  return [...byUnit.entries()]
    .filter(([, entry]) => !entry.wasted)
    .sort((a, b) => b[1].cost - a[1].cost || a[1].name.localeCompare(b[1].name))
    .slice(0, limit)
    .map(([key, entry]) => ({
      key,
      text: entry.name,
      // What it touched, not how many tokens it moved: the file count is the closest thing a receipt
      // has to a description of the work.
      meta: entry.files.size > 0
        ? `${entry.runs} run${entry.runs === 1 ? '' : 's'} · ${entry.files.size} file${entry.files.size === 1 ? '' : 's'} changed`
        : `${entry.runs} run${entry.runs === 1 ? '' : 's'} · changed nothing on disk`,
      costUsd: entry.cost,
    }));
}

/** Waste, each line carrying the reason it is on this list. */
export function wasteLines(receipts: readonly CostReceipt[], limit = 8): CostLine[] {
  const lines: CostLine[] = [];
  for (const receipt of receipts) {
    const cause = wasteCause(receipt);
    if (!cause) continue;
    lines.push({
      key: `${receipt.agentId}:${receipt.startedAt ?? lines.length}`,
      text: receipt.name || receipt.agentId,
      meta: receipt.branch ? receipt.branch : (receipt.model ?? 'no branch recorded'),
      costUsd: receipt.costUsd ?? 0,
      cause,
    });
  }
  return lines.sort((a, b) => b.costUsd - a.costUsd).slice(0, limit);
}

/**
 * The honest answer to "is it worth it".
 *
 * The reference refuses to price the reader's own time — *"Whether that is worth it is your judgement —
 * we are not going to put a number on your afternoon."* — and this keeps that refusal, because the
 * moment the product prices an afternoon it has taken a position on how the reader should spend it.
 */
export function worthItSentence(t: CostTotals): string {
  if (t.runs === 0) return 'There is nothing to weigh yet.';
  const spend = `${t.unpricedRuns > 0 ? 'at least ' : ''}${money(t.spendUsd)}`;
  return `${t.units} unit${t.units === 1 ? '' : 's'} of work for ${spend}. Whether that is worth it is your judgement — we are not going to put a number on your afternoon.`;
}

/**
 * What this page deliberately cannot tell you.
 *
 * The reference gives absence its own zone (*"WHAT I LEFT OUT OF THIS"*) rather than letting a page
 * imply completeness by staying quiet. These are the specific things a receipt does not know.
 */
export function whatThisCannotSee(t: CostTotals): string[] {
  const out = [
    'Work that was paid for and then superseded by a later change is counted as spend, not waste — nothing in a receipt records that it was overtaken.',
    'A run that touched no files may have been a review or a read. It is not counted as waste, because we cannot tell those apart from a run that achieved nothing.',
  ];
  if (t.unpricedRuns > 0) out.push('Runs whose harness reports no price are counted in the run and unit figures and excluded from every money figure on this page.');
  return out;
}

/** The standing disclosure rule, stated on the page so the reader does not have to assume it. */
export const NOTHING_OPTIMISES_FOR_THIS =
  'Nothing in the product optimises for this number. No agent has ever been told to spend less, and none of them will choose a cheaper answer over a correct one — if that ever changes you should be told in a sentence, not discover it in a graph.';

/** Where cost is allowed to speak outside this page — the rule, not a setting. */
export const WHERE_COST_SPEAKS: Array<{ where: string; what: string }> = [
  { where: 'the room', what: 'one line, and only when waste moves — never a running total ticking in the corner' },
  { where: 'a unit that is about to spend unusually', what: 'the agent raises it in words, because the choice is yours and the cost changes it' },
  { where: 'a plan', what: 'what the plan has cost so far, shown only when a single proposed step is a large share of it' },
];
