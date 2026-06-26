# Design: manager-grade Control Tower overhaul

## Approach

Make the web UI a manager-grade thin client over the same daemon event spine the TUI uses. The problem is not "add more cards"; it is that the web contracts flatten rich OMP/session state into `activity` strings and fake dashboards. The fix is a clean cutover to typed rich events + assistant-ui primitives + real daemon/read-model data, while deleting sample/static UI that pretends to be live.

This plan supersedes the shipped-but-insufficient `omp-dashboard` P1/P2 polish layer. It consumes, but does not re-plan, `fleet-observability` (trace spans/export) and `agent-context-fabric` (profile-scoped context / real heat source). Until those land, the web must show honest unavailable states instead of fake graphs.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Chat substrate | `@assistant-ui/react` thread/composer/message/tool primitives stay the shell; OMP data adapts into assistant-ui parts | Custom transcript renderer | User explicitly asked not to cook up our own chat. Existing wrappers already expose tool grouping, reasoning, markdown, queue, speech, action bars. |
| Rich OMP output | Add an additive `TranscriptEntry.meta` / rich event envelope at the manager append chokepoint | Parse TUI text or scrape ANSI | TUI and web must be thin clients over one core stream. Scraping TUI creates a second mechanism. |
| Tool calls | Represent tools as assistant-ui `tool-call` parts with names, args, status, result/output when OMP emits it | Continue `{"activity":"stage: Implement"}` | The current mapping in `webapp/src/lib/omp-thread.ts` throws away everything except one string. |
| Optimistic user messages | Stable client turn id echoed in transcript metadata | Text-match de-dupe | Text-match causes duplicate/triple messages for repeated or replayed text. |
| Control Tower nav | Keep TopBar/Sidebar/CommandPalette around Control Tower | Current special-case full-screen console | User cannot navigate back because `App.tsx` removes the app shell for `view === "console"`. |
| Missions detail | Route into a full issue workspace with task detail, plan, comments, trace, and contextual agent | Side panel slide-over | The current absolute side panel is cramped, can be lost while scrolling, and cannot support plan/comment/agent iteration. |
| Data quality | Real endpoint or honest empty state; delete fake/static data | Keep visual demos with sample data | May dates/Go files in a TS repo and disabled placeholder dashboards destroy trust. |
| Heat source | Aggregate `receipts.filesTouched` recency; do not use phantom `dal/context` | Hardcoded v0 heat arrays | `agent-context-fabric` already verified `dal/context.ts` is org-scoping, not heat. Receipts are the real existing source. |
| Profiles | Named profile v0 extends `intake`/`smart-spawn`; profiles page lists real profile files + usage | Group by model string | North Star names versioned agent profiles as a missing primitive; `openai-codex/gpt-5.5 (4 agents)` is not a profile. |
| Federation/governance | Show real configured peers/policies or explain local-only state | Decorative graph | Empty org/federation should read as "not connected/configured", not broken geometry. |

## Risks

| Risk | Resolution |
|---|---|
| OMP RPC may not emit every command output as structured frames today | Concern 01 starts with a characterization test/fake-frame fixture, then captures only available fields; no fabricated outputs. |
| Assistant-ui unstable trigger APIs may churn | Use only local installed package APIs already present in `node_modules` (`ComposerPrimitive.TriggerPopover`, `unstable_useSlashCommandAdapter`, `unstable_useMentionAdapter`) and wrap in one component. |
| Shared files (`App.tsx`, `ConsoleView.tsx`, `dto.ts`, `types.ts`) create parallel-agent conflicts | Overview sequences concerns touching the same files. |
| Existing `fleet-observability` plan overlaps trace UI | This plan only consumes trace endpoints when present and adds honest placeholders otherwise; it does not implement spans/export. |
| Onboarding image reference is unavailable in repo/context | Concern 07 requires the implementer to locate the referenced asset or ask for it; no guessing from memory. |

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| "More logs" can become a transcript firehose, violating North Star non-goal | critical | Rich events are grouped/collapsible and root-caused; raw dumps stay behind expandable tool/result blocks. |
| Adding a second UI state store will diverge from TUI | critical | `SquadEvent`/`ClientCommand` remains the single source; web dto mirrors core types. |
| Fake fleet health dashboards are worse than missing dashboards | significant | Delete sample heat/static dashboard data in the same concerns that wire real endpoints. |
| Context-aware issue agent could smuggle untrusted Plane/comment content into prompts | significant | Fence/redact page context like resume digests; mark as page context, not operator instruction. |
| Profiles can become a speculative config system | significant | v0 is read/list/display + spawn selection over the existing `intake`/`smart-spawn` seam only. Capabilities/memory remain separate plan unless already available. |

## Open Questions

None blocking the plan. The onboarding image mismatch needs the actual reference image during implementation; if unavailable, implement the app-consistent onboarding flow and record the missing asset as blocked.
