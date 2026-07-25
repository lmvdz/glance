import { expect, test } from "bun:test";
import { getCategoryBadge } from "./utils";

test("getCategoryBadge falls back for unknown categories", () => {
  expect(getCategoryBadge("unknown")).toBe("bg-ink-surface text-ink-text-label");
});

test("getCategoryBadge renders 'other' as the same neutral tone as the unknown-value default", () => {
  expect(getCategoryBadge("other")).toBe("bg-ink-surface text-ink-text-label");
  expect(getCategoryBadge("other")).toBe(getCategoryBadge("unknown"));
});
