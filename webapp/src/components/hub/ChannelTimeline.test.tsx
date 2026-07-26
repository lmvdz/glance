import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { attachedImagePromptRef } from "../../lib/imageAttachment";
import { buildChannelThreadViews } from "../../lib/channelTimeline";
import { ChannelTimelineRow } from "./ChannelTimeline";

test("ChannelTimelineRow renders an attached image inline without exposing its transport fence", () => {
  const attachmentId = "8f14e45f-ceea-467e-9d1a-1234567890ab";
  const [view] = buildChannelThreadViews([{
    id: "entry-1",
    seq: 1,
    channelId: "fleet",
    authorActor: "operator",
    kind: "user",
    text: `Please inspect this screenshot\n\n${attachedImagePromptRef(`/state/chat-attachments/${attachmentId}.png`)}`,
    ts: 0,
  }]);
  if (!view) throw new Error("Expected the channel entry to produce a timeline view");
  const html = renderToStaticMarkup(<ChannelTimelineRow view={view} />);

  expect(html).toContain("Please inspect this screenshot");
  expect(html).toContain(`/api/chat-attachments/${attachmentId}`);
  expect(html).not.toContain("BEGIN attached image");
});
