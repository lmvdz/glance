import React, { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { TranscriptEntry } from '../../lib/dto';

// ---- tool-view formatting helpers ----
// Moved here (concern 05) from AssistantChat.tsx along with the row markup
// they feed. `toolView` and `fmtDuration` are re-exported for AssistantChat's
// remaining non-row usages (`entryAction`, `transcriptDownloadText`,
// `ComposerStats`, `RunStatusHeader`) so there is one definition, imported
// forward (AssistantChat.tsx -> chat/ToolCallGroup.tsx) rather than a cycle.

const parseToolJson = (text?: string): unknown => {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const prettyJson = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

const asRecord = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};

const contentText = (value: unknown): string => {
  const rec = asRecord(value);
  if (typeof rec.stdout === 'string') return rec.stdout;
  if (typeof rec.output === 'string') return rec.output;
  if (typeof rec.text === 'string') return rec.text;
  if (Array.isArray(rec.content)) return rec.content.map((item) => asRecord(item).text).filter((text): text is string => typeof text === 'string').join('\n');
  return typeof value === 'string' ? value : '';
};

export const fmtDuration = (ms?: number) => {
  if (ms == null) return undefined;
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
};

export const statusDotClass = (status?: TranscriptEntry['status']) => {
  if (status === 'error') return 'bg-red-500';
  if (status === 'running') return 'bg-blue-500';
  if (status === 'cancelled') return 'bg-amber-500';
  return 'bg-emerald-500';
};

export const toolView = (entry: TranscriptEntry) => {
  const args = parseToolJson(entry.tool?.argsText);
  const partial = parseToolJson(entry.tool?.partialText);
  const result = parseToolJson(entry.tool?.resultText);
  const argRec = asRecord(args);
  const resultRec = asRecord(result);
  const partialRec = asRecord(partial);
  const command = typeof argRec.command === 'string' ? argRec.command : typeof argRec.cmd === 'string' ? argRec.cmd : '';
  const output = contentText(result) || contentText(partial);
  const stderr = typeof resultRec.stderr === 'string' ? resultRec.stderr : typeof partialRec.stderr === 'string' ? partialRec.stderr : '';
  const exitCode = typeof resultRec.exitCode === 'number' ? resultRec.exitCode : typeof resultRec.code === 'number' ? resultRec.code : undefined;
  const raw = [
    ['Args', args],
    ['Partial', partial],
    ['Result', result],
  ].filter(([, value]) => value !== undefined);
  return { title: command ? `Ran ${command}` : entry.text.replace(/^▸\s*/, '') || entry.tool?.name || 'tool', command, output, stderr, exitCode, raw };
};

const toolRowKey = (entry: TranscriptEntry) => entry.id ?? `${entry.ts}:${entry.kind}:${entry.text}`;

/**
 * Per-call detail row: status dot, tool name, duration, IN/OUT/ERR panes, and
 * the raw-payload `<details>`. Moved verbatim from `TranscriptEntryView`'s
 * `kind === 'tool'` branch (concern 05) so it can be shared between a
 * standalone tool entry (run length 1 — unchanged rendering) and a row
 * inside `ToolCallGroup`.
 *
 * `stampChatMessage` (default true) controls whether this row carries its
 * own `data-chat-message` attribute. Standalone usage keeps it (matches
 * pre-existing behavior); rows inside a group pass `false` — the group root
 * carries the attribute instead, so "new message" detection sees one atomic
 * unit rather than every buried row.
 */
export const ToolCallRow = ({ entry, stampChatMessage = true }: { entry: TranscriptEntry; stampChatMessage?: boolean }) => {
  const view = toolView(entry);
  const running = entry.status === 'running';
  const toolLabel = (entry.tool?.name ?? 'Tool').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const hasBody = view.command || view.output || view.stderr || view.raw.length > 0;
  return (
    <details {...(stampChatMessage ? { 'data-chat-message': true } : {})} open={running} className="group rounded-md">
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-gray-900/60">
        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${statusDotClass(entry.status)} ${running ? 'animate-pulse' : ''}`} aria-label={entry.status ?? 'ok'} />
        <span className="font-semibold text-gray-900 dark:text-gray-100">{toolLabel}</span>
        <span className={`min-w-0 flex-1 truncate text-gray-500 dark:text-gray-400 ${running ? 'shimmer' : ''}`}>{view.title !== toolLabel ? view.title : ''}</span>
        {hasBody && <ChevronRight className="ml-auto h-3 w-3 flex-shrink-0 text-gray-300 transition-transform group-open:rotate-90 dark:text-gray-600" aria-hidden />}
      </summary>
      {hasBody && (
        <div className="mt-1 ml-4 space-y-1.5 text-[11px]">
          {view.command && (
            <div className="flex gap-2">
              <span className="w-6 flex-shrink-0 pt-1.5 text-[9px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500">IN</span>
              <code className="flex-1 rounded bg-gray-100 px-2 py-1.5 font-mono leading-relaxed text-gray-700 dark:bg-gray-900 dark:text-gray-300 whitespace-pre-wrap">{view.command}</code>
            </div>
          )}
          {view.output && (
            <div className="flex gap-2">
              <span className="w-6 flex-shrink-0 pt-1.5 text-[9px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500">OUT</span>
              <pre className="max-h-48 flex-1 overflow-auto rounded bg-gray-100 px-2 py-1.5 leading-relaxed text-gray-700 dark:bg-gray-900 dark:text-gray-300 whitespace-pre-wrap scrollbar-custom">{view.output}</pre>
            </div>
          )}
          {view.stderr && (
            <div className="flex gap-2">
              <span className="w-6 flex-shrink-0 pt-1.5 text-[9px] font-bold uppercase tracking-wider text-red-400">ERR</span>
              <pre className="max-h-32 flex-1 overflow-auto rounded bg-red-50 px-2 py-1.5 leading-relaxed text-red-800 dark:bg-red-950/30 dark:text-red-200 whitespace-pre-wrap scrollbar-custom">{view.stderr}</pre>
            </div>
          )}
          {(view.exitCode !== undefined || entry.tool?.durationMs !== undefined) && (
            <div className="flex items-center gap-2 pl-8 text-[10px] text-gray-400 dark:text-gray-500">
              {view.exitCode !== undefined && <span>exit {view.exitCode}</span>}
              {entry.tool?.durationMs !== undefined && <span>{fmtDuration(entry.tool.durationMs)}</span>}
            </div>
          )}
          {view.raw.length > 0 && (
            <details className="group/raw ml-8">
              <summary className="inline-flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded px-1.5 text-[10px] text-gray-400 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-gray-500 dark:hover:bg-gray-900">
                <ChevronRight className="h-3 w-3 transition-transform group-open/raw:rotate-90" aria-hidden />
                Raw payload
              </summary>
              <div className="mt-1 space-y-2">
                {view.raw.map(([name, value]) => (
                  <div key={name as string}>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{name as string}</div>
                    <pre className="max-h-44 overflow-auto rounded-md bg-gray-950 p-2.5 leading-relaxed text-gray-100 whitespace-pre-wrap scrollbar-custom">{prettyJson(value)}</pre>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </details>
  );
};

export interface ToolRunGroup {
  type: 'group';
  entries: TranscriptEntry[];
}

export interface ToolRunSingle {
  type: 'entry';
  entry: TranscriptEntry;
}

export type ToolRunItem = ToolRunGroup | ToolRunSingle;

/**
 * Groups consecutive `kind: 'tool'` transcript entries into runs so a
 * 40-tool-call chain becomes one collapsible `ToolCallGroup` instead of 40
 * stacked rows. Stage-marker dividers (`format: 'stage'`) are real `kind:
 * 'tool'` entries but render as progress dividers, not calls — they break a
 * run just like any non-tool entry. A run of length 1 passes through as a
 * plain `entry` item so it renders exactly as it did before grouping
 * existed. Pure and unit-testable; entries are passed through by reference
 * (never cloned) so `TranscriptEntryView`'s memoization keeps working.
 */
export function groupToolRuns(entries: TranscriptEntry[]): ToolRunItem[] {
  const items: ToolRunItem[] = [];
  let run: TranscriptEntry[] = [];

  const flush = () => {
    if (run.length === 1) items.push({ type: 'entry', entry: run[0] });
    else if (run.length > 1) items.push({ type: 'group', entries: run });
    run = [];
  };

  for (const entry of entries) {
    if (entry.kind === 'tool' && entry.format !== 'stage') {
      run.push(entry);
    } else {
      flush();
      items.push({ type: 'entry', entry });
    }
  }
  flush();

  return items;
}

/**
 * Collapsed rendering of a run of consecutive tool calls: the newest call's
 * row, always visible, plus a "N previous steps" toggle when there is at
 * least one older call in the run. Expanding reveals every call via
 * `ToolCallRow`, animated with a `grid-template-rows: 0fr -> 1fr` transition
 * (astryx pattern; plain CSS, respects `prefers-reduced-motion` — see
 * `.tool-group-rows` in index.css).
 *
 * A run containing a `status: 'running'` entry force-expands (the live call
 * must stay visible) regardless of the operator's manual toggle state, and
 * returns to that manual state once the run settles — so it "collapses when
 * the run moves on" unless the operator explicitly pinned it open while it
 * was running.
 */
export const ToolCallGroup = ({ entries }: { entries: TranscriptEntry[] }) => {
  const [manualExpanded, setManualExpanded] = useState(false);
  const hasRunning = entries.some((entry) => entry.status === 'running');
  const expanded = hasRunning || manualExpanded;
  const previousEntries = entries.slice(0, -1);
  const latest = entries[entries.length - 1];
  const toggle = () => setManualExpanded((value) => !value);

  // The older rows only mount while expanded — that's the actual DOM-weight
  // fix (a 40-call run must not keep 40 <details> blocks mounted just to hide
  // them with CSS). `rowsOpen` lags one frame behind `expanded` so a freshly
  // mounted rows container starts at `grid-template-rows: 0fr` and gets the
  // `-open` class applied on the following frame, giving the CSS transition
  // something to animate from (mounting straight into the open state can't
  // transition — there's no prior value to animate away from). Collapsing
  // unmounts immediately; only the opening direction animates.
  const [rowsOpen, setRowsOpen] = useState(false);
  useEffect(() => {
    if (!expanded) {
      setRowsOpen(false);
      return;
    }
    const id = requestAnimationFrame(() => setRowsOpen(true));
    return () => cancelAnimationFrame(id);
  }, [expanded]);

  return (
    <div data-chat-message className="rounded-md">
      {previousEntries.length > 0 && (
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              toggle();
            }
          }}
          className="mb-0.5 flex min-h-6 cursor-pointer select-none items-center gap-1.5 rounded px-1.5 text-[11px] text-gray-400 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-gray-500 dark:hover:bg-gray-900"
        >
          <ChevronRight className={`h-3 w-3 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden />
          {expanded ? 'Hide previous steps' : `${previousEntries.length} previous ${previousEntries.length === 1 ? 'step' : 'steps'}`}
        </div>
      )}
      {expanded && (
        <div className={`tool-group-rows ${rowsOpen ? 'tool-group-rows-open' : ''}`}>
          <div className="tool-group-rows-inner space-y-1">
            {previousEntries.map((entry) => (
              <ToolCallRow key={toolRowKey(entry)} entry={entry} stampChatMessage={false} />
            ))}
          </div>
        </div>
      )}
      <ToolCallRow key={toolRowKey(latest)} entry={latest} stampChatMessage={false} />
    </div>
  );
};
