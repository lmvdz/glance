/**
 * "Jump to search" — the target of the ⌘K / Ctrl+K shortcut and the "Jump" buttons.
 *
 * The header advertises "Search tasks or jump · ⌘K" and TaskDetail renders a "Jump ⌘K"
 * button, but nothing was wired to either — pressing ⌘K or clicking Jump did nothing.
 * This focuses the workbench task-search box (which already filters the task list), the
 * conventional behavior for that affordance.
 */

import type { AppView } from '../context/TaskContext';

/** Id of the workbench task-search input — defined on the <input> in WorkbenchPane.tsx. */
export const TASK_SEARCH_INPUT_ID = 'workbench-search';

/**
 * Focus + select the workbench task-search box. Returns false when it isn't in the DOM
 * (e.g. the workbench pane is collapsed, or — since the task-scoped sidebar block only
 * renders on the Tasks view now — the current view isn't Tasks) so callers can no-op
 * gracefully.
 */
export function focusTaskSearch(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.getElementById(TASK_SEARCH_INPUT_ID) as HTMLInputElement | null;
  if (!el) return false;
  el.focus();
  el.select?.();
  return true;
}

/**
 * Global ⌘K/Ctrl+K handler. The search input now only mounts on the Tasks view (the
 * task-scoped sidebar block was hidden everywhere else — see WorkbenchPane's
 * isTaskScopedView), so a bare focusTaskSearch() would silently no-op from any other
 * screen. Keep the keybinding global: if we're not on Tasks, switch there first and
 * focus on the next scheduled tick — the input doesn't exist in the DOM until that
 * render lands, so focusing synchronously would still miss it.
 */
export function jumpToTaskSearch(
  view: AppView,
  setView: (view: AppView) => void,
  focus: () => boolean = focusTaskSearch,
  schedule: (fn: () => void) => void = (fn) => {
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(fn);
    else setTimeout(fn, 0);
  },
): void {
  if (view !== 'tasks') {
    setView('tasks');
    schedule(focus);
    return;
  }
  focus();
}
