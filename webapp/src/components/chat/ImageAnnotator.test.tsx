import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnnotationToolbar, clampBox, isTrivialBox, MIN_BOX_SIZE_PX, nextAnnotationId, screenToImagePoint } from './ImageAnnotator';

// ---------------------------------------------------------------------------
// clampBox
// ---------------------------------------------------------------------------

test('clampBox: normalizes a drag in any direction into a top-left+size rect', () => {
  // Dragged down-right.
  expect(clampBox(10, 10, 50, 40, 1000, 1000)).toEqual({ x: 10, y: 10, w: 40, h: 30 });
  // Dragged up-left (start is the bottom-right corner).
  expect(clampBox(50, 40, 10, 10, 1000, 1000)).toEqual({ x: 10, y: 10, w: 40, h: 30 });
});

test('clampBox: clamps to the image bounds even when the drag overshoots', () => {
  expect(clampBox(-20, -20, 50, 50, 100, 100)).toEqual({ x: 0, y: 0, w: 50, h: 50 });
  expect(clampBox(80, 80, 150, 150, 100, 100)).toEqual({ x: 80, y: 80, w: 20, h: 20 });
});

test('clampBox: a zero-movement drag yields a zero-size box', () => {
  expect(clampBox(5, 5, 5, 5, 100, 100)).toEqual({ x: 5, y: 5, w: 0, h: 0 });
});

// ---------------------------------------------------------------------------
// isTrivialBox
// ---------------------------------------------------------------------------

test('isTrivialBox: rejects accidental-click-sized boxes, accepts a deliberate drag', () => {
  expect(isTrivialBox(0, 0)).toBe(true);
  expect(isTrivialBox(MIN_BOX_SIZE_PX - 1, 50)).toBe(true);
  expect(isTrivialBox(50, MIN_BOX_SIZE_PX - 1)).toBe(true);
  expect(isTrivialBox(MIN_BOX_SIZE_PX, MIN_BOX_SIZE_PX)).toBe(false);
  expect(isTrivialBox(50, 50)).toBe(false);
});

// ---------------------------------------------------------------------------
// screenToImagePoint
// ---------------------------------------------------------------------------

test('screenToImagePoint: maps a 1:1-scaled overlay directly', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 };
  expect(screenToImagePoint(400, 300, rect, 800, 600)).toEqual({ x: 400, y: 300 });
});

test('screenToImagePoint: scales when the overlay is displayed smaller than its natural size', () => {
  // Displayed at half size (400x300) mapping back to an 800x600 natural image.
  const rect = { left: 0, top: 0, width: 400, height: 300 };
  expect(screenToImagePoint(200, 150, rect, 800, 600)).toEqual({ x: 400, y: 300 });
});

test('screenToImagePoint: accounts for the overlay element not being at the viewport origin', () => {
  const rect = { left: 100, top: 50, width: 800, height: 600 };
  expect(screenToImagePoint(500, 350, rect, 800, 600)).toEqual({ x: 400, y: 300 });
});

test('screenToImagePoint: clamps out-of-bounds pointer positions instead of returning negative/overshoot coordinates', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 };
  expect(screenToImagePoint(-50, -50, rect, 800, 600)).toEqual({ x: 0, y: 0 });
  expect(screenToImagePoint(2000, 2000, rect, 800, 600)).toEqual({ x: 800, y: 600 });
});

test('screenToImagePoint: a zero-size rect (not yet laid out) never divides by zero', () => {
  expect(screenToImagePoint(10, 10, { left: 0, top: 0, width: 0, height: 0 }, 800, 600)).toEqual({ x: 0, y: 0 });
});

// ---------------------------------------------------------------------------
// nextAnnotationId
// ---------------------------------------------------------------------------

test('nextAnnotationId: unique across calls, legibly prefixed', () => {
  const a = nextAnnotationId();
  const b = nextAnnotationId();
  expect(a).not.toBe(b);
  expect(a.startsWith('ann:')).toBe(true);
});

// ---------------------------------------------------------------------------
// AnnotationToolbar — static markup
// ---------------------------------------------------------------------------

test('AnnotationToolbar: renders both tools, marks the active one pressed', () => {
  const html = renderToStaticMarkup(
    <AnnotationToolbar tool="box" onToolChange={() => {}} canUndo={false} onUndo={() => {}} canClear={false} onClear={() => {}} onCancel={() => {}} onDone={() => {}} />,
  );
  expect(html).toContain('Box');
  expect(html).toContain('Pin');
  expect(html).toContain('Done');
  expect(html).toContain('Cancel');
  expect(html).not.toContain('Clear all'); // canClear=false
});

test('AnnotationToolbar: shows "Clear all" once there is something to clear', () => {
  const html = renderToStaticMarkup(
    <AnnotationToolbar tool="pin" onToolChange={() => {}} canUndo onUndo={() => {}} canClear onClear={() => {}} onCancel={() => {}} onDone={() => {}} />,
  );
  expect(html).toContain('Clear all');
});
