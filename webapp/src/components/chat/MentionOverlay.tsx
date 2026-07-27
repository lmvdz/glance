import React from 'react';

/**
 * MentionOverlay — mentions as chips, without changing what gets sent.
 *
 * The composer's wire format is `[@pike](omp://agent/pike-ms24cs99-2-0a509ab2)`, and it has to stay
 * that way: `resolveMentionRoute` parses it to decide whether a message steers an existing unit or
 * spawns one. But that is an ADDRESS, and the standing rule is identity at a glance, address on
 * demand — a person typing to Pike should see "@pike", not a UUID in brackets.
 *
 * So the textarea keeps the exact text and renders transparent, and this draws underneath it: same
 * font, same padding, same wrapping, with the mention spans painted as chips. The caret still lands
 * where the real characters are, because the real characters are still there — they are just drawn by
 * something that knows what they mean.
 */

/** Readable tokens the composer inserts: `@pike`. Same width as what is drawn, so nothing shifts. */
const TOKEN_RE = /(?<![\w@-])@[A-Za-z0-9][\w.-]*/g;

export interface MentionSegment {
  kind: 'text' | 'mention';
  text: string;
  /** For a mention: the label a person reads. */
  label?: string;
  target?: 'agent' | 'issue' | 'capability';
}

/** Split composer text into plain runs and mentions, preserving every character's position. */
export function segmentMentions(text: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const at = match.index ?? 0;
    // Absorb ONE adjacent space on each side into the chip. The padding is then made of real
    // characters, so it costs no layout at all — a box-shadow spread wide enough to breathe reaches
    // over the neighbouring words instead, and a CSS padding would push everything after it along.
    const from = at > 0 && text[at - 1] === ' ' ? at - 1 : at;
    const rawEnd = at + match[0].length;
    const to = text[rawEnd] === ' ' ? rawEnd + 1 : rawEnd;
    if (from > last) out.push({ kind: 'text', text: text.slice(last, from) });
    out.push({ kind: 'mention', text: text.slice(from, to), label: match[0].slice(1), target: 'agent' });
    last = to;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

export function MentionOverlay({ text }: { text: string }) {
  const segments = segmentMentions(text);
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 whitespace-pre-wrap break-words px-3 py-2.5 text-body leading-6"
      style={{ color: 'var(--color-ink-text-body)' }}
    >
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          <span key={index}>{segment.text}</span>
        ) : (
          // The chip covers exactly the characters it replaces, so the caret never drifts: the real
          // text is still underneath, drawn transparent, and this is painted over the same box.
          // The token and the chip are the SAME characters, so the caret never drifts and the text
          // after a mention does not get pushed across the line — which is exactly what went wrong
          // when the chip was painted over the full address.
          <span
            key={index}
            style={{
              color: '#F0A35A',
              borderRadius: 3,
              // Breathing room WITHOUT layout: padding would make the chip wider than the token it
              // covers, and the caret would drift by exactly that much on every keystroke after it.
              // A box-shadow spread paints outside the box and occupies no space at all — the fill
              // and the edge both come from here rather than from `background` and `padding`.
              // Only a hairline edge now: the breathing room comes from the absorbed spaces above, so
              // the decoration no longer has to reach outside its own box to find any.
              boxShadow: 'inset 0 0 0 1px #3A2E20',
              background: '#1E1A14',
            }}
          >
            {segment.text}
          </span>
        ),
      )}
      {/* A trailing newline is not rendered by the browser without something after it, so the overlay
          would shrink below the textarea on the last line. */}
      {text.endsWith('\n') ? <span>{'​'}</span> : null}
    </div>
  );
}

/** The wire format, as it appears in a SENT message: `[@pike](omp://agent/pike-…)`. */
const LINK_RE = /\[@([^\]]+)\]\(omp:\/\/(agent|issue|capability)\/([^)]+)\)/g;

/** Split a sent message body into plain runs and mention links. */
export function segmentMentionLinks(text: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK_RE)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) });
    out.push({ kind: 'mention', text: match[0], label: match[1], target: match[2] as MentionSegment['target'] });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * A sent message with its mentions as chips.
 *
 * The composer was fixed to show `@pike` while typing, but the message that ARRIVES carries the wire
 * format — so the room was still showing every reader a UUID in brackets. Both surfaces have to speak
 * the same way or the fix is only half done, and the half that everyone else reads is the wrong half.
 */
export function MentionedText({ text }: { text: string }) {
  const segments = segmentMentionLinks(text);
  if (segments.length === 1 && segments[0]!.kind === 'text') return <>{text}</>;
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <span
            key={index}
            style={{ color: '#F0A35A', borderRadius: 3, background: '#1E1A14', boxShadow: 'inset 0 0 0 1px #3A2E20', padding: '1px 4px', margin: '0 1px' }}
            // Shortening never means losing: the address is one hover away.
            title={segment.text}
          >
            @{segment.label}
          </span>
        ),
      )}
    </>
  );
}
