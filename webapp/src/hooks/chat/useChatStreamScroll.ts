// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// Ported and adapted from facebook/astryx @ deb5aa0
// Source: packages/core/src/Chat/useChatStreamScroll.ts
// https://github.com/facebook/astryx/blob/deb5aa0/packages/core/src/Chat/useChatStreamScroll.ts
//
// Adaptations from upstream:
// - `.astryx-chat-message` class-selector lookups replaced with
//   `[data-chat-message]` attribute selectors (our transcript entries carry
//   that attribute; see DESIGN.md).
// - Added a `prefers-reduced-motion` guard: `scrollToBottom`/`lock`/
//   `scrollIfLocked` set `scrollTop` directly instead of running the rAF
//   spring when the user has that preference (upstream gap; pattern
//   precedent at `webapp/src/index.css` disabling `animation` under the
//   same media query).
// - The decision logic (synthetic-scroll classification, lock-state
//   transitions, the spring step itself) is delegated to the DOM-free pure
//   functions in `lib/scrollLockCore.ts` so it's unit-testable under
//   `bun test` without a DOM. Behavior is otherwise unchanged from upstream.
//
// Known accepted degradations (see lib/scrollLockCore.ts for detail):
// `scrollend` missing on old engines means no automatic re-lock (the
// "jump to latest" pill still works); very large discrete height jumps can
// outrun the spring in one tick (upstream issue #2282).

'use client';

/**
 * @file useChatStreamScroll.ts
 * @input Uses React refs, state, callbacks
 * @output Exports useChatStreamScroll hook for AI chat scroll behavior
 * @position Utility hook — used by the chat transcript container
 *
 * Spring-based scroll-to-bottom with lock/unlock:
 * - Locked (default): content growth auto-scrolls to bottom via rAF spring
 * - Scrolling up (any source): unlocks immediately
 * - Scrolling settles at bottom: re-locks on scrollend
 *
 * Uses scroll direction (lastScrollTop comparison) to detect user
 * intent — works for wheel, touch, scrollbar drag, keyboard, everything.
 * Tracks scrollHeight/offsetHeight changes to ignore Chrome synthetic
 * scroll events caused by content resize.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { classifyScrollEvent, nextLockState, springStep, type ScrollMetrics } from "../../lib/scrollLockCore";

// =============================================================================
// Types
// =============================================================================

export interface UseChatStreamScrollOptions {
  /**
   * Ref to the scrollable container element.
   */
  scrollRef: React.RefObject<HTMLElement | null>;

  /**
   * Whether scroll behavior is enabled.
   * @default true
   */
  enabled?: boolean;

  /**
   * Distance from bottom (in px) within which scrollend re-locks.
   * Keep small so users aren't yanked back from a slight scroll.
   * @default 10
   */
  lockThreshold?: number;

  /**
   * Distance from bottom (in px) beyond which the scroll-to-bottom
   * button becomes visible.
   * @default 100
   */
  buttonThreshold?: number;

  /**
   * Spring damping — how quickly the animation settles.
   * @default 0.7
   */
  damping?: number;

  /**
   * Spring stiffness — how fast the animation accelerates.
   * @default 0.05
   */
  stiffness?: number;

  /**
   * Spring mass — higher = slower animation.
   * @default 1.25
   */
  mass?: number;
}

export interface UseChatStreamScrollReturn {
  /** Whether the user has scrolled up past buttonThreshold. */
  isScrolledUp: boolean;

  /** Whether auto-scroll is locked (following content). */
  isLocked: boolean;

  /** Scroll to the bottom of the container and re-lock. */
  scrollToBottom: () => void;

  /** Scroll so a specific element is at the top of the visible area. No lock change. */
  scrollToMessage: (el: HTMLElement) => void;

  /** Lock auto-scroll and scroll to bottom. */
  lock: () => void;

  /** Unlock auto-scroll. */
  unlock: () => void;

  /** Scroll to bottom if currently locked. Call on content resize. */
  scrollIfLocked: () => void;

  /** Scroll to the last message in the container. */
  scrollToLastMessage: () => void;
}

// =============================================================================
// Hook
// =============================================================================

const SIXTY_FPS_MS = 1000 / 60;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Snap the container straight to bottom (no spring) — the reduced-motion path. */
function snapToBottom(el: HTMLElement, lastScrollTopRef: React.RefObject<number>): void {
  if (el.scrollHeight <= el.clientHeight) return;
  el.scrollTop = el.scrollHeight - el.clientHeight;
  lastScrollTopRef.current = el.scrollTop;
}

