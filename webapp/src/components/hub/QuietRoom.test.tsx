import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoomNode } from "../../lib/roomState";
import { QuietRoom } from "./QuietRoom";

const T = 1_000_000_000;
const nodes: RoomNode[] = [
  { id: "a", address: "3.1", title: "the parser", state: "settled" },
  { id: "b", address: "3.2", title: "the retry budget", state: "needs-you" },
  { id: "c", address: "3.3", title: "the migration", state: "in-flight" },
];

test("a quiet room is a handover, not a promise that something will happen", () => {
  // The old empty state said fleet cards "will land here as the room wakes up" — a statement about
  // the future. Somebody back after four hours wants to know what happened, not what might.
  const html = renderToStaticMarkup(<QuietRoom nodes={nodes} awayMs={4 * 3_600_000} now={T} />);
  expect(html).toContain("While you were away");
  expect(html).toContain("Finished");
  expect(html).toContain("the parser");
  expect(html).not.toContain("will land here");
});

test("what needed a person and got no answer is unmissable and still actionable", () => {
  const html = renderToStaticMarkup(<QuietRoom nodes={nodes} awayMs={4 * 3_600_000} now={T} />);
  expect(html).toContain("needed you and got no answer");
  expect(html).toContain("the retry budget");
  expect(html).toContain("still actionable");
});

test("it says what it left out, so a bounded summary never reads as complete", () => {
  // One unit is still in flight; that is on the state pane, not here. Saying so keeps this from
  // reading as the whole picture.
  const html = renderToStaticMarkup(<QuietRoom nodes={nodes} awayMs={3_600_000} now={T} />);
  expect(html).toContain("not listed here");
});

test("a first visit is not a quiet morning, and does not pretend to be", () => {
  // "Nothing has happened yet" and "nothing happened while you were away" are different facts and
  // must not share a screen.
  const html = renderToStaticMarkup(<QuietRoom nodes={[]} now={T} />);
  expect(html).toContain("Nothing has run here yet");
  expect(html).toContain("first visit, not a quiet morning");
  expect(html).not.toContain("While you were away");
});

test("it explains WHY the room is quiet rather than leaving it to be read as broken", () => {
  // A silent room is the designed state. Without saying so it reads as the twelve-hour silence that
  // concern 27 was filed over.
  const html = renderToStaticMarkup(<QuietRoom nodes={nodes} awayMs={3_600_000} now={T} />);
  expect(html).toContain("Quiet here means the fleet is working, not that");
});

test("it does not claim an absence that did not happen", () => {
  // Seen live: the panel said "WHILE YOU WERE AWAY" on a first load with no recorded absence. Small
  // lies in the copy are how a reader learns to discount the rest of it.
  const arrived = renderToStaticMarkup(<QuietRoom nodes={nodes} now={T} />);
  expect(arrived).toContain("Where things stand");
  expect(arrived).not.toContain("While you were away");
  const away = renderToStaticMarkup(<QuietRoom nodes={nodes} awayMs={4 * 3_600_000} now={T} />);
  expect(away).toContain("While you were away");
});
