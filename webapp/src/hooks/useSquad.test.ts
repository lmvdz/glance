/**
 * normalizeCapabilities: the UI reads `capabilities.packs.length` / `.map(...)`
 * directly, so a snapshot from a version-skewed daemon that omits a field must
 * not reach the components. This guards the boundary coercion that prevents
 * "can't access property length, packs is undefined" from crashing the app when
 * the nav (which renders a `packs.length` badge) mounts.
 */
import { describe, expect, test } from "bun:test";
import { normalizeCapabilities, normalizeCatalog } from "./useSquad";

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

/**
 * normalizeCatalog: the workbench nav renders `publicCatalog.length`, and the
 * `/api/capability-catalog` handler wraps its rows in `{ catalog: [...] }`. A
 * body without a `catalog` array — a bare array from an older daemon, an error
 * body, `{}` — must not reach the state as `undefined`, or expanding the pane
 * throws "can't access property length, publicCatalog is undefined".
 */
describe("normalizeCatalog", () => {
  test("unwraps the { catalog } envelope", () => {
    const rows = [{ id: "c1" }, { id: "c2" }];
    expect(normalizeCatalog({ catalog: rows })).toBe(rows);
  });

  test("falls back to [] for a missing/empty/partial body", () => {
    expect(normalizeCatalog({})).toEqual([]);
    expect(normalizeCatalog(null)).toEqual([]);
    expect(normalizeCatalog(undefined)).toEqual([]);
  });

  test("tolerates a bare array (drifted shape) by passing it through", () => {
    const rows = [{ id: "c1" }];
    expect(normalizeCatalog(rows)).toBe(rows);
  });

  test("coerces a non-array catalog field to []", () => {
    expect(normalizeCatalog({ catalog: "oops" } as never)).toEqual([]);
    expect(normalizeCatalog(42 as never)).toEqual([]);
  });
});
