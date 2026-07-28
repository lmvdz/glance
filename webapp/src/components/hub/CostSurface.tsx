import React, { useEffect, useMemo, useState } from 'react';
import { apiJson } from '../../lib/api';
import {
  NOTHING_OPTIMISES_FOR_THIS,
  WHERE_COST_SPEAKS,
  floorCaveat,
  formatUsd,
  headline,
  spendBought,
  totals,
  wasteLines,
  whatThisCannotSee,
  worthItSentence,
  type CostReceipt,
} from '../../lib/costSurface';

/**
 * CostSurface — the money screen from `04-beyond.html`.
 *
 * It replaces the old fleet-economics view, which was three tables of Key / Runs / Units / Tokens /
 * Cost / Tools. That view answered "where did it go" six ways and never once answered the only
 * question a person opens a cost page with, which is whether any of it was wasted.
 *
 * The reference's structure is an argument, not a layout:
 *
 * - **One sentence at the top**, with the waste share in it. Not five stat tiles — a tile grid makes
 *   every number look equally worth acting on, and only one of them is.
 * - **Spend and waste in separate columns**, because they are separate ideas. Spend is what work
 *   costs; waste is what nothing costs.
 * - **Every waste line carries its cause.** A waste total without causes is an accusation.
 * - **"Is it worth it" refuses to price your time**, and says so in the words the reference uses.
 * - **A standing disclosure**: nothing here optimises for the number, and no agent has been told to
 *   spend less. A cost page that omits this invites the reader to assume the opposite.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

function Zone({ label, tone, children }: { label: string; tone?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: tone ?? '#5A5A61' }}>{label}</div>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

export function CostSurface() {
  const [receipts, setReceipts] = useState<CostReceipt[] | undefined>();
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    apiJson<{ runs?: CostReceipt[] }>('/api/usage?limit=1000')
      .then((payload) => { if (alive) setReceipts(payload.runs ?? []); })
      // A failed read is not an empty month. Saying "no spend" when the request died would be the
      // page inventing a fact — the same defect the waste rule exists to prevent.
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : 'the cost record could not be read'); });
    return () => { alive = false; };
  }, []);

  const t = useMemo(() => totals(receipts ?? []), [receipts]);
  const bought = useMemo(() => spendBought(receipts ?? []), [receipts]);
  const waste = useMemo(() => wasteLines(receipts ?? []), [receipts]);
  const caveat = floorCaveat(t);

  if (error) {
    return (
      <div className="flex h-full items-start justify-center px-6 pt-16" style={{ background: '#0A0A0B' }}>
        <div className="max-w-[560px]">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#C2704A' }}>THE COST RECORD COULD NOT BE READ</div>
          <div className="mt-2.5 text-[13px] leading-[1.6]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>
            {error}. This is a failed read, not an empty month — nothing here should be taken as a figure of zero.
          </div>
        </div>
      </div>
    );
  }

  if (!receipts) {
    return (
      <div className="flex h-full items-start px-6 pt-16" style={{ background: '#0A0A0B' }}>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#4A4A52' }}>reading the cost record…</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      <div className="mx-auto max-w-[1000px] px-8 py-9">
        <div className="flex items-baseline gap-4">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>
            THIS MONTH · REACHED FROM A COST CARD IN THE ROOM WHEN ONE FIRES, OR ⌘K
          </div>
        </div>

        {/* One sentence, with the only actionable share inside it. */}
        <div className="mt-3.5 text-[17px] leading-[1.5]" style={{ color: '#E8E8EA', textWrap: 'pretty', maxWidth: 720 }}>
          {headline(t)}
        </div>

        <div className="mt-3 text-[12.5px] leading-[1.55]" style={{ color: '#8A8A91', textWrap: 'pretty', maxWidth: 720 }}>
          Spend is what work costs. Waste is what nothing costs. They are counted separately because the first is the point
          and the second is the only part worth acting on.
        </div>

        {caveat ? (
          <div className="mt-3.5 px-3.5 py-2.5 text-[12.5px] leading-[1.5]" style={{ border: '1px solid #241A17', borderLeft: '2px solid #B4553A', background: '#100D0C', color: '#DEDEE2', textWrap: 'pretty', maxWidth: 720 }}>
            {caveat}
          </div>
        ) : null}

        <div className="mt-8 flex gap-8" style={{ borderTop: '1px solid #1F1F22', paddingTop: 22 }}>
          <div className="flex-1 min-w-0">
            <Zone label="WHAT THE SPEND BOUGHT">
              {bought.length === 0 ? (
                <div className="text-[12.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
                  Nothing yet — or everything recorded so far is on the waste list beside this, which would be worth reading first.
                </div>
              ) : (
                <div className="flex flex-col">
                  {bought.map((line) => (
                    <div key={line.key} className="flex items-baseline gap-3 py-2" style={{ borderTop: '1px solid #17171A' }}>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px]" style={{ color: '#DEDEE2' }}>{line.text}</div>
                        <div className="mt-[3px]" style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>{line.meta}</div>
                      </div>
                      <div className="flex-none" style={{ fontFamily: MONO, fontSize: 11, color: '#8A8A91' }}>
                        {line.costUsd > 0 ? formatUsd(line.costUsd) : 'unpriced'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Zone>
          </div>

          <div className="w-[380px] flex-none">
            <Zone label={t.wasteUsd > 0 ? `WASTE · ${formatUsd(t.wasteUsd)}, AND EVERY DOLLAR OF IT HAS A CAUSE` : 'WASTE'} tone="#C2704A">
              {waste.length === 0 ? (
                <div className="text-[12.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
                  Nothing on this list. Two things put work here — a run that ended in an error, and work a review rejected —
                  and neither has happened in this window. It does not mean no effort was wasted, only that none of it is
                  visible in a receipt.
                </div>
              ) : (
                <div className="flex flex-col">
                  {waste.map((line) => (
                    <div key={line.key} className="py-2.5" style={{ borderTop: '1px solid #17171A' }}>
                      <div className="flex items-baseline gap-3">
                        <div className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: '#DEDEE2' }}>{line.text}</div>
                        <div className="flex-none" style={{ fontFamily: MONO, fontSize: 11, color: '#C2704A' }}>
                          {line.costUsd > 0 ? formatUsd(line.costUsd) : 'unpriced'}
                        </div>
                      </div>
                      {/* The cause is the point of the line, not a tooltip on it. */}
                      <div className="mt-[3px] text-[11.5px] leading-[1.45]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>{line.cause}</div>
                      <div className="mt-[2px] truncate" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>{line.meta}</div>
                    </div>
                  ))}
                </div>
              )}
            </Zone>
          </div>
        </div>

        <div className="mt-8" style={{ borderTop: '1px solid #1F1F22', paddingTop: 22 }}>
          <Zone label="IS IT WORTH IT — THE ONLY HONEST WAY WE CAN PUT IT">
            <div className="text-[13px] leading-[1.55]" style={{ color: '#DEDEE2', textWrap: 'pretty', maxWidth: 720 }}>
              {worthItSentence(t)}
            </div>
            <div className="mt-3 text-[12.5px] leading-[1.55]" style={{ color: '#8A8A91', textWrap: 'pretty', maxWidth: 720 }}>
              {NOTHING_OPTIMISES_FOR_THIS}
            </div>
          </Zone>
        </div>

        <div className="mt-8 flex gap-8" style={{ borderTop: '1px solid #1F1F22', paddingTop: 22 }}>
          <div className="flex-1 min-w-0">
            <Zone label="WHERE COST APPEARS OUTSIDE THIS PAGE">
              <div className="flex flex-col">
                {WHERE_COST_SPEAKS.map((entry) => (
                  <div key={entry.where} className="flex gap-3 py-2" style={{ borderTop: '1px solid #17171A' }}>
                    <div className="mt-[7px] h-[5px] w-[5px] flex-none rounded-full" style={{ background: '#3E5C8A' }} />
                    <div className="flex-1">
                      <div className="text-[12.5px]" style={{ color: '#DEDEE2' }}>{entry.where}</div>
                      <div className="mt-[3px] text-[11.5px] leading-[1.45]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>{entry.what}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Zone>
          </div>

          <div className="w-[380px] flex-none">
            {/* Absence gets its own zone. A page that stays quiet about what it cannot see implies it
                sees everything. */}
            <Zone label="WHAT THIS PAGE CANNOT SEE">
              <div className="flex flex-col gap-2">
                {whatThisCannotSee(t).map((line) => (
                  <div key={line} className="text-[11.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>{line}</div>
                ))}
              </div>
            </Zone>
          </div>
        </div>

        <div className="mt-8 flex gap-6" style={{ borderTop: '1px solid #1F1F22', paddingTop: 14, fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>
          <div>{t.runs} run{t.runs === 1 ? '' : 's'} recorded</div>
          <div>{t.units} unit{t.units === 1 ? '' : 's'}</div>
          {t.unpricedRuns > 0 ? <div style={{ color: '#8A6A45' }}>{t.unpricedRuns} unpriced</div> : null}
        </div>
      </div>
    </div>
  );
}
