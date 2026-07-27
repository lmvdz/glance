import React from 'react';
import { useTaskContext } from '../../context/TaskContext';
import { fetchPlanBrief } from '../../lib/api';
import type { PlanBriefDTO } from '../../lib/dto';
import { buildPlanBriefHash, planBriefFeatures, planBriefNameFromDir } from '../../lib/plan-brief-route';
import { acceptanceState, holdingIt, holdingNothingSentence, leftOutSentence, phases, reshapeSentence, shapeSentence, startedState, statusTone } from '../../lib/planSurface';

/**
 * PlanSurface — a plan as a shape you can still change.
 *
 * `02-surfaces.html` builds this screen around one sentence: *"Change the shape here — rename, split,
 * remove or reorder — because after you start it is the fleet's plan and not yours."* The heading is
 * **NOTHING HAS STARTED**, the meta is *0 agents woken · 0 files touched*, and the assumptions have
 * their own zone called **WHAT TAM ASSUMED, SO YOU CAN CORRECT IT** — because an assumption filed
 * under "notes" is one nobody corrects.
 *
 * The old brief view had all of this data and made none of these claims. It opened on an amber radial
 * gradient with a "Human comprehension brief" pill, four metric tiles and a status-split bar chart:
 * the vocabulary of a dashboard for work already underway, on the screen whose whole subject is the
 * moment before it is.
 *
 * What is kept from it: the dependency-ordered columns are genuinely the right drawing of a plan, so
 * they stay — as phases with the parallel count SAID rather than left to be counted off the screen.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

function Zone({ label, tone, children }: { label: string; tone?: string; children: React.ReactNode }) {
  return (
    <div className="mt-7">
      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: tone ?? '#5A5A61' }}>{label}</div>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

function PlanIndex({ onOpen }: { onOpen: (name: string) => void }) {
  const { features } = useTaskContext();
  const plans = planBriefFeatures(features);
  return (
    <div className="h-full overflow-y-auto" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      <div className="mx-auto max-w-[900px] px-8 py-9">
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>PLANS · {plans.length}</div>
        {plans.length === 0 ? (
          <div className="mt-3 max-w-[620px] text-[13px] leading-[1.6]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>
            No plan has been written down. That is not the same as having no work — it means the work in flight was started
            directly, and there is no shape here for anyone to argue with before it runs.
          </div>
        ) : (
          <div className="mt-3 flex flex-col">
            {plans.map((feature) => {
              const name = planBriefNameFromDir(feature.planDir) ?? feature.id;
              return (
                <button
                  key={feature.id}
                  type="button"
                  onClick={() => onOpen(name)}
                  className="flex items-baseline gap-3 py-2.5 text-left"
                  style={{ borderTop: '1px solid #17171A' }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px]" style={{ color: '#DEDEE2' }}>{feature.title}</div>
                    <div className="mt-[3px] truncate" style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>plans/{name}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PlanBody({ brief, onBack }: { brief: PlanBriefDTO; onBack: () => void }) {
  const shape = {
    concerns: brief.concerns,
    status: brief.status,
    outOfScope: brief.outOfScope,
    dependencyIssues: brief.dependencyIssues,
    touches: brief.touches,
  };
  const state = startedState(brief.status);
  const held = holdingIt(shape);
  const groups = phases(brief.concerns);
  const acceptance = acceptanceState(brief.concerns);

  return (
    <div className="h-full overflow-y-auto" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      <div className="mx-auto max-w-[1000px] px-8 py-8">
        <div className="flex items-baseline gap-4">
          {/* "Nothing has started" is a claim, so it is derived rather than printed. */}
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: state.started ? '#8A6A45' : '#5A5A61' }}>
            {brief.title.toUpperCase()} · {state.line}
          </div>
          <div className="flex-1" />
          <button type="button" onClick={onBack} style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>all plans</button>
        </div>
        <div className="mt-1" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>{brief.planDir} · {state.meta}</div>

        {/* The words this plan came from, quoted. */}
        <div className="mt-4 text-[15px] leading-[1.55]" style={{ color: '#DEDEE2', textWrap: 'pretty', maxWidth: 720 }}>
          You said: {brief.outcome}
        </div>
        <div className="mt-2.5 text-[13px] leading-[1.55]" style={{ color: '#8A8A91', textWrap: 'pretty', maxWidth: 720 }}>
          {shapeSentence(brief.concerns)} {reshapeSentence(state.started)}
        </div>

        <Zone label="THE SHAPE · IN DEPENDENCY ORDER">
          {/* A fact true of every row is stated once. Printed nine times it becomes wallpaper and the
              reader stops seeing it by the third repetition. */}
          {acceptance.sentence ? (
            <div className="mb-3 text-[12px] leading-[1.5]" style={{ color: '#8A6A45', textWrap: 'pretty', maxWidth: 720 }}>{acceptance.sentence}</div>
          ) : null}
          <div className="flex gap-3 overflow-x-auto pb-1">
            {groups.map((group) => (
              <div key={group.phase} className="min-w-[210px] flex-1">
                <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '.14em', color: '#4A4A52' }}>
                  {/* Parallelism is stated where it happens, not only in the summary above. */}
                  PHASE {group.phase}{group.concerns.length > 1 ? ` · ${group.concerns.length} AT ONCE` : ''}
                </div>
                <div className="mt-2 flex flex-col">
                  {group.concerns.map((concern) => (
                    <div key={concern.file} className="flex gap-2.5 py-2" style={{ borderTop: '1px solid #17171A' }}>
                      <div className="mt-[7px] h-[5px] w-[5px] flex-none rounded-full" style={{ background: statusTone(concern) }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] leading-[1.45]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{concern.title}</div>
                        <div className="mt-[3px]" style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>
                          {concern.status}
                          {acceptance.perRow
                            ? concern.acceptanceCount > 0
                              ? ` · ${concern.acceptanceCount} check${concern.acceptanceCount === 1 ? '' : 's'}`
                              : ' · nothing to check it against'
                            : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Zone>

        <div className="flex gap-9">
          <div className="flex-1 min-w-0">
            <Zone label="WHAT IS HOLDING IT" tone={held.length > 0 ? '#C2704A' : undefined}>
              {held.length === 0 ? (
                <div className="text-[12.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>{holdingNothingSentence(shape)}</div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {held.map((line) => (
                    <div key={line} className="text-[12.5px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{line}</div>
                  ))}
                </div>
              )}
            </Zone>

            <Zone label="WHAT WAS DECIDED, SO YOU CAN CORRECT IT">
              {brief.decisions.length === 0 ? (
                <div className="text-[12.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
                  Nothing was written down as a decision. Every choice this plan makes is implicit in its units, which is
                  where disagreements surface late instead of now.
                </div>
              ) : (
                <div className="flex flex-col">
                  {brief.decisions.map((decision) => (
                    <div key={decision.text} className="py-2" style={{ borderTop: '1px solid #17171A' }}>
                      <div className="text-[12.5px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{decision.text}</div>
                      <div className="mt-[3px]" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>from the {decision.source}</div>
                    </div>
                  ))}
                </div>
              )}
            </Zone>
          </div>

          <div className="w-[340px] flex-none">
            <Zone label="WHAT I LEFT OUT OF THIS">
              <div className="text-[12px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>{leftOutSentence(brief.outOfScope)}</div>
              {brief.outOfScope.length > 0 ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  {brief.outOfScope.map((line) => (
                    <div key={line} className="text-[12.5px] leading-[1.45]" style={{ color: '#C9C9CF', textWrap: 'pretty' }}>{line}</div>
                  ))}
                </div>
              ) : null}
            </Zone>

            <Zone label="WHAT THIS TOUCHES">
              {brief.touches.length === 0 ? (
                <div className="text-[12px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
                  No files were named. The plan may still touch plenty — nobody wrote down which.
                </div>
              ) : (
                <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#8A8A91', lineHeight: 1.8 }}>
                  {brief.touches.slice(0, 14).map((path) => <div key={path} className="truncate" title={path}>{path}</div>)}
                  {brief.touches.length > 14 ? <div style={{ color: '#4A4A52' }}>and {brief.touches.length - 14} more</div> : null}
                </div>
              )}
            </Zone>

            <Zone label="WHAT HAPPENS THE MOMENT YOU START IT">
              {brief.timeline.length === 0 ? (
                <div className="text-[12px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>No gates were written down, so nothing stops this plan between phases except a person watching it.</div>
              ) : (
                <div className="flex flex-col">
                  {brief.timeline.map((item) => (
                    <div key={item.phase} className="py-2" style={{ borderTop: '1px solid #17171A' }}>
                      <div className="text-[12.5px] leading-[1.45]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{item.phase}. {item.title}</div>
                      <div className="mt-[3px] text-[11.5px] leading-[1.45]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>{item.gate}</div>
                    </div>
                  ))}
                </div>
              )}
            </Zone>
          </div>
        </div>

        <div className="mt-8 pt-3" style={{ borderTop: '1px solid #1F1F22', fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>
          read from the plan on disk · {new Date(brief.updatedAt).toLocaleString()}
        </div>
      </div>
    </div>
  );
}

export function PlanSurface({ name }: { name?: string }) {
  const { currentProject } = useTaskContext();
  const [brief, setBrief] = React.useState<PlanBriefDTO | null>(null);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!name) { setBrief(null); setError(''); return; }
    let live = true;
    setLoading(true);
    setError('');
    fetchPlanBrief(name, currentProject?.id)
      .then((payload) => { if (live) setBrief(payload); })
      // A plan that could not be read is not a plan with no units. Rendering an empty shape would be
      // the screen asserting something about work it never saw.
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : 'This plan could not be read.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [name, currentProject?.id]);

  const open = (next: string) => { window.location.hash = buildPlanBriefHash({ name: next }); };
  const back = () => { window.location.hash = '#/plans'; };

  if (!name) return <PlanIndex onOpen={open} />;
  if (loading) return <div className="px-8 py-9" style={{ background: '#0A0A0B', fontFamily: MONO, fontSize: 10.5, color: '#4A4A52' }}>reading plans/{name}…</div>;
  if (error || !brief) {
    return (
      <div className="overflow-y-auto px-8 py-9" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
        <div className="max-w-[620px]">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#C2704A' }}>PLANS/{name.toUpperCase()} COULD NOT BE READ</div>
          <div className="mt-2.5 text-[13px] leading-[1.6]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>
            {error || 'Nothing came back.'} That is a failed read, not an empty plan — nothing about its shape should be taken from this screen.
          </div>
          <button type="button" onClick={back} className="mt-4" style={{ fontFamily: MONO, fontSize: 10.5, color: '#F0A35A' }}>all plans</button>
        </div>
      </div>
    );
  }
  return <PlanBody brief={brief} onBack={back} />;
}
