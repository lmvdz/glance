import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoomNode } from "../../lib/roomState";
import { StatePane } from "./StatePane";

const T = 1_000_000_000;
const nodes: RoomNode[] = [
  { id: "a", address: "3.2", title: "the retry budget", state: "needs-you", owner: "Wren", dependents: ["3.3"] },
  { id: "b", address: "3.3", title: "the migration", state: "blocked", waitingOn: ["3.2"] },
  { id: "c", address: "3.1", title: "the parser", state: "settled" },
  { id: "d", address: "3.4", title: "the docs", state: "parked", lastMovementAt: T - 50 * 3_600_000 },
];

test("the pane shows the three regions and an explaining alarm band", () => {
  const html = renderToStaticMarkup(<StatePane nodes={nodes} now={T} />);
  expect(html).toContain("Needs you");
  expect(html).toContain("In flight");
  // One waiting item: the band reassures about everything else, rather than showing a count.
  expect(html).toContain("Everything else in the fleet is still moving");
  // Blocked work says what it waits on and what waits behind it.
  expect(html).toContain("cannot start until 3.2 is decided");
  expect(html).toContain("Only 3.3 is waiting behind it");
});

test("settled work is collapsed by default — done work leaves the working surface", () => {
  const html = renderToStaticMarkup(<StatePane nodes={nodes} now={T} />);
  // The region is present and countable, but its contents are not competing for the eye.
  expect(html).toContain("1 settled");
  expect(html).not.toContain("the parser");
});

test("parked work shows no elapsed time, however long it has sat", () => {
  // 50 hours since it last moved. An age here would read as overdue, and parked is a decision.
  const html = renderToStaticMarkup(<StatePane nodes={[nodes[3]!]} now={T} />);
  expect(html).toContain("Someone decided this waits");
  expect(html).not.toContain("50h");
});

test("a quiet pane reports a streak, not an empty list", () => {
  const html = renderToStaticMarkup(
    <StatePane nodes={[nodes[2]!]} now={T} autonomy={{ sinceMs: T - 6 * 3_600_000, bestRunMs: 9 * 3_600_000 }} />,
  );
  expect(html).toContain("unbroken autonomy");
  expect(html).toContain("longest run this month 9h");
  expect(html).not.toContain("Nothing to do");
});

test("no node is selected until someone selects one, so nothing previews on first paint", () => {
  // Select is an act. A pane that arrives with a selection has already made a choice for the reader.
  const html = renderToStaticMarkup(<StatePane nodes={nodes} now={T} />);
  expect(html).not.toContain("Press Enter to read its conversation");
});

test("every control states what it will do", () => {
  const html = renderToStaticMarkup(<StatePane nodes={nodes} now={T} />);
  // The collapse toggle carries a consequence sentence, not just a caret.
  expect(html).toContain("Show the 1 settled item again.");
});
