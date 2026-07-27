import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../../lib/api';
import { unitHref } from '../../lib/router';
import type { AgentDTO } from '../../lib/dto';
import { NEVER_RANKED, claimBasis, sampleCaveat, sampleLine, whatWouldMakeThisWorthReading, type AgentRecordView } from '../../lib/agentRecord';

/**
 * AgentRecordPanel — what an agent has actually done, and the refusal to turn it into a reputation.
 *
 * This rendered inside the new room still wearing the old application's clothes: rounded cards, an ink-
 * surface refresh button, an amber "provisional" pill. `03-machinery.html` draws it as prose under mono
 * zone headings, and — more importantly — draws it as an argument against itself. The zones are
 * *"WHAT HE HAS ACTUALLY DONE — ALL OF IT"*, *"WHAT WOULD MAKE THIS PAGE WORTH READING"*, and *"WHAT HIS
 * ROLE DOES BY DEFAULT — NOT WHAT HE HAS PROVED"*, with the standing line **a wrong reputation is worse
 * than none** across the top of the thin case.
 *
 * The old version had every fact and none of the framing: it showed claims with sample sizes and left
 * the reader to notice that six units cannot support a conclusion. This one says so first.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";
const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function AgentRecordPanel({ agent }: { agent: AgentDTO }) {
  const [record, setRecord] = useState<AgentRecordView>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const name = agent.name || agent.id;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRecord(await apiJson<AgentRecordView>(`/api/agents/${encodeURIComponent(agent.id)}/record`));
    } catch {
      setRecord(undefined);
      // A failed read is not an empty record. Saying "nothing recorded" here would be the page making
      // the claim it exists to avoid making.
      setError('This record could not be read. That is a failed request, not an empty history — no claim about this agent is being assumed either way.');
    } finally {
      setLoading(false);
    }
  }, [agent.id]);
  useEffect(() => { void load(); }, [load]);

  const caveat = record ? sampleCaveat(record, name) : undefined;

  return (
    <section
      className="px-5 py-3.5"
      style={{ borderBottom: '1px solid #1F1F22', background: '#0A0A0B' }}
      aria-label={`${name} record`}
      aria-busy={loading}
    >
      <div className="flex items-baseline gap-3">
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>WHAT {name.toUpperCase()} HAS ACTUALLY DONE — ALL OF IT</div>
        <div className="flex-1" />
        {record ? <div style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>{sampleLine(record)}</div> : null}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}
          title="Read this record again."
        >
          {loading ? 'reading…' : 'reload'}
        </button>
      </div>

      {error ? (
        <div className="mt-2.5 px-3 py-2.5 text-[12px] leading-[1.5]" style={{ border: '1px solid #241A17', borderLeft: '2px solid #B4553A', background: '#100D0C', color: '#DEDEE2', textWrap: 'pretty' }}>
          {error}
        </div>
      ) : null}

      {!loading && !error && record ? (
        <>
          {/* The refusal comes FIRST. Putting it under the claims would let someone read three claims as
              a character assessment before reaching the sentence that says they are not one. */}
          {caveat ? (
            <div className="mt-2.5">
              <div className="text-[12.5px] leading-[1.55]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{caveat}</div>
              <div className="mt-1" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.06em', color: '#8A6A45' }}>
                no judgement offered · a wrong reputation is worse than none
              </div>
            </div>
          ) : null}

          {record.provisional ? (
            <div className="mt-2.5 text-[12px] leading-[1.5]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>
              Still being checked: {record.checking?.checkedUnits ?? 0} of {record.checking?.requiredUnits ?? 0} units reviewed. That is a safeguard on new work, not a judgement about {name}.
            </div>
          ) : record.profileMissing ? (
            <div className="mt-2.5 text-[12px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
              Whether {name} is still being checked is unknown — there is no onboarding record. Unknown, not no.
            </div>
          ) : null}

          {record.claims.length > 0 ? (
            <div className="mt-3 flex flex-col">
              {record.claims.map((claim) => (
                <div key={claim.id} className="py-2.5" style={{ borderTop: '1px solid #17171A', opacity: claim.state === 'withdrawn' ? 0.62 : 1 }}>
                  <div className="text-[12.5px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{claim.claim}</div>
                  <div className="mt-[3px] flex flex-wrap items-baseline gap-x-3" style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>
                    <span>{claimBasis(claim, (ms) => DATE.format(ms))}</span>
                    {/* Nothing is inferred from anything you cannot open. */}
                    {claim.sourceNodeIds.map((sourceId) => (
                      <a key={sourceId} href={unitHref(sourceId)} style={{ color: '#F0A35A' }} title={`Stand in ${sourceId}.`}>
                        {sourceId}
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="mt-4 flex gap-8">
            <div className="flex-1 min-w-0">
              <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>WHAT WOULD MAKE THIS PAGE WORTH READING</div>
              <div className="mt-2 flex flex-col gap-1.5">
                {whatWouldMakeThisWorthReading(record).map((line) => (
                  <div key={line} className="text-[11.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>{line}</div>
                ))}
              </div>
            </div>
            <div className="w-[300px] flex-none">
              <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>WHAT THE ROLE DOES BY DEFAULT — NOT WHAT IT HAS PROVED</div>
              <div className="mt-2 text-[11.5px] leading-[1.5]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>
                {record.roleDefault
                  ? `Configured for ${record.roleDefault}. That is what the role does, and it says nothing about whether ${name} does it well.`
                  : `The configured role could not be read, so not even a default can be shown here.`}
              </div>
            </div>
          </div>

          <div className="mt-3.5 text-[11.5px] leading-[1.5]" style={{ color: '#4A4A52', textWrap: 'pretty' }}>{NEVER_RANKED}</div>
        </>
      ) : null}
    </section>
  );
}
