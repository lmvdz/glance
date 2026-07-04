import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applySuggestionChip,
  ComposerAttachmentChip,
  assembleSendText,
  clampGrownHeight,
  COMPOSER_MAX_HEIGHT_PX,
  formatPasteSize,
  INITIAL_RECALL_STATE,
  pasteChipLabel,
  PASTE_CHIP_THRESHOLD,
  pushPromptHistory,
  PROMPT_HISTORY_LIMIT,
  recallNewer,
  recallOlder,
  shouldChipPaste,
  type HistoryRecallState,
  type PasteChip,
} from "./Composer";

// ---------------------------------------------------------------------------
// Auto-grow
// ---------------------------------------------------------------------------

test("clampGrownHeight passes short content through unchanged", () => {
  expect(clampGrownHeight(20)).toBe(20);
  expect(clampGrownHeight(COMPOSER_MAX_HEIGHT_PX - 1)).toBe(COMPOSER_MAX_HEIGHT_PX - 1);
});

test("clampGrownHeight caps at the ~8-line max so the textarea scrolls instead of growing further", () => {
  expect(clampGrownHeight(500)).toBe(COMPOSER_MAX_HEIGHT_PX);
  expect(clampGrownHeight(COMPOSER_MAX_HEIGHT_PX)).toBe(COMPOSER_MAX_HEIGHT_PX);
});

// ---------------------------------------------------------------------------
// History recall
// ---------------------------------------------------------------------------

test("pushPromptHistory inserts newest-first", () => {
  expect(pushPromptHistory([], "first")).toEqual(["first"]);
  expect(pushPromptHistory(["first"], "second")).toEqual(["second", "first"]);
});

test("pushPromptHistory caps at the configured limit, dropping the oldest", () => {
  const history = Array.from({ length: PROMPT_HISTORY_LIMIT }, (_, i) => `entry-${i}`);
  const next = pushPromptHistory(history, "newest");
  expect(next.length).toBe(PROMPT_HISTORY_LIMIT);
  expect(next[0]).toBe("newest");
  expect(next).not.toContain(`entry-${PROMPT_HISTORY_LIMIT - 1}`); // oldest fell off
});

test("recallOlder walks back through history newest-first and saves the live draft on first step", () => {
  const history = ["c (newest)", "b", "a (oldest)"];
  const step1 = recallOlder(INITIAL_RECALL_STATE, history, "my draft");
  expect(step1).toEqual({ state: { index: 0, draft: "my draft" }, value: "c (newest)" });

  const step2 = recallOlder(step1!.state, history, "my draft");
  expect(step2).toEqual({ state: { index: 1, draft: "my draft" }, value: "b" });

  const step3 = recallOlder(step2!.state, history, "my draft");
  expect(step3).toEqual({ state: { index: 2, draft: "my draft" }, value: "a (oldest)" });
});

test("recallOlder stops at the oldest entry instead of running off the end", () => {
  const history = ["only"];
  const step1 = recallOlder(INITIAL_RECALL_STATE, history, "draft");
  expect(step1).toEqual({ state: { index: 0, draft: "draft" }, value: "only" });
  const step2 = recallOlder(step1!.state, history, "draft");
  expect(step2).toBeNull();
});

test("recallOlder is a no-op with no history", () => {
  expect(recallOlder(INITIAL_RECALL_STATE, [], "draft")).toBeNull();
});

test("recallNewer walks forward and restores the saved draft at the bottom", () => {
  const history = ["c", "b", "a"];
  const deep: HistoryRecallState = { index: 2, draft: "my draft" };
  const step1 = recallNewer(deep, history);
  expect(step1).toEqual({ state: { index: 1, draft: "my draft" }, value: "b" });

  const step2 = recallNewer(step1!.state, history);
  expect(step2).toEqual({ state: { index: 0, draft: "my draft" }, value: "c" });

  const step3 = recallNewer(step2!.state, history);
  expect(step3).toEqual({ state: INITIAL_RECALL_STATE, value: "my draft" });
});

