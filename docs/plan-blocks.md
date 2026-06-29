# Visual plan blocks

Visual plan blocks are fenced code blocks embedded in plan and concern markdown. The fence language selects the block renderer. Parameters are written in the info string after the language token as `key=value` pairs. Every block remains readable on GitHub as a normal syntax-highlighted code block; the webapp renderer owns the richer presentation.

Any block may include `id=<slug>`. Review comments can pin to that id, so prefer stable, human-readable ids such as `id=login-wireframe` or `id=dispatch-flow`.

## Shared authoring rules

- Prefer semantic, minimal bodies. The renderer supplies spacing, borders, typography, and theme behavior.
- Keep ids lowercase, URL-safe slugs: letters, numbers, and hyphens.
- Do not put secrets, tokens, or production customer data in block bodies.
- For HTML-based blocks, authors may use inline `style` only for flex/grid layout and spacing. Never write hex colors, `font-family`, `<style>`, `<script>`, or event handlers.

## `wireframe`

Use `wireframe` for UI sketches that should look like an application surface without becoming production UI code.

Info-string parameters:

| Param | Required | Values | Meaning |
|---|---:|---|---|
| `surface` | yes | `browser`, `desktop`, `mobile`, `popover`, `panel` | Outer frame/chrome to render. |
| `id` | no | slug | Stable comment anchor. |

Body format: semantic HTML using only:

- theme tokens such as `var(--wf-ink)`, `var(--wf-muted)`, `var(--wf-card)`, `var(--wf-paper)`, `var(--wf-border)`, `var(--wf-accent)`, and `var(--wf-danger)`;
- helper classes: `.wf-card`, `.wf-pill`, `.wf-muted`, `.wf-stack`, `.wf-row`, and `button.primary`;
- inline flex/grid layout, gap, padding, and alignment declarations;
- icon markers as `<span data-icon="mail"></span>`.

Authors must not write fixed widths except layout proportions, hex colors, `font-family`, `<style>`, `<script>`, `onclick`, or any other event handler.

Example:

```wireframe surface=browser id=spawn-form
<section class="wf-card wf-stack" style="gap: 16px; padding: 16px;">
  <header class="wf-row" style="justify-content: space-between; align-items: center;">
    <div>
      <p class="wf-muted">Squad launch</p>
      <h2>Create implementation agent</h2>
    </div>
    <span class="wf-pill">Batch 0</span>
  </header>
  <label class="wf-stack" style="gap: 6px;">
    Goal
    <textarea>Implement concern 04 and preserve normal code fences.</textarea>
  </label>
  <button class="primary"><span data-icon="rocket"></span> Launch agent</button>
</section>
```

## `diagram`

Use `diagram` for architecture, flow, and state diagrams that should share the wireframe renderer and sanitization contract but use diagram-specific helper classes.

Info-string parameters:

| Param | Required | Values | Meaning |
|---|---:|---|---|
| `id` | no | slug | Stable comment anchor. |

Body format: semantic HTML using the same allowed tokens and prohibitions as `wireframe`, plus diagram helper classes `.diagram-panel`, `.diagram-card`, and `.diagram-node`.

Example:

```diagram id=dispatch-flow
<div class="diagram-panel wf-stack" style="gap: 12px;">
  <div class="diagram-card">Planner emits concern markdown</div>
  <div class="diagram-node">custom fence</div>
  <div class="diagram-card">PlanBlocks registry dispatches renderer</div>
  <div class="diagram-node">sanitized HTML</div>
  <div class="diagram-card">Reviewer comments pin to block id</div>
</div>
```

## `filetree`

Use `filetree` to show the expected file impact for a concern.

Info-string parameters:

| Param | Required | Values | Meaning |
|---|---:|---|---|
| `id` | no | slug | Stable comment anchor. |

Body format: optional line-oriented file list. If the body is empty, the renderer derives the tree from the concern's `TOUCHES` line.

