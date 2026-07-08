/**
 * Shared UI kit — the reference-structure primitives every Wave 4 / Lane B screen (the
 * Workspace Cockpit, the task-pipeline IA, the design-review loop) is contractually built on.
 * Import from here; the individual files may move but this contract stays stable.
 *
 *   StatusChip    — tiny uppercase rounded-rect state chip (RUNNING/DONE/IDLE/DRAFT/ERROR/…)
 *   Kbd           — keyboard-hint chip ("N", "c", "] next tab")
 *   MonoLabel     — small uppercase monospace section label
 *   PanelSection  — hairline-bordered boxy panel with a header slot
 *   DiffStat      — "+N -M" chip (green/red numerals)
 */
export { StatusChip, type StatusChipProps, type StatusChipVariant, type StatusChipTone } from './StatusChip';
export { Kbd, type KbdProps } from './Kbd';
export { MonoLabel } from './MonoLabel';
export { PanelSection, type PanelSectionProps } from './PanelSection';
export { DiffStat, type DiffStatProps } from './DiffStat';
