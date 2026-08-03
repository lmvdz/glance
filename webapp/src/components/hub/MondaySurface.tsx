import React from 'react';
import { apiJson, fetchEpisodes, type EpisodeMetaDTO } from '../../lib/api';
import { useTaskContext } from '../../context/TaskContext';
import { buildAdoptionView, coerceAdoptionCounters, coerceFrictionEntries, type AdoptionView, type FrictionEntryWire } from '../../lib/adoption-view';
import { NOTHING_RECORDED_LINE, direction, frictionGroups, frictionHeadline, frictionWeight, nothingRecorded } from '../../lib/mondaySurface';
import { coerceHorizonCurve, coverageSentence, horizonBandRows, horizonSentence, type HorizonCurveWire } from '../../lib/horizonView';

/**
 * MondaySurface — what changed in how this gets used, and what is still rubbing.
 *
 * `05-first-week.html` measures a week the only way that means anything: *"You were interrupted
 * fourteen times on Monday and five times yesterday… Next week will be quieter than this one for
 * reasons you can read, not because a model settled down."* A direction, and then the reason.
 *
 * It replaces the Daily panel, which had the same two signals — adoption counters and the friction
 * ledger — as stat tiles with sparklines over a newest-first list of gripes. A sparkline is the exact
 * thing this design refuses: a shape with no sentence, which a reader either over-reads or ignores.
 * And newest-first buries the complaint that has happened eleven times under the one that happened
 * once.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

const repoBasename = (repo: string): string => {
  const trimmed = repo.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
};

export function MondaySurface() {
  const { currentProject } = useTaskContext();
  const [view, setView] = React.useState<AdoptionView | undefined>();
  const [friction, setFriction] = React.useState<FrictionEntryWire[] | undefined>();
  const [horizon, setHorizon] = React.useState<HorizonCurveWire | undefined>();
  const [episodes, setEpisodes] = React.useState<EpisodeMetaDTO[]>([]);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    // Read together and one failing never blanks the others — but a failure is reported as a
    // failure rather than as an empty week. The horizon read failing simply omits its section
    // (it is a capability statement, not a weekly signal — absence is not misreadable here).
    Promise.allSettled([apiJson<unknown>('/api/adoption'), apiJson<unknown>('/api/friction?limit=50'), apiJson<unknown>('/api/horizon')]).then(([counters, gripes, curve]) => {
      if (!alive) return;
      if (counters.status === 'fulfilled') setView(buildAdoptionView(coerceAdoptionCounters(counters.value)));
      else setError('the adoption counters could not be read');
      if (gripes.status === 'fulfilled') setFriction(coerceFrictionEntries(gripes.value));
      else setFriction([]);
      if (curve.status === 'fulfilled') setHorizon(coerceHorizonCurve(curve.value));
    });
    return () => { alive = false; };
  }, []);

  // The weekly episode belongs on THIS screen, not on a card of its own: 05-first-week's whole shape
  // is "what it now knows that it did not on Monday", and the episode is literally that written down.
  // Its old card was rendered by the panel this replaced and by nothing else.
  React.useEffect(() => {
    const repo = currentProject?.id;
    if (!repo) return;
    let alive = true;
    fetchEpisodes(repo).then((next) => { if (alive) setEpisodes(next); }).catch(() => { if (alive) setEpisodes([]); });
    return () => { alive = false; };
  }, [currentProject?.id]);

  if (!view && !error) {
    return <div className="px-8 py-9" style={{ background: '#0A0A0B', fontFamily: MONO, fontSize: 10.5, color: '#4A4A52' }}>reading this week…</div>;
  }

  const series = view?.series ?? [];
  const empty = nothingRecorded(series);
  const groups = frictionGroups(friction ?? []);

  return (
    <div className="h-full overflow-y-auto" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      <div className="mx-auto max-w-[900px] px-8 py-9">
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>
          WHAT CHANGED IN HOW THIS GETS USED
        </div>

        {error ? (
          <div className="mt-3.5 px-3.5 py-2.5 text-[12.5px] leading-[1.5]" style={{ border: '1px solid #241A17', borderLeft: '2px solid #B4553A', background: '#100D0C', color: '#DEDEE2', textWrap: 'pretty', maxWidth: 720 }}>
            {error}. That is a failed read, not a quiet week — no conclusion about use should be taken from this screen.
          </div>
        ) : empty ? (
          <div className="mt-3.5 text-[15px] leading-[1.55]" style={{ color: '#8A8A91', textWrap: 'pretty', maxWidth: 720 }}>{NOTHING_RECORDED_LINE}</div>
        ) : (
          <div className="mt-3.5 flex flex-col gap-2.5">
            {series.filter((entry) => entry.week > 0).map((entry) => (
              <div key={entry.key} className="flex items-baseline gap-3">
                <div className="w-[150px] flex-none truncate" style={{ fontFamily: MONO, fontSize: 10.5, color: '#5A5A61' }}>{entry.label}</div>
                {/* The sentence IS the reading. A sparkline beside it would only invite a second,
                    vaguer one. */}
                <div className="flex-1 text-[13px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{direction(entry)}</div>
              </div>
            ))}
          </div>
        )}

        {horizon ? (
          <div className="mt-8" style={{ borderTop: '1px solid #1F1F22', paddingTop: 22 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>HOW BIG A TASK IT CAN BE TRUSTED WITH</div>
            {/* The sentence IS the reading (METR's lesson restated for an operator: one rate hides
                the reliability axis you actually plan around). Bands are the evidence behind it. */}
            <div className="mt-2.5 text-[13px] leading-[1.55]" style={{ color: '#DEDEE2', textWrap: 'pretty', maxWidth: 720 }}>
              {horizonSentence(horizon)}
            </div>
            {horizonBandRows(horizon).length > 0 ? (
              <div className="mt-3.5 flex flex-col">
                {horizonBandRows(horizon).map((row) => (
                  <div key={row.label} className="flex items-baseline gap-3 py-2" style={{ borderTop: '1px solid #17171A' }}>
                    <div className="w-[110px] flex-none" style={{ fontFamily: MONO, fontSize: 10.5, color: '#5A5A61' }}>{row.label}</div>
                    <div className="text-[12.5px] leading-[1.5]" style={{ color: '#DEDEE2' }}>{row.rateLabel} landed validated</div>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="mt-3" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>{coverageSentence(horizon)}</div>
          </div>
        ) : null}

        <div className="mt-8" style={{ borderTop: '1px solid #1F1F22', paddingTop: 22 }}>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>WHAT IS STILL RUBBING</div>
          <div className="mt-2.5 text-[13px] leading-[1.55]" style={{ color: '#DEDEE2', textWrap: 'pretty', maxWidth: 720 }}>
            {frictionHeadline(friction ?? [])}
          </div>

          {groups.length > 0 ? (
            <div className="mt-3.5 flex flex-col">
              {groups.map((group) => (
                <div key={group.key} className="flex gap-3 py-2.5" style={{ borderTop: '1px solid #17171A' }}>
                  <div className="mt-[7px] h-[5px] w-[5px] flex-none rounded-full" style={{ background: group.humans > 0 ? '#D9A03C' : '#3E5C8A' }} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{group.gripe}</div>
                    {/* Who said it decides how much it weighs, and the two are never summed into one
                        number that hides which is which. */}
                    <div className="mt-[3px] text-[11.5px] leading-[1.45]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>{frictionWeight(group)}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {episodes.length > 0 ? (
            <div className="mt-8" style={{ borderTop: '1px solid #1F1F22', paddingTop: 22 }}>
              <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>
                WHAT IT NOW KNOWS THAT IT DID NOT ON MONDAY
              </div>
              <div className="mt-2.5 flex flex-col">
                {episodes.slice(0, 4).map((episode) => (
                  <div key={episode.id} className="py-2.5" style={{ borderTop: '1px solid #17171A' }}>
                    <div className="text-[12.5px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{episode.excerpt}</div>
                    <div className="mt-[3px]" style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>
                      {episode.isoWeek} · {episode.digestCount} digest{episode.digestCount === 1 ? '' : 's'}
                      {/* Stale answers are said, not colour-coded: a brief that quietly contains
                          out-of-date claims is worse than one that admits it. */}
                      {episode.hasStaleAnswers ? ' · contains answers that have since gone stale' : ''}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {(friction ?? []).length > 0 ? (
            <div className="mt-3" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>
              across {new Set((friction ?? []).map((entry) => repoBasename(entry.repo))).size} repositor{new Set((friction ?? []).map((entry) => repoBasename(entry.repo))).size === 1 ? 'y' : 'ies'}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