export function useChatStreamScroll({
  scrollRef,
  enabled = true,
  lockThreshold = 10,
  buttonThreshold = 100,
  damping = 0.7,
  stiffness = 0.05,
  mass = 1.25,
}: UseChatStreamScrollOptions): UseChatStreamScrollReturn {
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [isLocked, setIsLocked] = useState(true);

  const lockedRef = useRef(true);
  const velocityRef = useRef(0);
  const animatingRef = useRef(false);
  const lastTickRef = useRef<number | undefined>(undefined);

  // For scroll direction detection
  const lastScrollTopRef = useRef(0);
  // For synthetic scroll detection
  const lastScrollHeightRef = useRef(0);
  const lastOffsetHeightRef = useRef(0);

  // --- Spring animation ---

  const animate = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !lockedRef.current) {
      animatingRef.current = false;
      lastTickRef.current = undefined;
      velocityRef.current = 0;
      return;
    }

    if (el.scrollHeight <= el.clientHeight) {
      animatingRef.current = false;
      lastTickRef.current = undefined;
      velocityRef.current = 0;
      return;
    }

    const target = el.scrollHeight - el.clientHeight;
    const now = performance.now();
    const tickDelta = lastTickRef.current ? (now - lastTickRef.current) / SIXTY_FPS_MS : 1;
    lastTickRef.current = now;

    const step = springStep({ position: el.scrollTop, velocity: velocityRef.current }, target, tickDelta, { damping, stiffness, mass });
    velocityRef.current = step.velocity;
    el.scrollTop = step.position;

    if (step.settled) {
      animatingRef.current = false;
      lastTickRef.current = undefined;
      velocityRef.current = 0;
      return;
    }

    requestAnimationFrame(animate);
  }, [scrollRef, damping, stiffness, mass]);

  const startAnimation = useCallback(() => {
    if (!animatingRef.current && lockedRef.current) {
      animatingRef.current = true;
      lastTickRef.current = undefined;
      requestAnimationFrame(animate);
    }
  }, [animate]);

  // --- Public API ---

  const scrollToBottom = useCallback(() => {
    lockedRef.current = true;
    setIsLocked(true);
    setIsScrolledUp(false);
    const el = scrollRef.current;
    if (el && prefersReducedMotion()) {
      snapToBottom(el, lastScrollTopRef);
      return;
    }
    startAnimation();
  }, [scrollRef, startAnimation]);

  const scrollToMessage = useCallback(
    (el: HTMLElement) => {
      const container = scrollRef.current;
      if (!container) {
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const offset = elRect.top - containerRect.top + container.scrollTop;
      container.scrollTo({ top: offset, behavior: "instant" });
      lastScrollTopRef.current = container.scrollTop;
    },
    [scrollRef],
  );

  const scrollToLastMessage = useCallback(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    const messages = container.querySelectorAll<HTMLElement>("[data-chat-message]");
    const last = messages[messages.length - 1];
    if (last) {
      scrollToMessage(last);
    }
  }, [scrollRef, scrollToMessage]);

  const lock = useCallback(() => {
    lockedRef.current = true;
    setIsLocked(true);
    setIsScrolledUp(false);
    const el = scrollRef.current;
    if (el && prefersReducedMotion()) {
      snapToBottom(el, lastScrollTopRef);
      return;
    }
    startAnimation();
  }, [scrollRef, startAnimation]);

  const unlock = useCallback(() => {
    lockedRef.current = false;
    animatingRef.current = false;
    setIsLocked(false);
  }, []);

  const scrollIfLocked = useCallback(() => {
    if (!enabled) {
      return;
    }
    if (!lockedRef.current) {
      return;
    }
    const el = scrollRef.current;
    if (el && prefersReducedMotion()) {
      snapToBottom(el, lastScrollTopRef);
      return;
    }
    startAnimation();
  }, [enabled, scrollRef, startAnimation]);

  // --- Event listeners ---

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !enabled) {
      return;
    }

    // Initialize tracking values
    lastScrollTopRef.current = el.scrollTop;
    lastScrollHeightRef.current = el.scrollHeight;
    lastOffsetHeightRef.current = el.offsetHeight;

    const onScroll = () => {
      const current: ScrollMetrics = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, offsetHeight: el.offsetHeight };
      const previous: ScrollMetrics = {
        scrollTop: lastScrollTopRef.current,
        scrollHeight: lastScrollHeightRef.current,
        offsetHeight: lastOffsetHeightRef.current,
      };

      // Button visibility
      const dist = current.scrollHeight - current.scrollTop - current.offsetHeight;
      setIsScrolledUp(dist > buttonThreshold);

      const classification = classifyScrollEvent(previous, current);
      lastScrollTopRef.current = current.scrollTop;
      lastScrollHeightRef.current = current.scrollHeight;
      lastOffsetHeightRef.current = current.offsetHeight;

      if (classification === "synthetic") {
        // Chrome fires scroll events when scrollHeight/offsetHeight change
        // (content resize, keyboard) — not user intent, don't touch lock state.
        return;
      }

      if (lockedRef.current) {
        const next = nextLockState(true, { type: "scroll", classification });
        if (!next) {
          lockedRef.current = false;
          animatingRef.current = false;
          setIsLocked(false);
        }
      }
    };

    const onScrollEnd = () => {
      const dist = el.scrollHeight - el.scrollTop - el.offsetHeight;
      const next = nextLockState(lockedRef.current, { type: "scrollend", distanceFromBottom: dist, lockThreshold });
      if (next && !lockedRef.current) {
        lockedRef.current = true;
        setIsLocked(true);
      }
    };

    // Wheel up while animating — interrupt immediately.
    // onScroll direction detection covers most cases, but wheel fires
    // before the scroll position updates so we can react faster.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && animatingRef.current) {
        const next = nextLockState(lockedRef.current, { type: "wheel-up" });
        lockedRef.current = next;
        animatingRef.current = false;
        setIsLocked(next);
      }
    };

    // Touch move — user is dragging, take control
    const onTouchMove = () => {
      if (animatingRef.current) {
        const next = nextLockState(lockedRef.current, { type: "touch-move" });
        lockedRef.current = next;
        animatingRef.current = false;
        setIsLocked(next);
      }
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("scrollend", onScrollEnd);
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });

    // Initial scroll to bottom
    requestAnimationFrame(() => {
      snapToBottom(el, lastScrollTopRef);
    });

    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("scrollend", onScrollEnd);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [scrollRef, enabled, lockThreshold, buttonThreshold]);

  return {
    isScrolledUp,
    isLocked,
    scrollToBottom,
    scrollToMessage,
    lock,
    unlock,
    scrollIfLocked,
    scrollToLastMessage,
  };
}