Supported body lines:

- `path/to/file +added`
- `path/to/file ~modified`
- `path/to/file -removed`
- `old/path -> new/path rename`

Example:

```filetree id=authoring-files
docs/plan-blocks.md +added
webapp/src/components/blocks/__fixtures__/example-plan.md +added
plans/visual-plan-blocks/SKILL-GUIDANCE.md +added
```

## `questions`

Use `questions` when a plan needs reviewer or operator input before implementation. Answers are later written under the concern's `## Decisions` section.

Info-string parameters:

| Param | Required | Values | Meaning |
|---|---:|---|---|
| `id` | yes | slug | Stable form and comment anchor. |

Body format: YAML list. Each item is an object with:

| Field | Required | Values | Meaning |
|---|---:|---|---|
| `id` | yes | slug | Stable answer key. |
| `type` | yes | `single`, `multi`, `freeform` | Input kind. |
| `prompt` | yes | string | Human-facing question. |
| `options` | for `single`/`multi` | string list | Allowed choices. |
| `recommended` | no | string or string list | Suggested answer. |

Example:

```questions id=scope-decisions
- id: landing-gate
  type: single
  prompt: Should this concern block land on unresolved review comments?
  options: [warn-only, hard-block]
  recommended: warn-only
- id: extra-metadata
  type: multi
  prompt: Which metadata should comments capture?
  options: [blockId, author, createdAt, resolvedAt]
  recommended: [blockId, author, createdAt]
- id: rollout-note
  type: freeform
  prompt: What rollout note should be shown to operators?
```

## `annotated`

Use `annotated` for code excerpts with line-range notes in the margin.

Info-string parameters:

| Param | Required | Values | Meaning |
|---|---:|---|---|
| `lang` | yes | language token such as `ts`, `tsx`, `sh`, `json` | Syntax highlighting language. |
| `id` | no | slug | Stable comment anchor. |

Body format: code. Margin notes are declared with single-line comments using this convention:

```text
// @note <line-or-range> <note text>
```

`<line-or-range>` is either a 1-based line number such as `4` or an inclusive range such as `4-7`, counted against the rendered code after note lines are removed. The renderer extracts `// @note` lines and does not show them as code. For non-`//` languages, still use `// @note`; this keeps parsing uniform across examples.

Example:

```annotated lang=ts id=pre-dispatch-check
// @note 2-4 Keep custom block dispatch narrow so normal code fences keep SyntaxHighlighter.
const customBlock = BLOCK_REGISTRY.get(language);
if (!customBlock) {
  return <SyntaxHighlighter language={language}>{body}</SyntaxHighlighter>;
}

return customBlock.render({ body, meta });
```

## `callout`

Use `callout` for decisions, warnings, success states, and neutral implementation notes.

Info-string parameters:

| Param | Required | Values | Meaning |
|---|---:|---|---|
| `tone` | yes | `decision`, `warn`, `ok`, `info` | Visual tone. |
| `id` | no | slug | Stable comment anchor. |

Body format: markdown or plain text.

Example:

```callout tone=decision id=fence-contract
Custom visual blocks are fenced code blocks, not bespoke markdown directives. That keeps raw GitHub rendering readable and lets `react-markdown` expose params through `node.data.meta`.
```

## `columns`

Use `columns` for before/after comparisons, alternatives, or two-sided tradeoffs.

Info-string parameters:

| Param | Required | Values | Meaning |
|---|---:|---|---|
| `id` | no | slug | Stable comment anchor. |

Body format: markdown split into left and right columns by a line containing exactly `---`.

Example:

```columns id=before-after-authoring
Before

- Long prose describes UI states.
- Reviewers infer the intended shape.
- Renderer tests lack a golden fixture.
---
After

- `wireframe` captures the UI shape.
- `questions` captures unresolved decisions.
- The fixture exercises every custom block.
```
