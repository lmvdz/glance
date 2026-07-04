/**
 * streamingMarkdown.ts — settled-boundary split + streaming-artifact suppression
 * for WS-streamed assistant markdown.
 *
 * Pure string functions, no React / no remark. Two jobs:
 *
 * 1. `findSettledBoundary` / `splitSettled` — split accumulated streaming text
 *    at a safe "settled" boundary so the prefix can be render-memoized and only
 *    the small unsettled tail is re-parsed per WS frame.
 * 2. `trimStreamingArtifacts` — clean the unsettled *tail* so half-typed
 *    markdown syntax (unclosed links, stray `**`, torn tables) never flashes
 *    raw while an entry is streaming.
 *
 * Boundary rule (paragraph-level only, per plan DESIGN.md): a candidate
 * boundary is a blank line that is (a) outside any fenced code block,
 * (b) truly at column 0 (an empty line — whitespace-only lines don't qualify),
 * and (c) followed by a line that is neither indented (any leading
 * space/tab — covers both 4-space code blocks and 1-3-space list
 * continuations) nor a list-item continuation of a list already in progress.
 * The last qualifying blank line wins; the tail begins on the line after it.
 *
 * INVARIANTS
 * - `splitSettled(x).settled + splitSettled(x).tail === x` for all inputs.
 * - The boundary is computed on the RAW accumulated text, never on trimmed
 *   text. Artifact suppression applies to the tail only, downstream of the
 *   split — by pipeline construction (see plan DESIGN.md).
 * - The boundary can move *backward* between frames (e.g. an indented
 *   continuation line arrives and disqualifies the previous candidate);
 *   callers must treat the settled prefix as a memo key, not as append-only.
 *
 * Artifact rules (ported from astryx `packages/core/src/Markdown/parser.ts`
 * — `trimStreamingArtifacts` + `trimUnsettledStructural` at commit deb5aa0,
 * MIT, Copyright (c) Meta Platforms, Inc. and affiliates — reimplemented for
 * our settled/tail shape):
 * - Trim a trailing unclosed `[` / `![` link/image opener.
 * - Trim trailing unpaired `` ` `` / `*` / `~~` markers.
 * - Auto-close mid-line unclosed `**bold` / `*em` (render formatting live
 *   rather than hiding the text).
 * - Hold back a trailing bare `- ` / `* ` / `1. ` list marker with no content.
 * - Hold back a lone table-header line until its `|---|` separator row
 *   arrives; once a table is established, new rows pass through immediately.
 * - If the tail currently ends inside an unclosed code fence, it is returned
 *   untouched — code content must never be mutated by inline/structural rules.
 * All rules are idempotent (`trim(trim(x)) === trim(x)`) and are the identity
 * on well-formed markdown.
 *
 * KNOWN ACCEPTED LIMITATIONS (two independent remark trees over the seam):
 * - Reference-link definitions / footnotes defined in the settled prefix do
 *   not resolve in the tail — heals at stream end when the entry completes
 *   and renders as a single tree.
 * - A single fence longer than the whole entry means the boundary never
 *   advances past the fence opener (degenerates to status-quo full re-parse
 *   of the tail; the per-entry memo from concern 01 still bounds the cost to
 *   one entry).
 */

/** Matches a line that begins a bullet or ordered list item. */
const LIST_MARKER_RE = /^([-*+]|\d{1,9}[.)])([ \t]|$)/;

/** Trailing bare list markers with no content yet (held back while streaming). */
const BARE_BULLET_RE = /^ {0,9}[-*+][ \t]*$/;
const BARE_ORDERED_RE = /^ {0,9}\d{1,9}[.)][ \t]*$/;

interface FenceState {
  open: boolean;
  marker: string;
}

/**
 * Line-by-line fence tracking for ``` and ~~~ fences (up to 3 leading spaces,
 * per CommonMark). Opening backtick fences may carry an info string (which
 * cannot itself contain a backtick); a closing fence must be bare, use the
 * same marker character, and be at least as long as the opener.
 */
function updateFenceState(state: FenceState, line: string): void {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!m) return;
  const marker = m[1];
  const rest = m[2];
  if (!state.open) {
    if (marker[0] === "`" && rest.includes("`")) return; // code span, not a fence
    state.open = true;
    state.marker = marker;
  } else if (
    marker[0] === state.marker[0] &&
    marker.length >= state.marker.length &&
    rest.trim() === ""
  ) {
    state.open = false;
    state.marker = "";
  }
}

/** True when `text`'s final line is inside an unclosed fenced code block. */
function endsInsideFence(text: string): boolean {
  const state: FenceState = { open: false, marker: "" };
  for (const line of text.split("\n")) updateFenceState(state, line);
  return state.open;
}

/** True when `line` reads as list content (a marker line or indented continuation). */
function isListContext(line: string): boolean {
  return /^[ \t]/.test(line) || LIST_MARKER_RE.test(line);
}

/**
 * Character offset where the unsettled tail begins. Everything before it is
 * "settled": safe to parse once and memoize as its own markdown tree.
 * Returns 0 when nothing is settled yet.
 */
