import { expect, test } from "bun:test";
import { buildChannelThreadViews, runSummary } from "./channelTimeline";
import { foldVerdict } from "./roomState";
import type { ChannelEntry } from "./dto";

function lifecycle(seq: number, kind: string, unit: string, text: string): ChannelEntry {
  return {
    id: `e${seq}`, seq, channelId: "fleet", authorActor: "manager", kind: "system", text, ts: seq * 1000,
    event: { kind, issuer: "manager", payload: { refs: { unitId: unit }, doorSurface: "unit", face: { unitId: unit, unitName: unit } } },
  } as ChannelEntry;
}

test("a quiet run summarises to a verdict a person could disagree with", () => {
  const views = buildChannelThreadViews([
    lifecycle(1, "unit-spawned", "wren", "unit spawned"),
    lifecycle(2, "verification-ran", "wren", "verification ran"),
    lifecycle(3, "unit-turn-finished", "wren", "turn finished"),
  ]);
  const summary = runSummary(views);
  expect(summary.count).toBe(3);
  expect(summary.unusual).toBeUndefined();
  // A count tells you the size of what you are not reading. A verdict tells you whether to read it.
  expect(foldVerdict(summary)).toContain("nothing unusual");
  expect(foldVerdict(summary)).not.toBe("3 lifecycle updates");
});

test("a run containing something alarming says what, instead of reassuring", () => {
  // The failure this prevents: a fold that always says "nothing unusual" is a fold nobody opens, and
  // then the one run that mattered is the one that got hidden.
  const views = buildChannelThreadViews([
    lifecycle(1, "unit-spawned", "wren", "unit spawned"),
    lifecycle(2, "unit-failed", "wren", "unit failed · TypeError"),
  ]);
  const summary = runSummary(views);
  expect(summary.unusual).toBeTruthy();
  expect(foldVerdict(summary)).not.toContain("nothing unusual");
});

test("the summary names the units involved, so the fold is addressable", () => {
  const views = buildChannelThreadViews([
    lifecycle(1, "unit-spawned", "wren", "spawned"),
    lifecycle(2, "unit-spawned", "pike", "spawned"),
  ]);
  expect(runSummary(views).agents.length).toBeGreaterThan(0);
});

test("a failed unit does not render like a unit that merely started", () => {
  // The defect this pins: `unit-failed` came back as tone "neutral" — identical to `unit-spawned`.
  // Every lifecycle card looked the same, so the one that mattered was invisible among the ones that
  // did not, and the fold above then reported "nothing unusual" over a failure.
  const [failed] = buildChannelThreadViews([lifecycle(1, "unit-failed", "wren", "unit failed · TypeError")]);
  const [spawned] = buildChannelThreadViews([lifecycle(2, "unit-spawned", "wren", "unit spawned")]);
  expect(failed!.tone).toBe("destructive");
  expect(spawned!.tone).toBe("neutral");
  expect(failed!.tone).not.toBe(spawned!.tone);
});

test("the fold notices a failure even if its tone is wrong", () => {
  // Defence in depth: tone is a rendering decision that HAS been wrong. A fold that inherits the
  // mistake hides exactly the run someone needed, so it keys on kind as well.
  const views = buildChannelThreadViews([lifecycle(1, "unit-failed", "wren", "unit failed")]);
  const forcedNeutral = views.map((view) => ({ ...view, tone: "neutral" as const }));
  expect(runSummary(forcedNeutral).unusual).toBeTruthy();
});
