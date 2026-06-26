import { expect, test } from "bun:test";
import { fuzzyRank, subseqScore } from "./fuzzy";

test("subseqScore matches a subsequence and rejects a miss", () => {
  expect(subseqScore("agents", "agt")).toBeGreaterThanOrEqual(0);
  expect(subseqScore("agents", "xyz")).toBe(-1);
  expect(subseqScore("agents", "")).toBe(0);
});

test("contiguous match scores better (lower) than a gapped one", () => {
  expect(subseqScore("graph", "gr")).toBeLessThan(subseqScore("graph", "gh"));
});

test("fuzzyRank keeps order on empty query", () => {
  expect(fuzzyRank(["a", "b", "c"], "", (x) => x)).toEqual(["a", "b", "c"]);
});

test("fuzzyRank filters then ranks best-first", () => {
  const r = fuzzyRank(["Inbox", "Agents", "Features", "Graph", "Audit"], "ag", (x) => x);
  expect(r[0]).toBe("Agents");
  expect(r).not.toContain("Inbox");
});