export function findSettledBoundary(text: string): number {
  if (!text.includes("\n")) return 0;
  const lines = text.split("\n");
  const n = lines.length;

  // Forward pass: line start offsets, fence state entering each line, and the
  // nearest non-blank line above each line.
  const starts = new Array<number>(n);
  const inFenceAt = new Array<boolean>(n);
  const prevNonBlank = new Array<string | null>(n);
  const fence: FenceState = { open: false, marker: "" };
  let pos = 0;
  let lastContent: string | null = null;
  for (let i = 0; i < n; i++) {
    starts[i] = pos;
    inFenceAt[i] = fence.open;
    prevNonBlank[i] = lastContent;
    const line = lines[i];
    updateFenceState(fence, line);
    if (line.trim() !== "") lastContent = line;
    pos += line.length + 1;
  }

  // Backward pass: index of the nearest non-blank line strictly below each line.
  const nextNonBlank = new Array<number>(n);
  let next = -1;
  for (let i = n - 1; i >= 0; i--) {
    nextNonBlank[i] = next;
    if (lines[i].trim() !== "") next = i;
  }

  // Last qualifying blank line wins.
  for (let i = n - 1; i >= 1; i--) {
    if (lines[i] !== "") continue; // (b) blank AND at column 0
    if (inFenceAt[i]) continue; // (a) outside any fence
    const prev = prevNonBlank[i];
    if (prev === null) continue; // nothing to settle above
    const j = nextNonBlank[i];
    if (j === -1) continue; // tail content hasn't arrived — can't verify (c) yet
    const following = lines[j];
    if (/^[ \t]/.test(following)) continue; // (c) indented continuation / code block
    if (LIST_MARKER_RE.test(following) && isListContext(prev)) continue; // (c) loose-list continuation
    return starts[i] + 1; // tail begins on the line after the blank
  }
  return 0;
}

/**
 * Split raw streaming text into a memoizable settled prefix and the live tail.
 * Operates on the RAW input — never trim before splitting.
 */
export function splitSettled(text: string): { settled: string; tail: string } {
  const boundary = findSettledBoundary(text);
  return { settled: text.slice(0, boundary), tail: text.slice(boundary) };
}

/**
 * Mask complete inline code spans (`like this`) with spaces so emphasis /
 * strikethrough scanning ignores markers inside them. Positions are preserved.
 */
function maskCodeSpans(line: string): string {
  return line.replace(/`[^`]+`/g, (span) => " ".repeat(span.length));
}

/** GFM table separator row: cells contain only dashes/colons. */
function isTableSeparator(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = line.split("|").map((cell) => cell.trim());
  const nonEmpty = cells.filter((cell) => cell.length > 0);
  return nonEmpty.length > 0 && nonEmpty.every((cell) => /^:?-+:?$/.test(cell));
}

/**
 * True when `line` reads as a potential GFM table-header row: it must START
 * with (optional leading whitespace, then) `|` — a pipe appearing later in
 * the line is just punctuation/code, not a table opener. Inline code spans
 * are masked first so a pipe inside `` `like this` `` (e.g. prose like
 * "Run `foo | bar` to filter") never reads as a table.
 */
function looksLikeTableHeaderStart(line: string): boolean {
  return /^[ \t]*\|/.test(maskCodeSpans(line));
}

/**
 * Inline artifact pass — only ever rewrites the final (still-arriving) line.
 */
function trimInlineArtifacts(input: string): string {
  const lastNL = input.lastIndexOf("\n");
  const prefix = lastNL === -1 ? "" : input.slice(0, lastNL + 1);
  let tail = lastNL === -1 ? input : input.slice(lastNL + 1);

  // 1. Unclosed [ / ![ link/image openers. A bracket is unresolved when no `]`
  //    follows it, or when its `](` destination opened but hasn't closed.
  //    Loop so stacked openers ("[a [b") all trim — keeps the pass idempotent.
  for (;;) {
    const lastBracket = tail.lastIndexOf("[");
    if (lastBracket === -1) break;
    const after = tail.slice(lastBracket);
    const closeText = after.indexOf("]");
    if (closeText !== -1) {
      const dest = after.indexOf("](");
      if (dest === -1 || after.indexOf(")", dest) !== -1) break; // resolved
    }
    const trimTo = lastBracket > 0 && tail[lastBracket - 1] === "!" ? lastBracket - 1 : lastBracket;
    tail = tail.slice(0, trimTo);
  }

  // 2. Trailing backticks with no matching opener.
  let end = tail.length;
  while (end > 0 && tail[end - 1] === "`") end--;
  if (end < tail.length && end > 0) {
    const ticks = tail.length - end;
    const opener = tail.lastIndexOf("`".repeat(ticks), end - 1);
    if (opener === -1) tail = tail.slice(0, end);
  }

  // 3. Trailing run of stars (no content after it yet) with no opener.
  end = tail.length;
  while (end > 0 && tail[end - 1] === "*") end--;
  if (end < tail.length && end > 0) {
    const stars = tail.length - end;
    if (stars <= 3 && maskCodeSpans(tail).lastIndexOf("*".repeat(stars), end - 1) === -1) {
      tail = tail.slice(0, end);
    }
  }

  // 4. Mid-line unclosed emphasis: auto-close (render formatting live rather
  //    than hiding streamed text). Stars inside complete code spans are
  //    ignored, as is a leading `* ` list bullet.
  {
    const masked = maskCodeSpans(tail);
    const markers: { pos: number; len: number }[] = [];
    let searchFrom = 0;
    const bulletMatch = masked.match(/^ {0,3}\* /);
    if (bulletMatch) searchFrom = bulletMatch[0].length;
    while (searchFrom < masked.length) {
      const idx = masked.indexOf("*", searchFrom);
      if (idx === -1) break;
      let markerLen = 1;
      while (idx + markerLen < masked.length && masked[idx + markerLen] === "*") markerLen++;
      if (markerLen > 3) {
        // 4+ stars — not standard emphasis, skip
        searchFrom = idx + markerLen;
        continue;
      }
      markers.push({ pos: idx, len: markerLen });
      searchFrom = idx + markerLen;
    }
    // Pair same-length markers greedily; unpaired openers get auto-closed.
    const paired = new Set<number>();
    for (let i = 0; i < markers.length; i++) {
      if (paired.has(i)) continue;
      for (let j = i + 1; j < markers.length; j++) {
        if (paired.has(j)) continue;
        if (markers[j].len === markers[i].len) {
          paired.add(i);
          paired.add(j);
          break;
        }
      }
    }
    for (let i = markers.length - 1; i >= 0; i--) {
      if (paired.has(i)) continue;
      const marker = markers[i];
      if (marker.pos + marker.len < tail.length) {
        tail = tail + "*".repeat(marker.len); // content follows — close it
      } else {
        tail = tail.slice(0, marker.pos); // bare trailing marker — trim it
      }
    }
  }

  // 5. Strikethrough. Trailing unpaired ~~ / lone ~ trims; a mid-line odd
  //    count of ~~ trims from the last (unclosed) opener.
  if (tail.length >= 2 && tail.endsWith("~~")) {
    if (maskCodeSpans(tail).lastIndexOf("~~", tail.length - 3) === -1) tail = tail.slice(0, -2);
  } else if (tail.endsWith("~") && (tail.length < 2 || tail[tail.length - 2] !== "~")) {
    tail = tail.slice(0, -1);
  }
  {
    const masked = maskCodeSpans(tail);
    const positions: number[] = [];
    let searchFrom = 0;
    for (;;) {
      const idx = masked.indexOf("~~", searchFrom);
      if (idx === -1) break;
      positions.push(idx);
      searchFrom = idx + 2;
    }
    if (positions.length % 2 === 1) tail = tail.slice(0, positions[positions.length - 1]);
  }

  return prefix + tail;
}

