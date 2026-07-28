import type { Task, TaskDecision } from '../../types';
import { parseEvidenceAnchor } from '../../lib/intervene';
import {
  criteriaHeadline,
  decisionAge,
  decisionSourceLabel,
  decisionsEmptyState,
  shouldCollapseSuperseded,
  splitDecisions,
} from '../../lib/decisionSurface';

/**
 * DecisionsPanel — the feature's decision ledger and acceptance criteria, rendered where a person
 * actually lands when they open a feature.
 *
 * Found by a live UI audit: `FeatureDecision[]` and `acceptanceCriteria` are recorded server-side,
 * round-trip through `GET`/`PATCH /api/features` and the supersede verb, and rendered nowhere —
 * clicking a task landed on `DocSurface`'s plan-doc comment thread, which shows neither. This is the
 * fix: a CURRENT ledger (most recent first), superseded decisions kept as visible history rather than
 * deleted (the product's own rule — src/types.ts's `FeatureDecision.supersededBy` doc, "invalidate,
 * never delete, never coexist"), and the criteria list plainly, with its own honest empty state.
 *
 * Deliberately does NOT reuse `deltaBullets()` (intervene.ts) even though it was purpose-built for the
 * model-delta slice of this same data: that formatter filters to ONE unit's OWN decisions
 * (`sourceRef.agentId === agentId`) for the Intervene View's diff-adjacent teaching moment. This panel
 * is the feature-wide ledger — every decision on the feature, from every source and every unit, current
 * and historical — so an agent-scoped filter would silently drop most of what this surface exists to
 * show. What IS reused from that module is `parseEvidenceAnchor`, the actual evidence-anchor formatter,
 * so a model-delta decision's anchors read the same way here as they do on the Intervene View.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

function EvidenceAnchors({ evidence }: { evidence: string[] }) {
  if (!evidence.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
      {evidence.map((anchor) => {
        const parsed = parseEvidenceAnchor(anchor);
        const label = parsed.lineStart
          ? `${parsed.file}:${parsed.lineStart}${parsed.lineEnd && parsed.lineEnd !== parsed.lineStart ? `-${parsed.lineEnd}` : ''}`
          : parsed.file;
        return (
          <span key={anchor} style={{ fontFamily: MONO, fontSize: 10.5, color: '#6A6A72' }}>
            {label}
          </span>
        );
      })}
    </div>
  );
}

function DecisionRow({ decision, historical, now }: { decision: TaskDecision; historical: boolean; now: number }) {
  const age = decisionAge(decision.createdAt, now);
  return (
    <div className="flex gap-2.5 py-2.5" style={{ borderTop: '1px solid #17171A' }}>
      <div
        className="mt-[7px] h-[5px] w-[5px] flex-none rounded-full"
        style={{ background: historical ? '#3A3A40' : '#3E5C8A' }}
      />
      <div className="min-w-0 flex-1">
        <div
          className="text-[12.5px] leading-[1.5]"
          style={{
            color: historical ? '#6A6A72' : '#DEDEE2',
            textDecoration: historical ? 'line-through' : 'none',
            textDecorationColor: '#4A4A52',
            textWrap: 'pretty',
          }}
        >
          {decision.text}
        </div>
        <div className="mt-[3px] flex flex-wrap items-baseline gap-x-2" style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>
          <span>{decisionSourceLabel(decision.source)}</span>
          {age ? <span>· {age}</span> : null}
          {historical ? <span style={{ color: '#8A6A4A' }}>· superseded</span> : null}
        </div>
        {decision.source === 'model-delta' && decision.evidence?.length ? (
          <EvidenceAnchors evidence={decision.evidence} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * A superseded decision must stay reachable — find-in-page, a screen reader, anyone scrolling —
 * whether or not the disclosure has been opened. A `useState`-gated `{open ? rows : null}` (the
 * first cut of this) does the opposite: closed, the historical rows are not merely styled as
 * hidden, they are absent from the tree entirely, which makes "superseded, never deleted" a lie
 * the moment the panel renders collapsed. Native `<details>`/`<summary>` — the same pattern
 * `ToolCallGroup.tsx`'s raw-payload disclosure already uses — keeps every child in the DOM
 * regardless of the `open` attribute; only CSS visibility changes. Below `SUPERSEDED_INLINE_MAX`
 * there's nothing to collapse, so history renders inline with no disclosure at all.
 */
