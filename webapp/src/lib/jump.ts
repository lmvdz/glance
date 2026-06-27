/**
 * "Jump to search" — the target of the ⌘K / Ctrl+K shortcut and the "Jump" buttons.
 *
 * The header advertises "Search tasks or jump · ⌘K" and TaskDetail renders a "Jump ⌘K"
 * button, but nothing was wired to either — pressing ⌘K or clicking Jump did nothing.
 * This focuses the workbench task-search box (which already filters the task list), the
 * conventional behavior for that affordance.
 */

/** Id of the workbench task-search input — defined on the <input> in WorkbenchPane.tsx. */
export const TASK_SEARCH_INPUT_ID = 'workbench-search';

/**
 * Focus + select the workbench task-search box. Returns false when it isn't in the DOM
 * (e.g. the workbench pane is collapsed) so callers can no-op gracefully.
 */
export function focusTaskSearch(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.getElementById(TASK_SEARCH_INPUT_ID) as HTMLInputElement | null;
  if (!el) return false;
  el.focus();
  el.select?.();
  return true;
}