/**
 * Structural pass — drop trailing lines that look like the start of a block
 * but aren't structurally complete yet (bare bullets, a lone table header
 * without its separator row, an orphan separator). Returns the input
 * unchanged when nothing structural was held back, so well-formed markdown
 * (including a trailing newline) passes through as the identity.
 */
function trimUnsettledStructural(text: string): string {
  const lines = text.split("\n");
  let removed = false;

  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    const trimmed = last.trim();

    // Blank trailing lines: skip past them (only kept out of the result if a
    // structural line beneath them is also held back).
    if (trimmed === "") {
      lines.pop();
      continue;
    }

    // Bare list marker with no content yet.
    if (BARE_BULLET_RE.test(last) || BARE_ORDERED_RE.test(last)) {
      lines.pop();
      removed = true;
      continue;
    }

    // Lone table-header line: hold back until the separator row arrives.
    // Once a table is established (header + separator above), new rows pass.
    // Only a line that STARTS with (optional whitespace +) `|` is a
    // candidate — a pipe appearing later in a prose line (e.g. "Run `foo |
    // bar` to filter", or even bare "use a | b delimiter") is not a table
    // opener and must never be held back from view.
    if (looksLikeTableHeaderStart(last) && !isTableSeparator(last)) {
      let established = false;
      for (let i = lines.length - 2; i >= 1; i--) {
        if (isTableSeparator(lines[i]) && lines[i - 1].includes("|")) {
          established = true;
          break;
        }
      }
      if (!established) {
        lines.pop();
        removed = true;
        continue;
      }
    }

    // Separator row without a header line above it.
    if (isTableSeparator(last)) {
      if (lines.length < 2 || !lines[lines.length - 2].includes("|")) {
        lines.pop();
        removed = true;
        continue;
      }
    }

    break; // this line looks complete — stop trimming
  }

  return removed ? lines.join("\n") : text;
}

/**
 * Clean the unsettled streaming tail before it reaches the markdown renderer.
 * Apply ONLY to the tail of `splitSettled` while an entry is streaming — never
 * to the settled prefix, and never to completed entries.
 */
export function trimStreamingArtifacts(tail: string): string {
  if (tail === "") return tail;
  // Inside an unclosed fence the "tail" is code content — never rewrite it.
  if (endsInsideFence(tail)) return tail;
  return trimUnsettledStructural(trimInlineArtifacts(tail));
}
