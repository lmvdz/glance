import { expect, test } from "bun:test";
import { getCategoryBadge } from "./utils";

test("getCategoryBadge falls back for unknown categories", () => {
  expect(getCategoryBadge("unknown")).toBe("bg-gray-100 text-gray-700");
});

test("getCategoryBadge renders 'other' as the same neutral tone as the unknown-value default", () => {
  expect(getCategoryBadge("other")).toBe("bg-gray-100 text-gray-700");
  expect(getCategoryBadge("other")).toBe(getCategoryBadge("unknown"));
});
