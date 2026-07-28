import React from 'react';
import type { Task, TaskDecision } from '../../types';
import { parseEvidenceAnchor } from '../../lib/intervene';
import { apiJson, jsonInit } from '../../lib/api';
import {
  criteriaHeadline,
  decisionAge,
  decisionSourceLabel,
  decisionsEmptyState,
  runSupersedeSubmit,
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
 *
 * A human's half of the supersede verb: every CURRENT decision (never a superseded one — history has
 * nothing left to replace) carries a "supersede this decision ›" action that opens a small composer
 * asking for the replacement's text. There is deliberately no "edit" or "delete" anywhere on this
 * panel — that IS the point (src/types.ts's "invalidate, never delete, never coexist"), so correcting
 * a decision has exactly one path: record what replaces it. Submitting POSTs to
 * `/api/features/:id/decisions/supersede` (`SupersedeAction` below) and is never optimistic — the row
 * stays exactly as-is until the server confirms, then `onSuperseded` (the caller's reload) is what
 * actually moves the old decision into struck-through history and surfaces the replacement as current.
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

/**
 * The real network call behind `submitSupersede`'s injected `postSupersede` — the one place this
 * file talks to `POST /api/features/:id/decisions/supersede` (src/server.ts). Kept to a single
 * responsibility (build the request, unwrap the response) so `submitSupersede` in decisionSurface.ts
 * stays framework-free and testable without a fetch mock's plumbing leaking into it.
 */
function postSupersedeRequest(featureId: string, repo: string | undefined, input: { decisionId: string; text: string }): Promise<TaskDecision> {
  return apiJson<{ ok: boolean; decision: TaskDecision }>(
    `/api/features/${encodeURIComponent(featureId)}/decisions/supersede`,
    jsonInit('POST', { text: input.text, supersedes: input.decisionId, ...(repo ? { repo } : {}) }),
  ).then((response) => response.decision);
}

/**
 * The ONLY affordance on a current decision: not "edit", not "delete" — record what replaces it.
 * Closed by default (a lowercase mono action link, matching DocSurface's "send it to whoever is
 * working on this ›"); opening it reveals a small composer. Never optimistic: the row this belongs
 * to stays exactly as-is (current, un-struck) until the server confirms the write — `onSuperseded`
 * (a reload of the feature's real decisions) is the only thing that ever moves it into history.
 *
 * Guarded against double-submit for the same reason: this is a ledger write, not a cosmetic toggle,
 * so a second POST for the same supersession is a real defect (it either mints an unwanted second
 * replacement or 409s on an action that already succeeded) — see `runSupersedeSubmit`'s doc in
 * decisionSurface.ts for the full guard, and why it stays SET through success rather than resetting
 * as soon as the request resolves.
 */
function SupersedeAction({
  featureId,
  repo,
  decisionId,
  onSuperseded,
}: {
  featureId?: string;
  repo?: string;
  decisionId: string;
  onSuperseded?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [succeeded, setSucceeded] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);
  // The double-submit guard's real source of truth (see `runSupersedeSubmit`'s doc, decisionSurface.ts):
  // a `useRef` cell, not `submitting` state — two clicks landing in the same tick both close over the
  // PRE-update `submitting` value, since React hasn't committed the re-render yet. The ref is written
  // synchronously, so the second call sees the first call's write immediately.
  const inFlightRef = React.useRef(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5"
        style={{ fontFamily: MONO, fontSize: 10, color: '#F0A35A' }}
      >
        supersede this decision ›
      </button>
    );
  }

  const disabled = submitting || succeeded;

  const handleSubmit = () => {
    // Defensive early return mirroring the `disabled` attribute below — the authoritative guard is
    // `inFlightRef` inside `runSupersedeSubmit`, but a click that somehow reaches this handler while
    // React still has the button rendered enabled (e.g. a queued event from just before a re-render)
    // should not even attempt to build the request.
    if (disabled) return;
    void runSupersedeSubmit({
      text,
      decisionId,
      postSupersede: (input) =>
        featureId
          ? postSupersedeRequest(featureId, repo, input)
          : Promise.reject(new Error('This decision has no feature to record the replacement against.')),
      inFlightRef,
      setSubmitting,
      setError,
      setSucceeded,
      onSuperseded,
    });
  };

  return (
    <div className="mt-2 flex flex-col gap-1.5" style={{ maxWidth: 520 }}>
      <div className="text-[11px] leading-[1.5]" style={{ color: '#5A5A61', textWrap: 'pretty' }}>
        This decision stays on the record. Recording a replacement supersedes it here — it is never edited or deleted.
      </div>
      <textarea
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          if (error) setError(undefined);
        }}
        placeholder="What replaces this decision?"
        rows={2}
        disabled={disabled}
        className="w-full resize-none rounded-[3px] bg-transparent px-2.5 py-2 outline-none disabled:opacity-60"
        style={{ border: '1px solid #26262B', fontSize: 12.5, color: '#C9C9CF' }}
      />
      {error ? (
        <div className="text-[11px] leading-[1.45]" style={{ color: '#F87171', textWrap: 'pretty' }}>{error}</div>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled || !text.trim()}
          className="h-7 rounded-[3px] px-3 disabled:opacity-40"
          style={{ border: '1px solid #26262B', fontFamily: MONO, fontSize: 10, color: '#F0A35A' }}
        >
          {succeeded ? 'recorded — refreshing…' : submitting ? 'recording…' : 'record replacement'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setText('');
            setError(undefined);
          }}
          disabled={disabled}
          className="h-7 rounded-[3px] px-3"
          style={{ border: '1px solid #26262B', fontFamily: MONO, fontSize: 10, color: '#8A8A91' }}
        >
          cancel
        </button>
      </div>
    </div>
  );
}

function DecisionRow({
  decision,
  historical,
  now,
  featureId,
  repo,
  onSuperseded,
}: {
  decision: TaskDecision;
  historical: boolean;
  now: number;
  featureId?: string;
  repo?: string;
  onSuperseded?: () => void;
}) {
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
        {/* Superseding replaces what is CURRENT — a decision already in history has nothing left to
            supersede; it is here for the record, not for further action. */}
        {!historical ? (
          <SupersedeAction featureId={featureId} repo={repo} decisionId={decision.id} onSuperseded={onSuperseded} />
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
  featureId,
  repo,
  onSuperseded,
}: {
  decisions: TaskDecision[];
  criteria: Task['acceptanceCriteria'];
  now?: number;
  /** The feature these decisions belong to — required to address the supersede route
   *  (`POST /api/features/:id/decisions/supersede`). Optional only so callers that never wire the
   *  action (and existing tests) keep compiling; without it, superseding fails honestly rather than
   *  silently, via `SupersedeAction`'s own guard. */
  featureId?: string;
  repo?: string;
  /** Called after the server confirms a supersede — the caller's cue to reload the feature so the
   *  replacement comes back as current and the old decision comes back stamped into history. This
   *  panel never mutates `decisions` itself; it only ever re-renders from fresh props. */
  onSuperseded?: () => void;
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
                  <DecisionRow
                    key={decision.id}
                    decision={decision}
                    historical={false}
                    now={now}
                    featureId={featureId}
                    repo={repo}
                    onSuperseded={onSuperseded}
                  />
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
