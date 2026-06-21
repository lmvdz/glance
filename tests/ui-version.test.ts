/**
 * computeUiVersion — stable fingerprint of the served UI, driving tab self-refresh after an upgrade.
 */

import { expect, test } from "bun:test";
import { computeUiVersion } from "../src/server.ts";

test("same html yields the same version", () => {
	const html = "<html><body>squad</body></html>";
	expect(computeUiVersion(html)).toBe(computeUiVersion(html));
});

test("changed html yields a different version", () => {
	const a = computeUiVersion("<html>v1</html>");
	const b = computeUiVersion("<html>v2</html>");
	expect(a).not.toBe(b);
});

test("version is a short non-empty token", () => {
	const v = computeUiVersion("<html></html>");
	expect(v.length).toBe(12);
	expect(v).toMatch(/^[0-9a-f]+$/);
});
