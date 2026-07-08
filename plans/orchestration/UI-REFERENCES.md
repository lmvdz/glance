# UI Reference Extraction — 2026-07-07

Source: 11 screenshots in this directory (user-provided reference UIs). Goal: remold the glance
webapp toward their structural + visual language. Every claim below is anchored to a screenshot.

## The four reference systems

**A. Task workspace w/ typed session pipeline** (213016, 213038 — "riptide"-style)
- 3-pane: left TASKS rail (plain text list, active row highlighted, `+ New Task` w/ hotkey chip
  `N`) · center task/document detail · right ARTIFACTS rail (tabs: ARTIFACTS / SUMMARY / AUTO).
- A task is a **pipeline of typed sessions**: rows with status chip (DONE/RUNNING/IDLE/DRAFT) +
  title + type chip (Research / Design / Structure / Plan / Implementation) + updated-ago.
- Artifacts (research.md, design-discussion.md, structure-outline.md, mockup.html,
  implementation-plan.md) are first-class, each with a comment count badge.
- Task header: name + `SHARED WITH ORG` chip + issue-id chip + repo path + two primary actions
  (`Create Session`, `Create Design Discussion →`).
- Presence: small stacked avatar chips (humans = warm colors, agent = teal bot glyph).

**B. Collaborative design-review loop** (213103, 213119, 213130, 213157, 213209, 213221, 213231)
- A living design doc (fixed section skeleton: Summary · Current State · UI Mockup · Technical
  Design · Desired End State · **What we are not doing**) reviewed by humans + agent together.
- Right comments rail; top progress bar **"Design Review N/M resolved"** with a narration line
  ("Agent rewrites the hotkey behavior…"); terminal state: "All comments resolved, ready to
  implement!" — review-resolution as an explicit GATE before implementation.
- The agent **edits the doc live in response to comments**: strikethrough removed line + highlight
  inserted line (both visible, diff-style, in place); embedded artifacts update too — a UI mockup
  thumbnail flips layout ("flagged for change" → "✓ updated"), a sequence diagram gains a lane
  (SplineAPI) when a reviewer objects.
- Comment cards: avatar + name + ago; resolved = check + accent border.

**C. Workspace cockpit** (213251 — Conductor-style macOS app)
- Left: projects → workspaces tree; each workspace row = branch + diff stat chip (`+312 -332`) +
  state (Ready to merge / Merge conflicts / Archive); `New workspace` per project.
- Center: the agent's chat transcript for the selected workspace — collapsible tool-call groups
  ("13 tool calls, 7 messages"), error banner pinned at top, rendered-markdown agent summaries,
  file-reference pills inline, bottom composer with model picker + "Link issue" + attach.
- Right: **PR rail** — `PR #1432 ↗ · Ready to merge · [Merge]` + Changes(N) file list with
  per-file ± stats; below it a **Run / Terminal** tab with a real terminal cwd'd in the worktree.
- One screen = steer + inspect + land for one unit.

**D. cmux density mode** (213457) — tiled multi-pane terminal cockpit; the far end of the density
spectrum (power-user). Noted, not the primary target; glance's TUI + Intervene already point here.

## Shared visual DNA (all references)

- Dark, slate/ink surfaces; hairline borders; boxy panels; **monospace-forward** type everywhere
  (not just code); small UPPERCASE section labels.
- **Status chips** as the universal state language: tiny rounded-rect, uppercase, filled for
  active (RUNNING teal, DONE dim teal, IDLE gray, DRAFT outline).
- One cool accent (mint/teal) = agent/active/good; warm pink/magenta = humans/flags. Humans and
  agents are visually distinct species everywhere they appear.
- Keyboard hints as first-class chrome (`c`, `N`, `] next tab`, `⌘L to focus`).
- Density with hierarchy: lots of data, but every panel has exactly one job.

## Mapping to existing glance primitives (mostly presentation-gap, not backend-gap)

| Reference pattern | Existing glance backend | Existing webapp surface | Gap |
|---|---|---|---|
| Typed session pipeline per task | workflows (research-plan-implement.fabro), features, routing.mode, spawn kinds | TaskDetail + Plan flow DAG | No task→typed-sessions presentation; sessions aren't typed rows |
| Artifacts rail w/ comments | plan docs, fabric/knowledge, done-proofs, comments.ts (threads exist) | Knowledge view (search-only) | No per-task artifact rail; comments not doc-anchored |
| Design-review loop w/ resolution gate | Intervene view (line-comment→steer) for CODE diffs; validator criteria; promote-issue Tier-1/2 | IntervenceView | Same primitive doesn't exist for DESIGN DOCS; no N/M-resolved gate feeding land/dispatch |
| Agent live-edits shown as inline strike/insert | transcript events, diff | Transcript view | No doc-diff rendering of agent edits |
| Workspace cockpit w/ PR rail | landReady + one-tap Land + validator verdict + confidence (ALL shipped) | AgentDetail (transcript/diff tabs) | Not composed as chat+PR-rail+files+terminal single screen; no embedded terminal |
| Diff-stat chips on roster rows | worktree diff computed | roster list | Not surfaced as ± chips |
| Status-chip language + hotkeys | statuses exist | mixed styles | No unified chip system / kbd hints |

## Constraint notes

- brand.md says: ink surfaces, ONE warm ember accent, restraint. References use mint/teal accent
  + pink humans. → decided below (user call).
- bunfig/test + agent-browser verification contract applies to every unit (screenshot against the
  LIVE daemon with real agents; hover/keyboard/empty/dense states).
- UI value rule: each reshaped panel names the human decision it serves. The references pass this
  test inherently (steer / land / resolve-review / pick-session), which is why they work.
