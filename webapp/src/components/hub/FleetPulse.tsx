import React from 'react';
import { duration } from '../../lib/roomState';

/**
 * FleetPulse — events per hour, and the one thing that interrupted you.
 *
 * The reference puts this on the QUIET screen, which is the point: the chart exists to make a calm
 * fleet legible, not to give a busy one a dashboard. Its caption is the design in miniature — *"The
 * dip at 11:00 is the one interruption today. You answered it in three minutes and the fleet
 * recovered on its own."* — a fact, then what it means.
 *
 * A bare bar chart would be the opposite: a shape you have to interpret, on a screen whose whole
 * argument is that you should not have to. So the bars are never shown without the sentence, and the
 * sentence names the interruption rather than describing the curve.
 *
 * It also replaces the reason anyone opened the old workbench "fleet" view, which showed a roster, a
 * filter box and a severity column — the machinery of watching, on a product whose standing law is
 * that watching should not be necessary.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

export interface PulseBucket {
  /** Start of the hour. */
  at: number;
  events: number;
  /** True when a person was interrupted in this hour. */
  interrupted?: boolean;
}

export interface Interruption {
  at: number;
  /** How long it waited before someone answered, when it was answered at all. */
  answeredAfterMs?: number;
  what: string;
}

/**
 * The caption. Names the interruption, or says plainly that there was none — an empty chart with no
 * words under it reads as missing data rather than as a quiet day.
 */
export function pulseCaption(buckets: readonly PulseBucket[], last: Interruption | undefined, now: number): string {
  const total = buckets.reduce((sum, bucket) => sum + bucket.events, 0);
  if (total === 0) return 'Nothing has run in this window. The fleet is idle, not quiet — those are different, and this is the first.';
  if (!last) {
    return `${total} events and not one of them needed you. The fleet has been running itself for the whole window.`;
  }
  const when = new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (last.answeredAfterMs === undefined) {
    return `The dip at ${when} is ${last.what}, and it is still waiting on you. Everything else recovered on its own.`;
  }
  return `The dip at ${when} is ${last.what}. You answered it in ${duration(last.answeredAfterMs)} and the fleet recovered on its own.`;
}

export function FleetPulse({ buckets, last, now }: { buckets: readonly PulseBucket[]; last?: Interruption; now: number }) {
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.events));
  const labelAt = (index: number) => new Date(buckets[index]!.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="px-4">
      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>FLEET PULSE · EVENTS PER HOUR</div>

      <div className="mt-3 flex h-16 items-end gap-1">
        {buckets.map((bucket) => (
          <div key={bucket.at} className="flex h-full flex-1 flex-col justify-end" title={`${bucket.events} events at ${new Date(bucket.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}>
            <div
              className="w-full"
              style={{
                // An hour with nothing in it still draws a hairline. A zero-height bar is
                // indistinguishable from an hour that was never measured.
                height: bucket.events === 0 ? 1 : `${Math.max(4, Math.round((bucket.events / peak) * 100))}%`,
                background: bucket.interrupted ? '#D9A03C' : bucket.events === 0 ? '#26262B' : '#3E5C8A',
              }}
            />
          </div>
        ))}
      </div>

      {buckets.length > 1 ? (
        <div className="mt-1.5 flex justify-between" style={{ fontFamily: MONO, fontSize: 9.5, color: '#3E3E45' }}>
          <div>{labelAt(0)}</div>
          {buckets.length > 2 ? <div>{labelAt(Math.floor(buckets.length / 2))}</div> : null}
          <div>{labelAt(buckets.length - 1)}</div>
        </div>
      ) : null}

      {/* Never the bars alone: a shape you have to interpret, on the screen whose argument is that
          you should not have to. */}
      <div className="mt-2.5 text-[12px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
        {pulseCaption(buckets, last, now)}
      </div>
    </div>
  );
}
