import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FleetPulse, pulseCaption, type PulseBucket } from "./FleetPulse";

const T = new Date("2026-07-26T14:00:00Z").getTime();
const hours = (n: number) => n * 3_600_000;
const buckets: PulseBucket[] = [0, 1, 2, 3].map((i) => ({ at: T - hours(3 - i), events: [12, 40, 3, 27][i]!, interrupted: i === 2 }));

test("the bars are never shown without the sentence that says what they mean", () => {
  const html = renderToStaticMarkup(<FleetPulse buckets={buckets} last={{ at: T - hours(1), answeredAfterMs: 3 * 60_000, what: "Wren asking about the retry budget" }} now={T} />);
  expect(html).toContain("FLEET PULSE · EVENTS PER HOUR");
  expect(html).toContain("Wren asking about the retry budget");
  expect(html).toContain("You answered it in 3m and the fleet recovered on its own");
});

test("an hour with no events still draws a hairline", () => {
  // A zero-height bar is indistinguishable from an hour that was never measured — absence rendered
  // as a measurement of zero.
  const html = renderToStaticMarkup(<FleetPulse buckets={[{ at: T, events: 0 }, { at: T + hours(1), events: 10 }]} now={T} />);
  expect(html).toContain("height:1px");
});

test("no interruptions is stated as an achievement, not left as a blank caption", () => {
  const caption = pulseCaption(buckets, undefined, T);
  expect(caption).toContain("not one of them needed you");
  expect(caption).toContain("running itself");
});

test("idle is distinguished from quiet", () => {
  // A fleet doing nothing and a fleet needing nothing look identical on a chart and mean opposite
  // things.
  const caption = pulseCaption([{ at: T, events: 0 }], undefined, T);
  expect(caption).toContain("idle, not quiet");
  expect(caption).toContain("those are different");
});

test("an unanswered interruption says it is still waiting", () => {
  const caption = pulseCaption(buckets, { at: T - hours(1), what: "Wren asking about the retry budget" }, T);
  expect(caption).toContain("still waiting on you");
  // It must not claim YOU answered it — but it still states the blast radius, which is the point:
  // one thing is stuck and the rest of the fleet is not.
  expect(caption).not.toContain("You answered");
  expect(caption).toContain("Everything else recovered on its own");
});
