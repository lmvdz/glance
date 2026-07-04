/**
 * normalizeCapabilities: the UI reads `capabilities.packs.length` / `.map(...)`
 * directly, so a snapshot from a version-skewed daemon that omits a field must
 * not reach the components. This guards the boundary coercion that prevents
 * "can't access property length, packs is undefined" from crashing the app when
 * the nav (which renders a `packs.length` badge) mounts.
 */
import { describe, expect, test } from "bun:test";
import { appendTranscriptEntry, normalizeCapabilities, normalizeCatalog } from "./useSquad";
import type { TranscriptEntry } from "../lib/dto";

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

/**
 * appendTranscriptEntry: cap-eviction must not reorder a still-streaming
 * entry. A frozen region is indistinguishable from an idle agent, so a late
 * upsert for an id the 800-cap already evicted must be dropped, not appended
 * at the end where it would render out of order.
 */
describe("appendTranscriptEntry", () => {
  const entry = (over: Partial<TranscriptEntry>): TranscriptEntry => ({
    kind: "assistant",
    text: "x",
    ts: 0,
    ...over,
  });

  test("upserts an entry whose id is already in the window", () => {
    const entries = [entry({ id: "a", text: "first" }), entry({ id: "b", text: "second" })];
    const next = appendTranscriptEntry(entries, entry({ id: "a", text: "updated" }));
    expect(next).toHaveLength(2);
    expect(next[0].text).toBe("updated");
    expect(next[1].text).toBe("second");
  });

  test("appends a genuinely new entry", () => {
    const entries = [entry({ id: "a" })];
    const next = appendTranscriptEntry(entries, entry({ id: "b", text: "new" }));
    expect(next).toHaveLength(2);
    expect(next[1].id).toBe("b");
  });

  test("drops a stale upsert for an id the cap already evicted", () => {
    // Fill the window to cap (800) with strictly increasing seq/ts.
    const cap = 800;
    const entries: TranscriptEntry[] = [];
    for (let i = 0; i < cap; i++) entries.push(entry({ id: `id-${i}`, seq: i, ts: i }));
    // A late upsert for an id below the current head's seq (already evicted logically).
    const stale = entry({ id: "id-evicted", seq: -5, ts: -5 });
    const next = appendTranscriptEntry(entries, stale);
    expect(next).toHaveLength(cap);
    expect(next.some((item) => item.id === "id-evicted")).toBe(false);
  });

  test("still appends a new id at cap when it's newer than the head (slides the window)", () => {
    const cap = 800;
    const entries: TranscriptEntry[] = [];
    for (let i = 0; i < cap; i++) entries.push(entry({ id: `id-${i}`, seq: i, ts: i }));
    const fresh = entry({ id: "id-new", seq: cap + 1, ts: cap + 1 });
    const next = appendTranscriptEntry(entries, fresh);
    expect(next).toHaveLength(cap);
    expect(next[next.length - 1].id).toBe("id-new");
    expect(next[0].id).toBe("id-1");
  });

  test("falls back to ts ordering when seq is absent", () => {
    const cap = 800;
    const entries: TranscriptEntry[] = [];
    for (let i = 0; i < cap; i++) entries.push(entry({ id: `id-${i}`, ts: i }));
    const stale = entry({ id: "id-evicted", ts: -1 });
    const next = appendTranscriptEntry(entries, stale);
    expect(next).toHaveLength(cap);
    expect(next.some((item) => item.id === "id-evicted")).toBe(false);
  });
});
