/**
 * PageContext — Feature 2 D1 (plans/orchestration/CANVAS-AND-PAGE-CHAT.md).
 *
 * AssistantChat's context assembly used to be hardcoded to a fleet snapshot + whichever task
 * happened to be selected (AssistantChat.tsx, pre-this-change ~lines 461/702-705) — it had no idea
 * whether the operator was looking at Fleet, Tasks, Graph, or Capabilities. This file is the
 * contract that fixes that: every MainContent view PUBLISHES a small `PageContext` describing
 * itself, and the chat (or anything else, e.g. the dev debug readout) reads the live one back.
 *
 * Why "publish", not plain React context: the assistant dock (AssistantChat) is mounted as a
 * SIBLING of MainContent in AppContent — not a descendant — because it must stay open across view
 * switches (D4: "ONE global right dock; page context swaps with the view"). A view's own local
 * state (selected agent, graph window, inspector selection, …) only that view holds, so only that
 * view can compute its PageContext — but plain React context can't carry a value UP from a
 * descendant to a sibling. `PageContextScope` solves this the same way a portal solves rendering
 * out-of-tree: it reports (`publish`) its value into one shared store on mount/update and retracts
 * it on unmount; `usePageContext()` reads whatever was last published. Last-write-wins, keyed so a
 * fast-unmounting scope can never blank a still-live view's context out from under it (see
 * `applyPublish` below — pulled out as a pure function so the "stale unmount can't clobber a
 * fresher publish" invariant is unit-testable without mounting React at all).
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/** One thing on the page worth naming to the assistant — an agent row, a task, a pack, a commit
 *  the operator clicked on the graph, etc. Deliberately just `{kind, id, label}`: enough for the
 *  assistant to refer back to it, never the full record (that would duplicate the same untrusted,
 *  potentially-large payload the view itself already fetched). */
export interface PageContextEntity {
  kind: string;
  id: string;
  label: string;
}

export interface PageContextSelection {
  kind: string;
  id: string;
}

/**
 * The wire/shape contract from D1. `viewId` follows the design doc's literal union (which spells
 * the Graph view `'graph'`, not the AppView union's real `'omp-graph'` key — the two are
 * deliberately independent vocabularies: AppView is "which component to mount", PageContext.viewId
 * is "how to describe this screen to an LLM") plus `'org'`, added because P1's brief explicitly
 * asked for an org minimal context alongside intervene/review even though D1's prose only discusses
 * fleet/tasks/graph/capabilities — a deliberate widening past the literal doc, not a typo.
 */
export interface PageContext {
  viewId: 'fleet' | 'tasks' | 'graph' | 'fog' | 'capabilities' | 'intervene' | 'review' | 'org';
  title: string;
  entities: PageContextEntity[];
  selection?: PageContextSelection;
  filters?: Record<string, string | number | boolean>;
  route?: string;
}

/** Size sanity (D1/D6-style guard): no view may serialize an unbounded entity list into the chat
 *  prompt. Every `derive*PageContext` helper in lib/pageContextDerive.ts caps at this. */
export const PAGE_CONTEXT_ENTITY_CAP = 50;

interface PageContextStoreState {
  current: PageContext | null;
  /** Which scope's publish is currently live — lets an unmounting scope's cleanup check "was it
   *  actually me?" before clearing, so an old scope's teardown can never blank a newer one's value. */
  activeKey: string | null;
}

const EMPTY_STORE_STATE: PageContextStoreState = { current: null, activeKey: null };

/** Pure reducer for one publish/retract event — extracted so the "stale unmount can't clobber a
 *  fresher publish" invariant has a unit test that never touches React. `value === null` means
 *  "this scope is unmounting / has nothing to say"; every other publish is a live value. */
export function applyPublish(state: PageContextStoreState, key: string, value: PageContext | null): PageContextStoreState {
  if (value === null) {
    if (state.activeKey !== key) return state; // not the active publisher — no-op, by design
    return EMPTY_STORE_STATE;
  }
  return { current: value, activeKey: key };
}

interface PageContextStore {
  state: PageContextStoreState;
  publish: (key: string, value: PageContext | null) => void;
}

const PageContextInternal = createContext<PageContextStore | undefined>(undefined);

/** Mount ONCE near the root — alongside ThemeProvider/AuthProvider/TaskProvider in App.tsx — so it
 *  sits ABOVE both MainContent (the publishers) and AssistantChat/the debug panel (the readers). */
export function PageContextProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PageContextStoreState>(EMPTY_STORE_STATE);
  const publish = useCallback((key: string, value: PageContext | null) => {
    setState((prev) => applyPublish(prev, key, value));
  }, []);
  const store = useMemo(() => ({ state, publish }), [state, publish]);
  return <PageContextInternal.Provider value={store}>{children}</PageContextInternal.Provider>;
}

/** The live page context — whatever the currently-mounted view last published, or `null` before
 *  any view has (e.g. the very first paint, or the FirstRunSetup/auth gates). AssistantChat's
 *  assembly and the dev-only debug readout are the two consumers. */
export function usePageContext(): PageContext | null {
  const store = useContext(PageContextInternal);
  if (!store) throw new Error('usePageContext must be used within a PageContextProvider');
  return store.state.current;
}

let scopeSeq = 0;

/**
 * `<PageContextScope value={ctx}>{children}</PageContextScope>` — wrap a view's own render tree in
 * this to publish `ctx` as the live PageContext for as long as the view stays mounted. Each scope
 * gets its own stable identity (a mount-time counter, not the view name — two instances of the same
 * view can never collide), so `applyPublish`'s "am I still the active publisher?" check is exact.
 *
 * Callers should memoize `value` (useMemo keyed on the fields that actually changed) — the effect
 * re-publishes whenever the reference changes, so an unmemoized object literal republishes every
 * render. Harmless (last-write-wins), just wasteful.
 */
export function PageContextScope({ value, children }: { value: PageContext; children: ReactNode }) {
  const store = useContext(PageContextInternal);
  if (!store) throw new Error('PageContextScope must be used within a PageContextProvider');
  const keyRef = useRef<string | undefined>(undefined);
  if (!keyRef.current) keyRef.current = `scope-${++scopeSeq}`;
  const { publish } = store;
  useEffect(() => {
    const key = keyRef.current!;
    publish(key, value);
    return () => publish(key, null);
  }, [publish, value]);
  return <>{children}</>;
}
