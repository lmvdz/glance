# Wire settled/tail markdown rendering into the transcript
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/AssistantChat.tsx, webapp/src/components/AssistantChat.test.tsx

BLOCKED_BY: 05, 06

## Goal
Streaming assistant entries render through the settled/tail pipeline: the settled prefix parses once per boundary advance (not per WS frame), and only the tail is artifact-suppressed. Completed entries render in one pass, untrimmed.

## Approach
1. Add a `SettledMarkdown` component near the existing `CodeBlock` helper (`AssistantChat.tsx:~109`):
   - `status === 'running'`: `const {settled, tail} = splitSettled(text)`; render `<MemoSettled text={settled}/>` (a `React.memo` leaf whose only prop is the settled string — re-renders only when the boundary advances) followed by a fresh `<Markdown>` over `trimStreamingArtifacts(tail)`.
   - otherwise: single `<Markdown>` over the full raw text — **no trimming of completed content** (malformed final markdown is a model bug and should render as remark parses it).
   - Both halves use the exact markdown config (remark-gfm, remark-breaks, `prose` classes, `CodeBlock` component map) already at the call site — extract that config object once so the two halves and both call sites can't drift.
2. Replace the two `react-markdown` invocations — transcript path (`L541`) and legacy path (`L1269`) — with `SettledMarkdown`. The legacy path never streams (`status` absent → completed branch), so this is a pure consolidation there; it also kills the duplicated-markdown-config pain point ahead of concern 10.
3. Accepted visual artifact (document in code comment): when the boundary crosses a code fence, the fence remounts from tail-tree to settled-tree — one Prism re-highlight flash and copy-state reset per fence. Known, bounded, not a defect to chase.

## Cross-Repo Side Effects
None.

## Verify
- Existing markdown-rendering assertions in `AssistantChat.test.tsx` pass (completed entries render byte-identical markup).
- Add: running entry with a torn table/unclosed `**` renders suppressed tail (no raw `**` in output); settled prefix markup stable across a tail-only text growth (memo assertion via double render).
- Manual: stream a long plan-style response; confirm no torn-syntax flashes and no visible seam at the settled boundary (check list/paragraph spacing across it).
