/**
 * normalizeCapabilities: the UI reads `capabilities.packs.length` / `.map(...)`
 * directly, so a snapshot from a version-skewed daemon that omits a field must
 * not reach the components. This guards the boundary coercion that prevents
 * "can't access property length, packs is undefined" from crashing the app when
 * the nav (which renders a `packs.length` badge) mounts.
 */
import { describe, expect, test } from "bun:test";
import { normalizeCapabilities } from "./useSquad";

describe("normalizeCapabilities", () => {
  test("fills missing arrays for a partial/empty payload", () => {
    expect(normalizeCapabilities({})).toEqual({ sources: [], packs: [], installs: [] });
  });

  test("tolerates null / undefined (network fallbacks)", () => {
    expect(normalizeCapabilities(null)).toEqual({ sources: [], packs: [], installs: [] });
    expect(normalizeCapabilities(undefined)).toEqual({ sources: [], packs: [], installs: [] });
  });

  test("coerces non-array fields (drifted shape) to empty arrays", () => {
    // e.g. an older daemon that returned packs as an object, or an error body.
    const bad = { sources: "oops", packs: { 0: "x" }, installs: 42 } as never;
    expect(normalizeCapabilities(bad)).toEqual({ sources: [], packs: [], installs: [] });
  });

  test("preserves well-formed arrays verbatim", () => {
    const good = {
      sources: [{ id: "s1" }],
      packs: [{ id: "p1" }, { id: "p2" }],
      installs: [{ id: "i1" }],
    } as never;
    const out = normalizeCapabilities(good);
    expect(out.packs.length).toBe(2);
    expect(out.sources).toBe(good.sources);
  });
});
