import React from 'react';
import { handoverSummary, type RoomNode } from '../../lib/roomState';
import { FleetPulse, type Interruption, type PulseBucket } from './FleetPulse';

/**
 * QuietRoom — what a silent room says.
 *
 * A quiet room is the DESIGNED state, not a failure: lifecycle telemetry lands at its node, so an
 * empty room means the fleet is working and nothing has needed anyone. The old empty state said "No
 * entries yet — fleet cards and operator messages will land here as the room wakes up", which is a
 * promise about the future and tells a person nothing about the present. Somebody returning after
 * four hours wants to know what happened, not that something might.
 *
 * So the quiet room is a HANDOVER. It distinguishes what finished, what changed direction, and what
 * needed a person and got no answer — and it says what it left out, because a bounded summary that
 * does not admit its bounds reads as a complete one.
 *
 * When there is genuinely no history at all — a fresh install, nothing has ever run — it says that
 * instead. "Nothing has happened yet" and "nothing happened while you were away" are different facts
 * and must not share a screen.
 */

export interface QuietRoomProps {
  nodes: readonly RoomNode[];
  /** Events per hour. The reference puts this on the QUIET screen — it exists to make a calm fleet
   *  legible, not to give a busy one a dashboard. */
  pulse?: readonly PulseBucket[];
  lastInterruption?: Interruption;
  /** How long since this person last read the room. Absent on a first visit. */
  awayMs?: number;
  now: number;
}

export function QuietRoom({ nodes, awayMs, now, pulse, lastInterruption }: QuietRoomProps) {
  const settled = nodes.filter((node) => node.state === 'settled');
  const needsYou = nodes.filter((node) => node.state === 'needs-you');
  const inFlight = nodes.filter((node) => node.state === 'in-flight' || node.state === 'blocked');

  if (nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div className="max-w-md rounded-2xl border border-ink-border bg-panel p-6">
          <h2 className="text-sm font-semibold text-ink-text">Nothing has run here yet.</h2>
          <p className="mt-2 text-xs leading-5 text-ink-text-muted">
            This is a first visit, not a quiet morning — there is no history to summarise. Start work and this becomes the
            record of what happened while you were not watching.
          </p>
        </div>
      </div>
    );
  }

  const lines = handoverSummary({
    awayMs: awayMs ?? 0,
    finished: settled.map((node) => `${node.address} ${node.title}`),
    changedDirection: [],
    wentUnanswered: needsYou.map((node) => `${node.address} ${node.title}`),
    // Work still running is not omitted — it is on the state pane beside this, which is where it
    // belongs. Saying so keeps this from reading as the whole picture.
    omitted: inFlight.length,
  });

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-lg rounded-2xl border border-ink-border bg-panel p-6">
        {/* "While you were away" is a claim about absence. With no recorded absence it is a small lie,
            and small lies in the copy are how a reader learns to discount the rest of it. */}
        <h2 className="font-mono text-[10px] uppercase tracking-wider text-ink-text-muted">
          {awayMs && awayMs > 60_000 ? 'While you were away' : 'Where things stand'}
        </h2>
        <div className="mt-3 space-y-2">
          {lines.slice(1).map((line) => (
            <p key={line} className="text-xs leading-5 text-ink-text-body">{line}</p>
          ))}
        </div>
        <p className="mt-4 pt-3 text-[11px] leading-5" style={{ borderTop: '1px solid #1F1F22', color: '#6A6A72' }}>
          The room is quiet because unit telemetry stays at its own node. Quiet here means the fleet is working, not that
          nothing is.
        </p>
        {pulse && pulse.length > 0 ? (
          <div className="mt-4 pt-4" style={{ borderTop: '1px solid #1F1F22', marginLeft: -16, marginRight: -16 }}>
            <FleetPulse buckets={pulse} last={lastInterruption} now={now} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
