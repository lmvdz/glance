# Design: Visual-plan block vocabulary in the webui

## Outcome

Plan/concern docs (`plans/<name>/NN-concern.md`) render in the React webapp as a
rich, reviewable artifact instead of plain markdown — borrowing the BuilderIO
`visual-plan` pattern set, rendered **natively in our own webapp** (no external
MCP/hosted app). Authors embed typed blocks; the renderer owns the look.

Block vocabulary delivered (full parity at the authoring level):

- **wireframe / diagram** — author writes semantic HTML + theme tokens + a
  `surface` preset; the renderer applies theme, footprint, a rough.js sketch
  overlay, an icon map, and helper classes. One engine, two skins.
- **file-tree** — file-change tree with add/modify/remove/rename badges,
  derivable from the concern's existing `TOUCHES`.
- **questions** — an Open-Questions form (single/multi/freeform, a recommended
  default, always-on write-in); answers are written back into the doc.
- **annotated-code** — line-anchored code with margin notes.
- **callout** (tone=decision/warn/ok/info) and **columns** (before/after).
- **anchored comments** — pin a review comment to a specific block.

## Approach

The webapp already renders concern docs via a `PlanMarkdown` component
(react-markdown + remark-gfm + a `code` override). The whole feature hangs off
that one seam: a **block registry** dispatches custom fenced languages
(```` ```wireframe ````, ```` ```questions ````, …) to React block components,
while everything else falls through to the existing syntax highlighter. Authors
write blocks as fenced code, so raw markdown stays readable on GitHub and round-
trips safely. Block parameters ride on the fence info-string
(`node.data.meta`, verified reachable in react-markdown v10).

Author-written HTML (wireframe/diagram) is an injection surface, so it is
sanitized (DOMPurify) before injection, with `<style>` forbidden and
`url()`/`expression()`/`javascript:` stripped from inline styles. A `--wf-*` CSS
token layer maps the block vocabulary onto our existing palette and flips with
the `.dark` theme.

Crucially, the **authoring convention and a real example plan are built first** —
the renderer is validated against a concrete artifact, and the `/plan` + squad
prompts are updated to emit blocks. A renderer with nothing emitting blocks is
dead code.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Authoring format | Fenced code + info-string params | remark directives (`:::`), HTML comments | Already hooked; readable degraded view; LLM-native; round-trip safe |
| Render hook | `pre` override → block registry; preserve highlighter fallback | branch on `inline`; `code` override | `inline` was removed in react-markdown v10 (current code is dead); `pre` is the unambiguous block signal |
| Param passing | `node.data.meta` | className parsing; rehype plugin; colon-encoding | Verified reachable with zero plugins; className keeps only the first token |
| Block engine | One sanitized-HTML engine; wireframe & diagram are skins | Separate `diagram` block | A second freeform-HTML renderer differing only in CSS is redundant |
| Sanitization | Client-side DOMPurify; forbid `<style>`; strip url/expression; icon-swap pre-sanitize | permissive; server-side | Repo is the trust boundary; client sanitize is sufficient + defense-in-depth |
| Theme tokens | `--wf-*` in `@theme`/`@theme static`; helpers scoped under `.wf-surface` + `not-prose` | `theme()` under `:root` | `theme()` is deprecated in v4 and theme vars are tree-shaken; `prose` would pollute injected HTML |
| Sketch overlay | rough.js outer frame; colors via `getComputedStyle`; redraw on theme/resize | full overlay; CSS-only | rough.js can't read `var()` — would ship invisible; frame-only is the recognizable cue at low cost |
| Open-Questions storage | Write answers into the concern `## Decisions` section | `answers.jsonl` side-log; reuse comments | Decisions are already git-committed, parsed (`features.ts`), surfaced, and reach the worktree agent + Plane; a daemon-local store reaches none of them |
| Comment→agent routing | Reuse existing `/annotations/:id/send?mode=agent` | new `resolutionTarget` field + agent inbox | The send path already exists with a structured prompt + `fenceUntrusted` discipline; a passive field is a cruder, less safe reinvention |
| Anchored comments | Additive `blockId` on the annotation target | new schema | Backward-compatible; fold-on-read tolerates the optional field |
| Concern cut | By file ownership (new files parallelize; shared files single-owner) | by block type | TaskDetail.tsx (1368 lines) and server.ts (1523) can't take parallel edits without merge conflicts |

## Risks

- **rough.js color resolution** — must use `getComputedStyle` and redraw on theme
  toggle; otherwise the overlay is invisible in one theme. Degrade to a CSS
  border if canvas is unavailable (e.g. test render).
- **Highlighter regression** — the `pre` override must preserve the existing
  syntax-highlight path for normal code fences, or all existing plan code blocks
  break.
- **`prose` pollution** — injected block HTML inherits `@tailwindcss/typography`
  rules unless scoped with `not-prose`.
- **Adoption** — blocks rot unless `/plan` and the squad emit them. Mitigated by
  building the authoring spec + example plan first; a promotion-gate on
  unanswered questions is noted as a follow-up forcing function.
- **lucide-react 1.21.0 anomaly** — the installed build is off the public 0.x
  train; verify the icon export shape before relying on it for the icon map.

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| `inline` prop gone in v10; current code dead | critical | Dispatch via `pre` override reading `node`; keep highlighter fallback |
| Params not in className | critical | Read `node.data.meta` (verified) |
| `theme()` deprecated + tree-shaking | critical | `--wf-*` in `@theme`/`@theme static` with literals + defined grays |
| `answers.jsonl` invisible to git/Plane/worktree agent | critical | Answers written into `## Decisions` (already on every consumer path) |
| Agent-routing field reinvents existing send path more crudely | critical | Reuse `/annotations/:id/send?mode=agent`; comments human-only otherwise |
| Authoring deferred to last → blocks rot | critical | Authoring spec + example plan + skill diff are batch 0 |
| `diagram` redundant with DAG + wireframe | significant | Unified into the one HTML engine as a skin |
| Plan-annotation comments over-sync to Plane | significant | Gate Plane sync by comment kind (pre-existing bug, fixed here) |
| Shared-file contention breaks parallel batches | significant | Re-cut by file ownership; extract `PlanBlocks.tsx` |
| rough.js can't read `var()` | significant | `getComputedStyle` + theme-aware redraw |
| Second JSONL side-log vs DAL | significant | No new side-log; reuse `comments.jsonl` with additive `blockId` |
| RLS leak for side-logs | (withdrawn) | Per-org `stateDir` already isolates `comments.jsonl` — inaccurate attack |

## Open Questions

None blocking. One deferred decision recorded as a follow-up: whether to gate
`/promote-issue` (Backlog→Todo) on unanswered Open-Questions as an adoption
forcing function — out of scope for the renderer, tracked for the skill layer.
