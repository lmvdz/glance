import { expect, test } from "bun:test";
import { applyEmptyQueryDismiss, CLOSED_MENU_STATE, comboboxAriaProps, computeCompletionEdit, detectTrigger, dismissMenu, insertCompletion, isImeComposing, reduceDetection, type MenuState } from "./useTriggerMenu";

// =============================================================================
// detectTrigger
// =============================================================================

test("detectTrigger: opens on a fresh @ at the caret", () => {
  expect(detectTrigger("hi @", 4, ["@"])).toEqual({ trigger: "@", query: "", start: 3 });
});

test("detectTrigger: query grows as the caret advances past the trigger", () => {
  expect(detectTrigger("hi @fi", 6, ["@"])).toEqual({ trigger: "@", query: "fi", start: 3 });
});

test("detectTrigger: multi-word queries with spaces up to the caret stay open (task titles are multi-word)", () => {
  const text = "please look at @fix login bug";
  const caret = text.length;
  expect(detectTrigger(text, caret, ["@"])).toEqual({ trigger: "@", query: "fix login bug", start: 15 });
});

test("detectTrigger: mid-string edit — caret inside an earlier mention still resolves its query", () => {
  const text = "re @task one two";
  // caret placed inside "task", right after "@tas"
  const caret = text.indexOf("task") + 3;
  expect(detectTrigger(text, caret, ["@"])).toEqual({ trigger: "@", query: "tas", start: 3 });
});

test("detectTrigger: @ inside a word does not trigger", () => {
  const text = "email me at user@domain.com";
  expect(detectTrigger(text, text.length, ["@"])).toBeNull();
});

test("detectTrigger: trigger at start-of-text is valid (no preceding char)", () => {
  expect(detectTrigger("@bob", 4, ["@"])).toEqual({ trigger: "@", query: "bob", start: 0 });
});

test("detectTrigger: does not cross a newline looking for an earlier trigger", () => {
  const text = "@old mention\nnew line with no trigger";
  expect(detectTrigger(text, text.length, ["@"])).toBeNull();
});

test("detectTrigger: no trigger character before the caret at all", () => {
  expect(detectTrigger("just plain text", 16, ["@"])).toBeNull();
});

test("detectTrigger: only scans configured trigger characters", () => {
  expect(detectTrigger("hi /help", 8, ["@"])).toBeNull();
  expect(detectTrigger("hi /help", 8, ["/"])).toEqual({ trigger: "/", query: "help", start: 3 });
});

// =============================================================================
// computeCompletionEdit / insertCompletion
// =============================================================================

test("computeCompletionEdit: replaces [start, caret) with the replacement plus a trailing space", () => {
  const edit = computeCompletionEdit(3, 7, "Fix login bug");
  expect(edit).toEqual({ start: 3, end: 7, text: "Fix login bug ", caret: 3 + "Fix login bug ".length });
});

test("computeCompletionEdit: caret lands immediately after the inserted text, not the replaced range", () => {
  const edit = computeCompletionEdit(10, 14, "x");
  expect(edit.caret).toBe(12); // "x " is 2 chars, so 10 + 2
});

test("insertCompletion: calls setRangeText with the exact range and restores the caret", () => {
  let value = "hi @fi there";
  const calls: unknown[] = [];
  const fakeTextarea = {
    get value() {
      return value;
    },
    set value(next: string) {
      value = next;
    },
    selectionStart: 0,
    selectionEnd: 0,
    setRangeText(text: string, start: number, end: number, mode: string) {
      calls.push([text, start, end, mode]);
      value = value.slice(0, start) + text + value.slice(end);
      if (mode === "end") {
        fakeTextarea.selectionStart = fakeTextarea.selectionEnd = start + text.length;
      }
    },
    focus() {},
  } as unknown as HTMLTextAreaElement;

  const result = insertCompletion(fakeTextarea, 3, 6, "Fix the bug");
  expect(calls).toEqual([["Fix the bug ", 3, 6, "end"]]);
  expect(result).toBe("hi Fix the bug  there");
  expect(fakeTextarea.selectionStart).toBe(3 + "Fix the bug ".length);
  expect(fakeTextarea.selectionEnd).toBe(fakeTextarea.selectionStart);
});

test("insertCompletion: falls back to manual splicing when setRangeText is unavailable", () => {
  const fakeTextarea = {
    value: "hi @fi",
    selectionStart: 0,
    selectionEnd: 0,
    focus() {},
  } as unknown as HTMLTextAreaElement;

  const result = insertCompletion(fakeTextarea, 3, 6, "Fix");
  expect(result).toBe("hi Fix ");
  expect(fakeTextarea.selectionStart).toBe("hi Fix ".length);
});

// =============================================================================
// reduceDetection / dismissMenu — menu-state transitions
// =============================================================================

test("reduceDetection: opens a closed menu on a fresh detection", () => {
  const next = reduceDetection(CLOSED_MENU_STATE, { trigger: "@", query: "fi", start: 3 });
  expect(next.open).toBe(true);
  expect(next.trigger).toBe("@");
  expect(next.query).toBe("fi");
  expect(next.start).toBe(3);
  expect(next.activeIndex).toBe(0);
});

