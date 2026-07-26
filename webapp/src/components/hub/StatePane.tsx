import React, { useCallback, useMemo, useState } from 'react';
import { alarmBand, groupByState, nodeStatusLine, selectionPreview, type RoomNode } from '../../lib/roomState';

/**
 * StatePane — the room's state side.
 *
 * Three regions, in one order that never changes: what needs you, what is in flight, what has settled.
 * Settled work collapses because done work leaves the working surface; it stays readable, it just stops
 * competing for the eye.
 *
 * Select and enter are DIFFERENT ACTS (concern 07). Clicking or arrowing to a node previews it and
 * changes nothing you are reading. Enter, double-click, or the explicit control navigates. This is the
 * one invariant a reader gets: nothing replaces the conversation beneath them unless they ask for it.
 */

export interface StatePaneProps {
  nodes: readonly RoomNode[];
  now: number;
  /** Elapsed unbroken autonomy and the month's best run — a streak, not a count. */
  autonomy?: { sinceMs?: number; bestRunMs?: number };
  /** Entering is explicit and always the caller's decision to act on. */
  onEnter?: (node: RoomNode) => void;
}

function Region({
  title,
  nodes,
  now,
  selectedId,
  onSelect,
  onEnter,
  collapsible,
}: {
  title: string;
  nodes: readonly RoomNode[];
  now: number;
  selectedId?: string;
  onSelect: (node: RoomNode) => void;
  onEnter?: (node: RoomNode) => void;
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);
  if (nodes.length === 0 && collapsible) return null;
  return (
    <section className="border-b border-ink-border last:border-b-0">
      <h2 className="flex items-center justify-between px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-text-muted">
        <span>{title}</span>
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-ink-text-subtle hover:text-ink-text-body"
            // Every control says what it will do before it is pressed.
            title={open ? `Collapse ${title.toLowerCase()} — it stays readable, it just stops taking up room.` : `Show the ${nodes.length} settled item${nodes.length === 1 ? '' : 's'} again.`}
          >
            {open ? 'collapse' : `${nodes.length} settled`}
          </button>
        ) : null}
      </h2>
      {open ? (
        <ul className="pb-2">
          {nodes.map((node) => {
            const selected = node.id === selectedId;
            return (
              <li key={node.id}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(node)}
                  onDoubleClick={() => onEnter?.(node)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      // Enter is the ONLY key that changes what you are reading.
                      selected ? onEnter?.(node) : onSelect(node);
                    }
                  }}
                  className={`w-full cursor-default px-3 py-2 text-left ${selected ? 'bg-ink-surface' : 'hover:bg-ink-surface/60'}`}
                >
                  <div className="flex items-baseline gap-2">
                    {/* Raw values are footnotes; the address is how a person says it out loud. */}
                    <span className="font-mono text-[11px] text-ink-text-subtle">{node.address}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink-text-body">{node.title}</span>
                    {node.state === 'needs-you' ? <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-ember" aria-hidden /> : null}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-ink-text-muted">{nodeStatusLine(node, now)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export function StatePane({ nodes, now, autonomy, onEnter }: StatePaneProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const groups = useMemo(() => groupByState(nodes), [nodes]);
  const selected = useMemo(() => nodes.find((node) => node.id === selectedId), [nodes, selectedId]);
  const select = useCallback((node: RoomNode) => setSelectedId(node.id), []);
  const band = alarmBand(groups.needsYou, { ...autonomy, now });
  const quiet = groups.needsYou.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel text-ink-text">
      {/* A full-width sentence that explains, never a labelled counter. */}
      <div className={`border-b px-3 py-2 text-[12px] leading-snug ${quiet ? 'border-ink-border text-ink-text-muted' : 'border-ember/40 bg-ember/5 text-ink-text-body'}`} role="status">
        {band}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Region title="Needs you" nodes={groups.needsYou} now={now} selectedId={selectedId} onSelect={select} onEnter={onEnter} />
        <Region title="In flight" nodes={groups.inFlight} now={now} selectedId={selectedId} onSelect={select} onEnter={onEnter} />
        <Region title="Settled" nodes={groups.settled} now={now} selectedId={selectedId} onSelect={select} onEnter={onEnter} collapsible />
      </div>

      {selected ? (
        <div className="border-t border-ink-border px-3 py-2 text-[11px] leading-snug text-ink-text-muted">
          {/* Says both the fact and the consequence: inspection is safe while reading. */}
          {selectionPreview(selected)}
        </div>
      ) : null}
    </div>
  );
}
