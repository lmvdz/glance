import { expect, test } from "bun:test";
import { getCategoryBadge } from "./utils";

test("getCategoryBadge falls back for unknown categories", () => {
  expect(getCategoryBadge("unknown")).toBe("bg-gray-100 text-gray-700");
});
