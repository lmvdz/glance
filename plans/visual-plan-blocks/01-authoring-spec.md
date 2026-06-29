# Authoring spec, example fixture, and skill-guidance deliverable
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: docs/plan-blocks.md, webapp/src/components/blocks/__fixtures__/example-plan.md, plans/visual-plan-blocks/SKILL-GUIDANCE.md

## Goal

Define the markdown authoring convention for the visual-plan block vocabulary and
produce the artifacts that drive adoption. This concern ships FIRST so the
renderer (concerns 04-09) is validated against a concrete example, and so the
authoring path (`/plan` + squad) actually emits blocks instead of leaving them as
dead code. No renderer code here — just the spec, a fixture, and a guidance doc.

## Approach

Authoring convention = fenced code blocks. The fence language selects the block;
parameters ride on the info-string (the text after the language token), which the
renderer reads from `node.data.meta`. Raw markdown stays readable on GitHub
(degrades to a syntax-highlighted code block).

1. **Write `docs/plan-blocks.md`** — the authoring spec. Document each block with
   its fence language, params, body format, and a copy-pasteable example:
   - ` ```wireframe surface=browser id=login ` — body is semantic HTML using only
     theme tokens (`var(--wf-ink)`, `var(--wf-card)`, …), helper classes
     (`.wf-card`, `.wf-pill`, `.wf-muted`, `button.primary`), inline flex/grid
     layout, and `<span data-icon="mail"></span>` icon markers. Authors NEVER
     write widths beyond layout, hex colors, `font-family`, `<style>`, `<script>`,
     or event handlers. `surface` ∈ {browser, desktop, mobile, popover, panel}.
   - ` ```diagram id=flow ` — same engine/contract as wireframe, diagram skin
     (use `.diagram-panel`, `.diagram-card`, `.diagram-node` helper classes).
   - ` ```filetree ` — body is optional; if empty, the renderer derives the tree
     from the concern's `TOUCHES`. Optional body lines: `path/to/file +added`,
     `... ~modified`, `... -removed`, `old -> new rename`.
   - ` ```questions id=auth ` — YAML body; list of `{id, type: single|multi|freeform,
     prompt, options?: [...], recommended?}`. `id=` is REQUIRED on questions blocks.
   - ` ```annotated lang=ts ` — body is code; margin notes via a leading note
     block or a `note:` convention (define one: e.g. lines starting with
     `// @note <lines> <text>` extracted by the renderer). Pick the simplest
     parseable convention and document it precisely.
   - ` ```callout tone=decision ` — tone ∈ {decision, warn, ok, info}; body is
     markdown/plain text.
   - ` ```columns ` — body separated by a `---` line into left/right (before/after).
   - **Comment anchoring:** any block may carry `id=<slug>`; document that a
     review comment can pin to that id (consumed by concern 10).
2. **Write the example fixture** `webapp/src/components/blocks/__fixtures__/example-plan.md`
   — a single concern-style markdown doc that exercises EVERY block at least
   once, with realistic omp-squad content (an infra/backend plan, since that's
   this tool's typical plan). This is the renderer's golden input for concerns
   04-09 and the test in 11.
3. **Write `plans/visual-plan-blocks/SKILL-GUIDANCE.md`** — a deliverable (NOT an
   edit to `~/.claude/skills`, which lives outside this repo and the worktree/land
   model) that specifies the exact additions to make to the `/plan` skill's
   DECOMPOSE phase and the squad plan-authoring prompt: when to use each block,
   and a relaxation of the current "No code blocks in human docs" rule to permit
   these specific block fences. The user applies it to the skill files manually.

## Cross-Repo Side Effects

None in-repo. The SKILL-GUIDANCE.md is consumed by a human to update
`~/.claude/skills/plan/SKILL.md` and squad prompts later.

## Verify

- `docs/plan-blocks.md` documents all 7 block languages with params + an example each.
- `webapp/src/components/blocks/__fixtures__/example-plan.md` contains at least one
  of every block (`grep -c '```\(wireframe\|diagram\|filetree\|questions\|annotated\|callout\|columns\)' ` ≥ 7).
- `SKILL-GUIDANCE.md` names the concrete `/plan` DECOMPOSE additions and the
  code-block-rule relaxation.
- The fixture is internally consistent with the spec (a human read confirms an
  agent could author it from the spec alone).
