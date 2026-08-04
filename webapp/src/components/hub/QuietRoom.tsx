import React from 'react';
import { duration, handoverSummary, nodeStatusLine, type RoomNode } from '../../lib/roomState';
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
 * `01-room.html` gives it a name — **WHAT GOT DONE WHILE YOU DIDN'T LOOK** — and a shape: zones down
 * the conversation column, each line a fact with its own meta underneath, with FLEET PULSE beneath
 * them. The first version of this put the whole handover in a rounded card floated in the middle of an
 * empty column, which reads as a dialog interrupting a room rather than as the room's own account of
 * itself. Nothing else in the design is boxed; this should not have been either.
 *
 * It still distinguishes what finished, what changed direction, and what needed a person and got no
 * answer — and it still says what it left out, because a bounded summary that does not admit its
 * bounds reads as a complete one.
 *
 * When there is genuinely no history at all — a fresh install, nothing has ever run — it says that
 * instead. "Nothing has happened yet" and "nothing happened while you were away" are different facts
 * and must not share a screen.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

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
  // `idle` counts as "still on the state pane", because that is what `omitted` measures — what this
  // handover deliberately left out, not what is executing. Excluding it made the handover claim "that
  // is everything, not a selection" while idle units sat unmentioned in the pane beside it.
  const onPane = nodes.filter((node) => node.state === 'in-flight' || node.state === 'blocked' || node.state === 'idle');
  // Genuinely executing work, which is a narrower question and the one the closing line answers.
  const running = nodes.filter((node) => node.state === 'in-flight' || node.state === 'blocked');

  if (nodes.length === 0) {
    return (
      <div className="flex h-full flex-col justify-end px-6 pb-8">
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>NOTHING HAS RUN HERE YET</div>
        <div className="mt-2.5 max-w-[560px] text-[13px] leading-[1.6]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>
          This is a first visit, not a quiet morning — there is no history to summarise. Start work from the line below and
          this becomes the record of what happened while you were not watching.
        </div>
      </div>
    );
  }

  const away = awayMs && awayMs > 60_000 ? awayMs : undefined;
  const lines = handoverSummary({
    awayMs: awayMs ?? 0,
    finished: settled.map((node) => `${node.address} ${node.title}`),
    changedDirection: [],
    wentUnanswered: needsYou.map((node) => `${node.address} ${node.title}`),
    // Work still on the pane is not omitted by accident — it is beside this, which is where it
    // belongs. Saying so keeps this from reading as the whole picture.
    omitted: onPane.length,
  });

  return (
    <div className="flex h-full min-h-0 flex-col justify-end overflow-y-auto px-6 pb-6 pt-8">
      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>
        {/* The reference's heading — "WHAT GOT DONE WHILE YOU DIDN'T LOOK" — is itself a claim about an
            absence, so it is only used when there was one. With no recorded absence it becomes WHERE
            THINGS STAND, which claims nothing. Small lies in the copy are how a reader learns to
            discount the rest of it, and this one was caught by its own test rather than by reading. */}
        {away ? `WHAT GOT DONE WHILE YOU DIDN'T LOOK · ${duration(away).toUpperCase()}` : 'WHERE THINGS STAND'}
      </div>

      {settled.length > 0 ? (
        <div className="mt-3 flex max-w-[660px] flex-col">
          {settled.slice(0, 6).map((node) => (
            <div key={node.id} className="flex gap-3 py-2" style={{ borderTop: '1px solid #17171A' }}>
              <div className="mt-[7px] h-[5px] w-[5px] flex-none rounded-full" style={{ background: '#3E7D57' }} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{node.title}</div>
                <div className="mt-[3px] truncate" style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>
                  {node.address} · {nodeStatusLine(node, now)}
                </div>
              </div>
            </div>
          ))}
          {settled.length > 6 ? (
            <div className="pt-2" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>and {settled.length - 6} more, all finished</div>
          ) : null}
        </div>
      ) : null}

      {/* The prose handover carries what a list cannot: that nothing needed you, and what was left out.
          When the finished work is already listed above, its line is dropped rather than repeated. */}
      <div className="mt-3.5 flex max-w-[660px] flex-col gap-1.5">
        {lines.slice(settled.length > 0 ? 2 : 1).map((line) => (
          <div key={line} className="text-[12.5px] leading-[1.55]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>{line}</div>
        ))}
      </div>

      {/* "Quiet means the fleet is working" is only true when something IS working. With units present
          but none of them executing, that sentence is exactly the reassuring lie this whole surface is
          meant not to tell — so it is stated conditionally rather than printed as decoration. */}
      <div className="mt-3 max-w-[660px] text-[11.5px] leading-[1.5]" style={{ color: '#4A4A52', textWrap: 'pretty' }}>
        {running.length > 0
          ? 'The room is quiet because unit telemetry stays at its own node. Quiet here means the fleet is working, not that nothing is.'
          : onPane.length > 0
            ? `The room is quiet because nothing is running. ${onPane.length} unit${onPane.length === 1 ? ' is' : 's are'} idle — alive, but not working on anything, so this quiet is not progress.`
            : 'The room is quiet because nothing is running and no unit is waiting to. Nothing is being worked on right now.'}
      </div>

      {pulse && pulse.length > 0 ? (
        <div className="mt-6 max-w-[660px] pt-5" style={{ borderTop: '1px solid #1F1F22' }}>
          <FleetPulse buckets={pulse} last={lastInterruption} now={now} />
        </div>
      ) : null}
    </div>
  );
}
