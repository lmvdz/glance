import React from 'react';
import { fetchFog, type FogPayload } from '../../lib/api';
import { ranked, tailNote, unseenHeadline, whyUnseen, type UnseenEntry } from '../../lib/unseenSurface';

/**
 * UnseenSurface — what has changed under you while you were not reading it.
 *
 * `05-first-week.html` gives absence its own screen and its own voice — **WHAT THIS PRODUCT DOES NOT
 * KNOW YET**, with the standing line *"Nothing pretends to be there before it is."* This is the same
 * idea pointed at the reader instead of the product.
 *
 * It replaces the Fog view, which drew the same data as a tri-state colour overlay on a folder tree
 * behind a 7d/14d/30d toggle. Every fact was in there and none of the meaning: a person had to learn
 * a legend, choose a window, and then work out for themselves which of six hundred files mattered.
 * The debt score is a ranking the machine can do; doing it is the product.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";
const STATE_TONE: Record<UnseenEntry['state'], string> = { 'never-seen': '#B4553A', stale: '#D9A03C', 'seen-current': '#3E7D57' };

export function UnseenSurface() {
  const [payload, setPayload] = React.useState<FogPayload | undefined>();
  const [error, setError] = React.useState('');
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    let alive = true;
    fetchFog()
      .then((next) => { if (alive) { setPayload(next); setNow(Date.now()); } })
      // A failed read is not an empty debt list. Rendering "nothing has changed under you" here would
      // be the screen telling a comfortable lie about what it knows.
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : 'the attention record could not be read'); });
    return () => { alive = false; };
  }, []);

  if (error) {
    return (
      <div className="overflow-y-auto px-8 py-9" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
        <div className="max-w-[620px]">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#C2704A' }}>THE ATTENTION RECORD COULD NOT BE READ</div>
          <div className="mt-2.5 text-[13px] leading-[1.6]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>
            {error}. Nothing about what you have or have not read should be taken from this screen right now.
          </div>
        </div>
      </div>
    );
  }
  if (!payload) {
    return <div className="px-8 py-9" style={{ background: '#0A0A0B', fontFamily: MONO, fontSize: 10.5, color: '#4A4A52' }}>reading what has moved since you last looked…</div>;
  }

  const entries = payload.entries as UnseenEntry[];
  const top = ranked(entries);
  const tail = tailNote(entries.length, top.length);

  return (
    <div className="h-full overflow-y-auto" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      <div className="mx-auto max-w-[900px] px-8 py-9">
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>WHAT HAS CHANGED UNDER YOU</div>

        <div className="mt-3.5 text-[17px] leading-[1.5]" style={{ color: '#E8E8EA', textWrap: 'pretty', maxWidth: 720 }}>
          {unseenHeadline({ entries, repoHasHistory: payload.repoHasHistory, disabled: payload.disabled })}
        </div>

        {top.length > 0 ? (
          <>
            <div className="mt-7" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>
              THE ONES CARRYING THE MOST · RANKED
            </div>
            <div className="mt-2.5 flex flex-col">
              {top.map((item) => (
                <div key={`${item.repo}:${item.file}`} className="flex gap-3 py-2.5" style={{ borderTop: '1px solid #17171A' }}>
                  <div className="mt-[7px] h-[5px] w-[5px] flex-none rounded-full" style={{ background: STATE_TONE[item.state] }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate" style={{ fontFamily: MONO, fontSize: 11.5, color: '#DEDEE2' }} title={`${item.repo}/${item.file}`}>{item.file}</div>
                    {/* The reason in words. A colour alone makes a reader learn a legend. */}
                    <div className="mt-[3px] text-[11.5px] leading-[1.45]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>{whyUnseen(item, now)}</div>
                  </div>
                </div>
              ))}
            </div>
            {/* Never a silent truncation: a capped list that does not say it is capped reads as the
                whole picture. */}
            {tail ? <div className="mt-3 text-[11.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty', maxWidth: 700 }}>{tail}</div> : null}
          </>
        ) : null}

        <div className="mt-8 pt-3" style={{ borderTop: '1px solid #1F1F22', fontFamily: MONO, fontSize: 10, color: '#4A4A52', lineHeight: 1.8 }}>
          <div>{Object.keys(payload.repoHasHistory).length} repositor{Object.keys(payload.repoHasHistory).length === 1 ? 'y' : 'ies'} compared</div>
          <div>this list exists to empty · nothing pretends to be read before it is</div>
        </div>
      </div>
    </div>
  );
}
