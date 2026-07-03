# Visual plan blocks: skill guidance deliverable

This file is the in-repo handoff for later manual edits to the `/plan` skill and squad plan-authoring prompts. Do not edit `~/.claude/skills` from this concern; those files live outside the repo and outside the worktree/land model.

## `/plan` skill: DECOMPOSE additions

Add these requirements to the DECOMPOSE phase after concern boundaries and dependencies are known:

1. **Emit visual block fences for reviewable concerns.** Use the fenced block languages documented in `docs/plan-blocks.md`; do not invent new languages in plan output.
2. **Use `wireframe` for UI concerns.** Include at least one `wireframe surface=<browser|desktop|mobile|popover|panel>` block when a concern changes user-visible layout, navigation, forms, dashboards, or operator controls.
3. **Use `diagram` for architecture or state flow.** Include a `diagram` block when a concern changes data flow, lifecycle state, dispatch order, security boundaries, or cross-process interactions.
4. **Use `filetree` for expected file impact.** Include `filetree` when `TOUCHES` spans multiple directories or when added/modified/removed/renamed status matters. Leave the body empty only when the concern's `TOUCHES` line is already sufficient.
5. **Use `questions` for unresolved decisions.** Include `questions id=<slug>` when implementation depends on a reviewer/operator choice. Every question must have a stable `id`, a `type`, a human prompt, and options for `single`/`multi` questions.
6. **Use `annotated` for important snippets.** Include `annotated lang=<token>` when showing a contract, schema, command, or code path where margin notes reduce ambiguity. Notes must use `// @note <line-or-range> <text>`.
7. **Use `callout` for decisions and warnings.** Prefer `callout tone=decision` for settled plan decisions, `tone=warn` for risks, `tone=ok` for verified facts, and `tone=info` for neutral context.
8. **Use `columns` for before/after or alternatives.** Split the body with a line containing exactly `---`.
9. **Anchor blocks with ids when discussion is likely.** Any visual block may include `id=<slug>` so review comments can pin to that block later.
10. **Keep raw markdown useful.** The plan must still be readable on GitHub as fenced code blocks. Put the why/acceptance text outside blocks; use blocks to clarify shape, flow, files, decisions, and examples.

## Squad plan-authoring prompt additions

Add this instruction to squad prompts that author or revise plan concerns:

> When authoring concern markdown, you may use the visual plan block fence languages from `docs/plan-blocks.md`: `wireframe`, `diagram`, `filetree`, `questions`, `annotated`, `callout`, and `columns`. Use them only when they make review easier. Preserve the concern frontmatter (`STATUS`, `PRIORITY`, `REPOS`, `COMPLEXITY`, `TOUCHES`) and normal prose sections. Do not add renderer implementation code to a docs/spec concern.

Add these selection rules to the same prompt:

- UI or operator experience change → include `wireframe`.
- Backend/infrastructure flow, lifecycle, or trust boundary → include `diagram`.
- Multi-file change or renamed/removed files → include `filetree`.
- Open product, rollout, or implementation choice → include `questions`.
- Contract/schema/snippet that needs line-level explanation → include `annotated`.
- Non-obvious decision, verified fact, risk, or warning → include `callout`.
- Before/after, old/new, option A/B → include `columns`.

## Code-block rule relaxation

Current human-doc guidance that says "No code blocks in human docs" should be relaxed as follows:

> Human-facing plan docs should avoid arbitrary code blocks, but may use the approved visual plan block fences `wireframe`, `diagram`, `filetree`, `questions`, `annotated`, `callout`, and `columns` as authoring primitives. These fences are part of the plan vocabulary, not incidental code dumps. Normal implementation code fences remain allowed only when they are short, necessary, and preferably represented with `annotated`.

## Authoring guardrails

- Do not use raw HTML outside `wireframe` or `diagram` blocks.
- In `wireframe` and `diagram`, use theme tokens and helper classes only; never include `<style>`, `<script>`, event handlers, hex colors, or font-family declarations.
- Prefer stable `id=` params. Changing ids can break anchored review comments.
- Keep block bodies compact enough for reviewers to scan.
- Do not add new dependencies, renderer files, or app code as part of this guidance deliverable.