test("reduceDetection: null detection closes the menu", () => {
  const open: MenuState = { open: true, trigger: "@", query: "fi", start: 3, activeIndex: 2, dismissedStart: null };
  const next = reduceDetection(open, null);
  expect(next).toEqual(CLOSED_MENU_STATE);
});

test("reduceDetection: same session (same start) keeps the active index as the query changes", () => {
  const open: MenuState = { open: true, trigger: "@", query: "f", start: 3, activeIndex: 2, dismissedStart: null };
  const next = reduceDetection(open, { trigger: "@", query: "fi", start: 3 });
  expect(next.activeIndex).toBe(2);
  expect(next.query).toBe("fi");
});

test("reduceDetection: a new trigger position resets the active index", () => {
  const open: MenuState = { open: true, trigger: "@", query: "fi", start: 3, activeIndex: 2, dismissedStart: null };
  const next = reduceDetection(open, { trigger: "@", query: "", start: 20 });
  expect(next.start).toBe(20);
  expect(next.activeIndex).toBe(0);
});

test("escape-then-retype: dismissing at a trigger position keeps the menu closed while still typing that same query", () => {
  const open: MenuState = { open: true, trigger: "@", query: "fi", start: 3, activeIndex: 0, dismissedStart: null };
  const dismissed = dismissMenu(open);
  expect(dismissed.open).toBe(false);
  expect(dismissed.dismissedStart).toBe(3);

  // User keeps typing more of the same query — still anchored at start 3 — menu stays shut.
  const stillTyping = reduceDetection(dismissed, { trigger: "@", query: "fix", start: 3 });
  expect(stillTyping.open).toBe(false);
  expect(stillTyping.dismissedStart).toBe(3);
});

test("escape-then-retype: a fresh trigger elsewhere reopens the menu", () => {
  const dismissed = dismissMenu({ open: true, trigger: "@", query: "fi", start: 3, activeIndex: 0, dismissedStart: null });
  const retyped = reduceDetection(dismissed, { trigger: "@", query: "", start: 12 });
  expect(retyped.open).toBe(true);
  expect(retyped.start).toBe(12);
});

// =============================================================================
// applyEmptyQueryDismiss — empty-result menu must not linger/hijack keys
// =============================================================================

test("applyEmptyQueryDismiss: leaves an open session alone while the query has no space yet (still a live search)", () => {
  const state: MenuState = { open: true, trigger: "@", query: "zzz", start: 3, activeIndex: 0, dismissedStart: null };
  expect(applyEmptyQueryDismiss(state, 0)).toEqual(state);
});

test("applyEmptyQueryDismiss: leaves an open session alone when it still has matches", () => {
  const state: MenuState = { open: true, trigger: "@", query: "fix login", start: 3, activeIndex: 0, dismissedStart: null };
  expect(applyEmptyQueryDismiss(state, 2)).toEqual(state);
});

test("applyEmptyQueryDismiss: dismisses once the query has a space AND zero matches", () => {
  const state: MenuState = { open: true, trigger: "@", query: "totally unknown", start: 3, activeIndex: 0, dismissedStart: null };
  const next = applyEmptyQueryDismiss(state, 0);
  expect(next.open).toBe(false);
  expect(next.dismissedStart).toBe(3); // sticky at this trigger position, same mechanism as Escape
});

test("applyEmptyQueryDismiss: a closed state is a no-op", () => {
  expect(applyEmptyQueryDismiss(CLOSED_MENU_STATE, 0)).toEqual(CLOSED_MENU_STATE);
});

// =============================================================================
// isImeComposing — IME guard shared by the composer and the trigger menu
// =============================================================================

test("isImeComposing: true when nativeEvent.isComposing is set", () => {
  expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true);
});

test("isImeComposing: true for the legacy keyCode 229 fallback", () => {
  expect(isImeComposing({ keyCode: 229 })).toBe(true);
});

test("isImeComposing: false for an ordinary keystroke", () => {
  expect(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
  expect(isImeComposing({})).toBe(false);
});

// =============================================================================
// comboboxAriaProps — full ARIA combobox wiring, closed and open states
// =============================================================================

test("comboboxAriaProps: closed state — collapsed, no active descendant, still wired to the listbox", () => {
  const props = comboboxAriaProps(false, null, "chat-trigger-menu-listbox");
  expect(props).toEqual({
    role: "combobox",
    "aria-expanded": false,
    "aria-controls": "chat-trigger-menu-listbox",
    "aria-activedescendant": undefined,
    "aria-autocomplete": "list",
    "aria-haspopup": "listbox",
  });
});

test("comboboxAriaProps: open state — expanded and pointing at the active option", () => {
  const props = comboboxAriaProps(true, "chat-trigger-menu-listbox-option-t1", "chat-trigger-menu-listbox");
  expect(props["aria-expanded"]).toBe(true);
  expect(props["aria-activedescendant"]).toBe("chat-trigger-menu-listbox-option-t1");
  expect(props["aria-controls"]).toBe("chat-trigger-menu-listbox");
  expect(props.role).toBe("combobox");
  expect(props["aria-autocomplete"]).toBe("list");
  expect(props["aria-haspopup"]).toBe("listbox");
});