test("recallNewer is a no-op when already at the live draft", () => {
  expect(recallNewer(INITIAL_RECALL_STATE, ["a"])).toBeNull();
});

// ---------------------------------------------------------------------------
// Paste-as-chip
// ---------------------------------------------------------------------------

test("shouldChipPaste routes short pastes into the textarea as usual", () => {
  expect(shouldChipPaste("a".repeat(PASTE_CHIP_THRESHOLD))).toBe(false);
  expect(shouldChipPaste("short paste")).toBe(false);
});

test("shouldChipPaste routes pastes past the threshold into a chip", () => {
  expect(shouldChipPaste("a".repeat(PASTE_CHIP_THRESHOLD + 1))).toBe(true);
});

test("formatPasteSize renders kilobytes to one decimal place", () => {
  expect(formatPasteSize(2048)).toBe("2.0 KB");
  expect(formatPasteSize(3276.8)).toBe("3.2 KB");
});

test("pasteChipLabel names the chip by byte size, not character count", () => {
  expect(pasteChipLabel("a".repeat(2048))).toBe("Pasted text · 2.0 KB");
});

test("assembleSendText returns the typed text unchanged when there are no chips", () => {
  expect(assembleSendText("hello", [])).toBe("hello");
});

test("assembleSendText fences chip contents after the typed message, in attach order", () => {
  const chips: PasteChip[] = [
    { id: "1", label: "Pasted text · 1.0 KB", content: "first pasted block" },
    { id: "2", label: "Pasted text · 2.0 KB", content: "second pasted block" },
  ];
  const result = assembleSendText("check this out", chips);
  expect(result).toBe("check this out\n\n```\nfirst pasted block\n```\n\n```\nsecond pasted block\n```");
  // Order: the typed message precedes the first chip, which precedes the second.
  expect(result.indexOf("check this out")).toBeLessThan(result.indexOf("first pasted block"));
  expect(result.indexOf("first pasted block")).toBeLessThan(result.indexOf("second pasted block"));
});

test("assembleSendText handles a chip-only send (no typed text)", () => {
  const chips: PasteChip[] = [{ id: "1", label: "Pasted text · 1.0 KB", content: "just this" }];
  expect(assembleSendText("", chips)).toBe("```\njust this\n```");
});

// ---------------------------------------------------------------------------
// Suggestion chips: insert, never destroy the draft, never auto-send.
// ---------------------------------------------------------------------------

test("applySuggestionChip fills an empty composer with the suggestion", () => {
  expect(applySuggestionChip("", "draft a release note")).toBe("draft a release note");
  expect(applySuggestionChip("   ", "draft a release note")).toBe("draft a release note"); // whitespace-only counts as empty
});

test("applySuggestionChip leaves an existing draft untouched rather than destroying it", () => {
  expect(applySuggestionChip("my half-typed message", "draft a release note")).toBe("my half-typed message");
});

// ---------------------------------------------------------------------------
// Static markup
// ---------------------------------------------------------------------------

test("ComposerAttachmentChip renders the label and a remove control", () => {
  const chip: PasteChip = { id: "1", label: "Pasted text · 3.2 KB", content: "some pasted content" };
  const html = renderToStaticMarkup(
    <ComposerAttachmentChip chip={chip} expanded={false} onToggle={() => {}} onRemove={() => {}} onInsertInline={() => {}} />
  );
  expect(html).toContain("Pasted text · 3.2 KB");
  expect(html).toContain('aria-label="Remove Pasted text · 3.2 KB"');
  expect(html).not.toContain("Insert inline"); // collapsed — preview/escape hatch not shown yet
});

test("ComposerAttachmentChip shows the preview and insert-inline escape hatch when expanded", () => {
  const chip: PasteChip = { id: "1", label: "Pasted text · 3.2 KB", content: "the full pasted content" };
  const html = renderToStaticMarkup(
    <ComposerAttachmentChip chip={chip} expanded onToggle={() => {}} onRemove={() => {}} onInsertInline={() => {}} />
  );
  expect(html).toContain("the full pasted content");
  expect(html).toContain("Insert inline");
});