function SupersededHistory({ decisions, now }: { decisions: TaskDecision[]; now: number }) {
  if (decisions.length === 0) return null;

  const rows = decisions.map((decision) => <DecisionRow key={decision.id} decision={decision} historical now={now} />);

  if (!shouldCollapseSuperseded(decisions.length)) {
    return <div className="mt-1 flex flex-col">{rows}</div>;
  }

  return (
    <details className="group mt-1">
      <summary
        className="flex w-full cursor-pointer list-none items-baseline gap-2 py-1.5"
        style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', color: '#5A5A61' }}
      >
        <span>{decisions.length} superseded decision{decisions.length === 1 ? '' : 's'}</span>
        <span className="flex-1" />
        <span className="transition-transform group-open:rotate-90" style={{ color: '#4A4A52' }}>▸</span>
      </summary>
      <div className="flex flex-col">{rows}</div>
    </details>
  );
}

function CriterionRow({ criterion }: { criterion: Task['acceptanceCriteria'][number] }) {
  return (
    <div className="flex gap-2.5 py-2.5" style={{ borderTop: '1px solid #17171A' }}>
      <div
        className="mt-[3px] h-[13px] w-[13px] flex-none rounded-[3px]"
        style={{
          border: criterion.completed ? 'none' : '1px solid #33333A',
          background: criterion.completed ? '#3E7D57' : 'transparent',
        }}
      />
      <div className="min-w-0 flex-1">
        <div
          className="text-[12.5px] leading-[1.5]"
          style={{ color: criterion.completed ? '#8A8A91' : '#DEDEE2', textWrap: 'pretty' }}
        >
          {criterion.text}
        </div>
        {criterion.source ? (
          <div className="mt-[3px]" style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>{criterion.source}</div>
        ) : null}
      </div>
    </div>
  );
}

export function DecisionsPanel({
  decisions,
  criteria,
  now = Date.now(),
}: {
  decisions: TaskDecision[];
  criteria: Task['acceptanceCriteria'];
  now?: number;
}) {
  const { current, superseded } = splitDecisions(decisions);

  return (
    <div className="mt-6 flex flex-col gap-6">
      <div>
        <div className="flex items-baseline gap-2.5">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>DECISIONS</div>
          {current.length > 0 ? (
            <div style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>{current.length} current</div>
          ) : null}
        </div>

        {decisions.length === 0 ? (
          <div className="mt-2.5 max-w-[620px] text-[12.5px] leading-[1.55]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>
            {decisionsEmptyState()}
          </div>
        ) : (
          <>
            {current.length > 0 ? (
              <div className="mt-1 flex flex-col">
                {current.map((decision) => (
                  <DecisionRow key={decision.id} decision={decision} historical={false} now={now} />
                ))}
              </div>
            ) : (
              <div className="mt-2.5 text-[12.5px] leading-[1.55]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>
                Every decision recorded here has since been superseded — nothing from this ledger is currently in force.
              </div>
            )}
            <SupersededHistory decisions={superseded} now={now} />
          </>
        )}
      </div>

      <div>
        <div className="flex items-baseline gap-2.5">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>ACCEPTANCE CRITERIA</div>
        </div>
        <div className="mt-2.5 text-[12.5px] leading-[1.55]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>
          {criteriaHeadline(criteria)}
        </div>
        {criteria.length > 0 ? (
          <div className="mt-1 flex flex-col">
            {criteria.map((criterion) => (
              <CriterionRow key={criterion.id} criterion={criterion} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
