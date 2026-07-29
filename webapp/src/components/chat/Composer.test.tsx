import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applySuggestionChip,
  Composer,
  ComposerAttachmentChip,
  ComposerImageThumb,
  RoomCallIconControls,
  assembleSendText,
  frictionCaptureBody,
  clampGrownHeight,
  COMPOSER_MAX_HEIGHT_PX,
  formatPasteSize,
  imageAttachmentError,
  INITIAL_RECALL_STATE,
  pasteChipLabel,
  PASTE_CHIP_THRESHOLD,
  pushPromptHistory,
  PROMPT_HISTORY_LIMIT,
  recallNewer,
  recallOlder,
  shouldChipPaste,
  type HistoryRecallState,
  type ImageAttachment,
  type PasteChip,
  type RoomCallComposerState,
} from "./Composer";
import type { VoiceCallBindingDTO } from "../../lib/api";

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

test("imageAttachmentError keeps rejected files visible with a concrete recovery message", () => {
  expect(imageAttachmentError({ name: "notes.pdf", type: "application/pdf", size: 10 } as File)).toBe(
    "notes.pdf is not a supported image. Attach a PNG, JPEG, GIF, WebP, or another raster image instead.",
  );
  expect(imageAttachmentError({ name: "huge.png", type: "image/png", size: 4 * 1024 * 1024 + 1 } as File)).toBe(
    "huge.png is 4.0 MB. Images must be 4 MB or smaller before upload.",
  );
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

test("ComposerImageThumb keeps a failed preview visible and names the retry action", () => {
  const image: ImageAttachment = { id: "image-1", dataUrl: "data:image/png;base64,abc", width: 1, height: 1, annotations: [], annotated: false };
  const html = renderToStaticMarkup(<ComposerImageThumb image={image} status="failed" onAnnotate={() => {}} onRemove={() => {}} />);
  expect(html).toContain('alt="Image ready to send"');
  expect(html).toContain("Upload failed. Send again to retry.");
});

// ---------------------------------------------------------------------------
// Friction capture (plans/daily-dogfood-engine/01)
// ---------------------------------------------------------------------------

test("frictionCaptureBody trims the gripe and rides the active agent's repo/id", () => {
  const body = frictionCaptureBody("  the spinner lies  ", { id: "chat-1", repo: "/home/me/proj" } as never);
  expect(body).toEqual({ repo: "/home/me/proj", gripe: "the spinner lies", context: "webapp-composer", agentId: "chat-1" });
});

test("frictionCaptureBody still captures without an agent (repo '', no agentId) — never refuses the annoyed operator", () => {
  const body = frictionCaptureBody("slow load");
  expect(body).toEqual({ repo: "", gripe: "slow load", context: "webapp-composer" });
  expect(body && "agentId" in body).toBe(false);
});

test("frictionCaptureBody returns null for an empty-after-trim gripe — nothing is ever POSTed", () => {
  expect(frictionCaptureBody("   ")).toBeNull();
  expect(frictionCaptureBody("")).toBeNull();
});

// ---------------------------------------------------------------------------
// Post-ship fix: composer call controls (fleet navbar + composer call controls).
//
// The room's own live call used to render as a standing "Call" banner above every timeline
// (`VoiceCallHudView`) — permanently on screen, whether or not anyone cared, and the operator
// crossed it out. Its start/mute/end controls relocated here, into the composer's icon row, as
// `RoomCallIconControls` — a straight relocation of `useRoomCall`'s own handlers, not new call
// logic. These tests prove the relocation landed: the call icon appears idle, swaps to mute+end
// once a call is bound and live, and the old banner text never appears anywhere in Composer.
// ---------------------------------------------------------------------------

const LIVE_BINDING: VoiceCallBindingDTO = {
  channelId: "fleet",
  callId: "call-1",
  sessionId: "session-1",
  sessionRoot: "/tmp/session-1",
  ownerActorId: "db:alice",
  retention: "full",
  startedAt: 1_000,
  updatedAt: 1_000,
  state: "live",
  controlsAvailable: true,
};

const ENDED_BINDING: VoiceCallBindingDTO = { ...LIVE_BINDING, state: "ended", endedAt: 2_000, controlsAvailable: false };

const baseRoomCall = (overrides: Partial<RoomCallComposerState> = {}): RoomCallComposerState => ({
  binding: null,
  loading: false,
  starting: false,
  ending: false,
  muted: false,
  muteBusy: false,
  controlsAvailable: true,
  canStart: true,
  onStart: () => {},
  onEnd: () => {},
  onToggleMute: () => {},
  ...overrides,
});

const minimalComposerProps = {
  tasks: [],
  suggestionChips: [],
  isLoading: false,
  isStopShown: false,
  stopPending: false,
  onStop: () => {},
  onSend: () => {},
  selectedModel: "",
  modelOptions: [{ value: "", label: "Default model" }],
  onModelChange: () => {},
};

test("RoomCallIconControls: idle (no binding yet) renders a single call-starting icon, nothing else", () => {
  const html = renderToStaticMarkup(<RoomCallIconControls {...baseRoomCall()} />);
  expect(html).toContain('aria-label="Start a call in this thread"');
  expect(html).not.toContain("Unmute the microphone");
  expect(html).not.toContain("Mute the microphone");
  expect(html).not.toContain('aria-label="End the call"');
});

test("RoomCallIconControls: a call already ended distinguishes itself as \"start ANOTHER call\" (aria-label/title only — no room for visible text on an icon)", () => {
  const html = renderToStaticMarkup(<RoomCallIconControls {...baseRoomCall({ binding: ENDED_BINDING })} />);
  expect(html).toContain('aria-label="Start another call in this thread"');
});

test("RoomCallIconControls: canStart=false (a unit's own conversation) withholds the invitation to start", () => {
  const html = renderToStaticMarkup(<RoomCallIconControls {...baseRoomCall({ canStart: false })} />);
  expect(html).toBe("");
});

test("RoomCallIconControls: the daemon hasn't said yet whether a call exists (`checking`) — no button, never a click that could race the single-active-call guard", () => {
  const html = renderToStaticMarkup(<RoomCallIconControls {...baseRoomCall({ loading: true })} />);
  expect(html).toBe("");
});

test("RoomCallIconControls: a live call swaps the SAME slot to icon-only mute + end", () => {
  const html = renderToStaticMarkup(<RoomCallIconControls {...baseRoomCall({ binding: LIVE_BINDING })} />);
  expect(html).toContain('aria-label="Mute the microphone"');
  expect(html).toContain('aria-label="End the call"');
  expect(html).not.toContain('aria-label="Start a call in this thread"');
  expect(html).not.toContain('aria-label="Start another call in this thread"');
});

test("RoomCallIconControls: muted reflects in the aria-label (asked-for state, no read-back — same honesty rule the old HUD copy used)", () => {
  const html = renderToStaticMarkup(<RoomCallIconControls {...baseRoomCall({ binding: LIVE_BINDING, muted: true })} />);
  expect(html).toContain('aria-label="Unmute the microphone"');
  expect(html).not.toContain('aria-label="Mute the microphone"');
});

test("RoomCallIconControls: a live call bound to a unit's own conversation still shows mute+end — hiding a live call would be the worse lie", () => {
  const html = renderToStaticMarkup(<RoomCallIconControls {...baseRoomCall({ binding: LIVE_BINDING, canStart: false })} />);
  expect(html).toContain('aria-label="Mute the microphone"');
  expect(html).toContain('aria-label="End the call"');
});

test("RoomCallIconControls: a failed start attempt stays honest via the icon's title, since there's no room left for standing text", () => {
  const html = renderToStaticMarkup(<RoomCallIconControls {...baseRoomCall({ error: "the bridge refused the connection" })} />);
  expect(html).toContain("the bridge refused the connection");
  expect(html).toContain('aria-label="Start a call — the last attempt failed"');
});

test("Composer: the call icon shows Start when idle, and never the old standing banner's text", () => {
  const html = renderToStaticMarkup(<Composer {...minimalComposerProps} roomCall={baseRoomCall()} />);
  expect(html).toContain('aria-label="Start a call in this thread"');
  expect(html).not.toContain('aria-label="Mute the microphone"');
  expect(html).not.toContain('aria-label="End the call"');
  // The old VoiceCallHudView banner's own copy — none of it belongs in the composer, or anywhere
  // else in this render, now that the banner itself is gone.
  expect(html).not.toContain("Rooms use the live call lane only");
  expect(html).not.toContain("RECORDING IN FULL");
});

test("Composer: the call icon swaps to mute+end while the call is live", () => {
  const html = renderToStaticMarkup(<Composer {...minimalComposerProps} roomCall={baseRoomCall({ binding: LIVE_BINDING })} />);
  expect(html).toContain('aria-label="Mute the microphone"');
  expect(html).toContain('aria-label="End the call"');
  expect(html).not.toContain('aria-label="Start a call in this thread"');
});

test("Composer: with no roomCall prop at all (a mount outside any room), no call icon renders", () => {
  const html = renderToStaticMarkup(<Composer {...minimalComposerProps} />);
  expect(html).not.toContain('aria-label="Start a call in this thread"');
  expect(html).not.toContain('aria-label="Mute the microphone"');
  expect(html).not.toContain('aria-label="End the call"');
});
