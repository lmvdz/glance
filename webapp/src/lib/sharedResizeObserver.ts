// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// Ported verbatim from facebook/astryx @ deb5aa0
// Source: packages/core/src/utils/sharedResizeObserver.ts
// https://github.com/facebook/astryx/blob/deb5aa0/packages/core/src/utils/sharedResizeObserver.ts

/**
 * @file sharedResizeObserver.ts
 * @input ResizeObserver API
 * @output Exports observeResize / unobserveResize for shared observation
 * @position Utility; consumed by useChatNewMessages so the chat transcript
 *   doesn't spin up a per-instance ResizeObserver.
 *
 * A single ResizeObserver can observe thousands of elements. Creating one
 * per component is wasteful — browsers batch observations per observer
 * instance, so a shared observer means one callback dispatch per animation
 * frame instead of N.
 */

type ResizeCallback = (entry: ResizeObserverEntry) => void;

let observer: ResizeObserver | null = null;
const callbacks = new Map<Element, ResizeCallback>();

function getObserver(): ResizeObserver {
  if (!observer) {
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cb = callbacks.get(entry.target);
        if (cb) {
          cb(entry);
        }
      }
    });
  }
  return observer;
}

/**
 * Observe an element's size via a shared ResizeObserver singleton.
 *
 * Fires the callback once synchronously on registration (with a
 * synthetic entry) so callers don't need separate initial-measurement
 * logic. Subsequent callbacks fire on actual resizes.
 *
 * Call `unobserveResize` when the element unmounts or observation is
 * no longer needed. The shared observer is destroyed when the last
 * element is unobserved.
 *
 * @example
 * ```
 * observeResize(element, (entry) => {
 *   console.log(entry.contentBoxSize);
 * });
 *
 * // Cleanup:
 * unobserveResize(element);
 * ```
 */
export function observeResize(element: Element, callback: ResizeCallback): void {
  callbacks.set(element, callback);
  getObserver().observe(element);

  // Fire once immediately so callers get an initial measurement
  // without duplicating their logic outside the observer path.
  const entry: Partial<ResizeObserverEntry> = { target: element };
  callback(entry as ResizeObserverEntry);
}

/**
 * Stop observing an element. If no elements remain, the shared
 * observer is disconnected and released for garbage collection.
 */
export function unobserveResize(element: Element): void {
  callbacks.delete(element);
  if (observer) {
    observer.unobserve(element);
    if (callbacks.size === 0) {
      observer.disconnect();
      observer = null;
    }
  }
}
