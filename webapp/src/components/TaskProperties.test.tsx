import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CATEGORY_OPTIONS, CategoryChip } from "./TaskProperties";

// #category-honesty (CANVAS-AND-PAGE-CHAT.md D1): the category chip becomes an editable
// select — CategoryChip is kept pure (no TaskContext) precisely so it SSR-renders standalone
// here without a TaskProvider/useSquad websocket stack. This is the "SSR-render the chip states"
// verification path (no live daemon needed for this unit's acceptance).

test("CategoryChip lists every category option, including the new 'other' bucket", () => {
  expect(CATEGORY_OPTIONS).toEqual(["frontend", "backend", "devops", "mcp", "database", "other"]);
});

test("CategoryChip: no override selects 'Auto · <derived>' and shows the derived tone", () => {
  const html = renderToStaticMarkup(<CategoryChip category="frontend" onChange={() => {}} />);
  expect(html).toContain('aria-label="Category"');
  expect(html).toContain("Auto · frontend");
  expect(html).toContain('selected=""'); // the Auto option (value="") is selected when no override is set
  expect(html).toContain("#fee2e2"); // frontend badge tone still drives the chip color
});

test("CategoryChip: an override selects that option, not Auto", () => {
  const html = renderToStaticMarkup(<CategoryChip category="devops" override="devops" onChange={() => {}} />);
  expect(html).toContain('<option value="devops" selected="">devops</option>');
  expect(html).not.toContain('<option value="" selected="">');
});

test("CategoryChip: 'other' renders the honest neutral tone, not a made-up fifth color", () => {
  const html = renderToStaticMarkup(<CategoryChip category="other" onChange={() => {}} />);
  expect(html).toContain("Auto · other");
  expect(html).toContain("bg-gray-100");
  expect(html).toContain("text-gray-700");
});

test("CategoryChip: every option renders as a real <option>, none dropped", () => {
  const html = renderToStaticMarkup(<CategoryChip category="mcp" override="mcp" onChange={() => {}} />);
  for (const option of CATEGORY_OPTIONS) expect(html).toContain(`>${option}</option>`);
});
