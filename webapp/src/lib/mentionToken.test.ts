import { expect, test } from "bun:test";
import { expandMentionTokens, mentionToken, serializeMention, type MentionTarget } from "./mentionGrammar";

const pike: MentionTarget = { kind: "agent", id: "pike-ms24cs99-2-0a509ab2", label: "pike" };
const pikeTwo: MentionTarget = { kind: "agent", id: "pike-two-abc", label: "pike two" };

test("a person sees a name, the wire gets the address", () => {
  // The defect: the composer inserted the full address into the textarea, so you typed to Pike and
  // watched a UUID appear mid-sentence.
  expect(mentionToken(pike)).toBe("@pike");
  expect(expandMentionTokens("@pike can you check the retry budget", [pike]))
    .toBe(`${serializeMention(pike)} can you check the retry budget`);
});

test("a longer token is not clobbered by a shorter one that prefixes it", () => {
  const out = expandMentionTokens("@pike-two please look", [pike, pikeTwo]);
  expect(out).toBe(`${serializeMention(pikeTwo)} please look`);
  expect(out).not.toContain("@pike-two");
});

test("an unknown token is left exactly as typed, never guessed at", () => {
  // Absence of a match is not a licence to invent a target.
  expect(expandMentionTokens("@nobody hello", [pike])).toBe("@nobody hello");
  expect(expandMentionTokens("email me at a@pike.dev", [pike])).toBe("email me at a@pike.dev");
});

test("expansion with no known targets changes nothing", () => {
  expect(expandMentionTokens("@pike hello", [])).toBe("@pike hello");
});

test("a sent message body splits into text and mention links", async () => {
  // The composer was fixed to show "@pike" while typing, but the message that ARRIVES carries the
  // wire format — so the room was still showing every reader a UUID in brackets. Both surfaces have
  // to speak the same way, or the half everyone else reads is the wrong half.
  const { segmentMentionLinks } = await import("../components/chat/MentionOverlay");
  const segments = segmentMentionLinks(
    "[@pike](omp://agent/pike-ms24cs99-2-0a509ab2) [@wren](omp://agent/wren-ms24cj1k-1-77729055) hello",
  );
  expect(segments.filter((s) => s.kind === "mention").map((s) => s.label)).toEqual(["pike", "wren"]);
  expect(segments.map((s) => s.text).join("")).toContain("hello");
  // Text with no mentions is one plain run, so the common case renders without wrapping every word.
  expect(segmentMentionLinks("just a message")).toEqual([{ kind: "text", text: "just a message" }]);
});
