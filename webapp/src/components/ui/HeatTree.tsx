/**
 * HeatTree — the "Context Heat Graph": a collapsible folder tree on the left, a
 * magma heat matrix (one cell per file/folder per day) on the right. Replaces a
 * flat top-N list with the actual codebase structure, so you can see WHICH
 * MODULE is hot, fold cold subtrees away, and read intensity at a glance.
 *
 * Rendered on a FIXED DARK CANVAS in both light and dark app themes: the magma
 * ramp is a color space of its own (like any scientific heatmap) and only reads
 * correctly against a dark background.
 *
 * Two parallel columns (tree labels, heat cells) iterate the SAME flattened,
 * fixed-row-height list, so rows stay pixel-aligned as folders expand/collapse.
 */

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, FileCode2, FileText, Users } from 'lucide-react';
import { magma, flattenTree, type HeatTree as HeatTreeData, type HeatTreeNode } from '../../lib/heatmap';

export interface HeatTreeProps {
  days: string[];
  tree: HeatTreeData;
  /** draw a glowing dot on each file's peak day. */
  showPatterns: boolean;
  /** folder ids expanded on first render. */
  defaultExpanded?: Iterable<string>;
  emptyLabel?: string;
}

const ROW_H = 'h-8'; // 32px — also the day-label spacer height
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-06-27" → "Jun 27" (locale-free, SSR-safe). */
function fmtDay(iso: string): string {
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${d}` : iso;
}

/** Intensity 0..1 for a cell, normalized per type (folders dimmed). */
function intensity(node: HeatTreeNode, value: number, tree: HeatTreeData): number {
  if (node.type === 'folder') {
    return tree.maxFolderCell > 0 ? (value / tree.maxFolderCell) * 0.85 : 0;
  }
  return tree.maxFileCell > 0 ? value / tree.maxFileCell : 0;
}

function FileIcon({ name }: { name: string }): React.ReactElement {
  const isDoc = /\.(md|txt|json|ya?ml|toml|lock)$/i.test(name);
  const Icon = isDoc ? FileText : FileCode2;
  return <Icon className="ml-[18px] h-3.5 w-3.5 shrink-0 text-white/40" aria-hidden="true" />;
}

export const HeatTree: React.FC<HeatTreeProps> = ({ days, tree, showPatterns, defaultExpanded, emptyLabel = 'No receipt-backed file writes in this window.' }) => {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(defaultExpanded ?? []));
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ label: string; day: string; value: number } | null>(null);

  const rows = useMemo(() => flattenTree(tree.roots, expanded), [tree.roots, expanded]);
  const n = days.length;

  if (rows.length === 0 || n === 0) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-[#0c0a1e] px-4 py-10 text-center text-sm text-white/50">
        {emptyLabel}
      </div>
    );
  }

  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const gridCols = { gridTemplateColumns: `repeat(${n}, minmax(14px, 1fr))` } as React.CSSProperties;

  return (
    <section className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800 bg-[#0c0a1e] text-white">
      <div className="overflow-x-auto">
        <div className="grid min-w-[34rem] grid-cols-[minmax(11rem,18rem)_1fr]">
          {/* ── headers ── */}
          <div className="border-b border-r border-white/10 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-white/45">
            File / module
          </div>
          <div className="border-b border-white/10 px-3 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-white/45">
            Heat over time
          </div>

          {/* ── tree column ── */}
          <div className="border-r border-white/10">
            {/* spacer aligned to the day-label row */}
            <div className={`${ROW_H} border-b border-white/10`} />
            {rows.map((node) => {
              const isFolder = node.type === 'folder';
              const open = expanded.has(node.id);
              const isSelected = node.id === selected;
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => (isFolder ? toggle(node.id) : setSelected(isSelected ? null : node.id))}
                  className={`flex w-full items-center gap-1.5 ${ROW_H} px-3 text-left text-xs transition-colors ${
                    isSelected ? 'bg-white/10 text-white' : 'text-white/80 hover:bg-white/5'
                  }`}
                  style={{ paddingLeft: `${12 + node.depth * 16}px` }}
                  title={node.id}
                >
                  {isFolder ? (
                    <>
                      {open ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-white/40" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/40" aria-hidden="true" />
                      )}
                      {open ? (
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-white/55" aria-hidden="true" />
                      ) : (
                        <Folder className="h-3.5 w-3.5 shrink-0 text-white/55" aria-hidden="true" />
                      )}
                    </>
                  ) : (
                    <FileIcon name={node.name} />
                  )}
                  <span className={`truncate ${isFolder ? 'font-medium text-white/90' : ''}`}>{node.name}</span>
                  {node.agentCount > 1 && (
                    <span className="ml-auto flex shrink-0 items-center gap-0.5 rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] font-semibold text-white/70">
                      <Users className="h-2.5 w-2.5" aria-hidden="true" />
                      {node.agentCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* ── heat grid column ── */}
          <div>
            {/* day labels */}
            <div className={`grid ${ROW_H} border-b border-white/10`} style={gridCols}>
              {days.map((d) => (
                <div key={d} className="flex items-center justify-center text-[10px] font-medium tabular-nums text-white/40" title={d}>
                  {fmtDay(d)}
                </div>
              ))}
            </div>

            {rows.map((node) => {
              const isSelected = node.id === selected;
              const peak = node.daily.indexOf(Math.max(...node.daily, 0));
              return (
                <div key={node.id} className={`grid ${ROW_H} ${isSelected ? 'ring-1 ring-inset ring-white/40' : ''}`} style={gridCols}>
                  {days.map((d, i) => {
                    const v = node.daily[i] ?? 0;
                    const t = intensity(node, v, tree);
                    const isHot = node.type === 'file' && t > 0.45;
                    return (
                      <div
                        key={d}
                        onMouseEnter={() => setHover({ label: node.name, day: d, value: v })}
                        onMouseLeave={() => setHover(null)}
                        className="relative border-b border-r border-black/30 transition-[filter] hover:brightness-125"
                        style={{ backgroundColor: magma(t) }}
                        title={`${node.id} · ${fmtDay(d)}: ${v} touch${v === 1 ? '' : 'es'}`}
                        aria-label={`${node.id}, ${d}: ${v} touches`}
                      >
                        {showPatterns && isHot && i === peak && (
                          <span className="absolute inset-0 m-auto h-1.5 w-1.5 rounded-full bg-white/85 shadow-[0_0_6px_rgba(255,255,255,0.6)]" />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* footer / hover readout */}
      <div className="flex items-center justify-between gap-4 border-t border-white/10 px-4 py-2.5 text-[11px] text-white/45">
        <span>Heat = files touched per day, from agent receipts.</span>
        {hover && (
          <span className="shrink-0 font-mono text-white/80">
            {hover.label} · {fmtDay(hover.day)} · <span className="text-amber-300">{hover.value}</span>
          </span>
        )}
      </div>
    </section>
  );
};
