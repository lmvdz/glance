import { describe, expect, test } from "bun:test";
import { magma, normalizeHeatData } from "./heat-data";

describe("normalizeHeatData", () => {
  test("keeps daemon heat shape and normalizes numeric heat", () => {
    const data = normalizeHeatData({
      days: ["2026-06-23", "2026-06-24"],
      tree: [
        { id: "webapp/src", name: "src/", type: "folder", depth: 1 },
        { id: "webapp/src/App.tsx", name: "App.tsx", type: "file", depth: 2, heat: [-1, 0.5, 2, "bad"] },
      ],
      hotAreas: [{ rank: 1, path: "webapp/src/App.tsx", score: 99, tag: "GROWING", description: "busy" }],
      insights: [{ icon: "tests", title: "Add tests", detail: "Receipt churn is high." }],
      source: "receipts.filesTouched",
      generatedAt: 123,
    });

    expect(data.days).toEqual(["2026-06-23", "2026-06-24"]);
    expect(data.tree[1]).toMatchObject({ id: "webapp/src/App.tsx", type: "file", depth: 2, heat: [0, 0.25, 1] });
    expect(data.hotAreas[0]).toMatchObject({ path: "webapp/src/App.tsx", tag: "GROWING" });
    expect(data.insights[0]).toMatchObject({ icon: "tests", title: "Add tests" });
    expect(data.source).toBe("receipts.filesTouched");
  });

  test("accepts receipt-backed backend heat areas and string insights", () => {
    const data = normalizeHeatData({
      days: ["2026-06-24"],
      tree: [{ id: "webapp/src/App.tsx", name: "App.tsx", type: "file", depth: 2, heat: [3] }],
      hotAreas: [{ path: "webapp/src/App.tsx", heat: 3 }],
      insights: ["1 files touched in recent receipts"],
      source: "receipts.filesTouched",
    });

    expect(data.tree[0].heat).toEqual([1]);
    expect(data.hotAreas[0]).toMatchObject({ rank: 1, path: "webapp/src/App.tsx", score: 3 });
    expect(data.insights[0]).toMatchObject({ title: "1 files touched in recent receipts" });
    expect(data.source).toBe("receipts.filesTouched");
  });

  test("bad or empty daemon payload becomes honest empty data", () => {
    expect(normalizeHeatData(null)).toEqual({ days: [], tree: [], hotAreas: [], insights: [] });
    expect(normalizeHeatData({ days: ["2026-06-24"], tree: [{ id: "webapp/src/App.tsx", type: "unknown" }] }).tree).toEqual([]);
  });
});

describe("magma", () => {
  test("clamps color input", () => {
    expect(magma(-1)).toBe(magma(0));
    expect(magma(2)).toBe(magma(1));
  });
});
