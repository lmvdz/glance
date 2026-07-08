import { expect, test } from 'bun:test';
import {
  attachedImagePromptRef,
  computeDownscaledDimensions,
  isRasterImageType,
  joinImagePromptRefs,
  MAX_IMAGE_DIMENSION,
  nextImageAttachmentId,
} from './imageAttachment';

// ---------------------------------------------------------------------------
// isRasterImageType
// ---------------------------------------------------------------------------

test('isRasterImageType: accepts common raster MIME types', () => {
  expect(isRasterImageType('image/png')).toBe(true);
  expect(isRasterImageType('image/jpeg')).toBe(true);
  expect(isRasterImageType('image/webp')).toBe(true);
});

test('isRasterImageType: rejects non-image types and SVG (XML, not raster pixels)', () => {
  expect(isRasterImageType('text/plain')).toBe(false);
  expect(isRasterImageType('application/pdf')).toBe(false);
  expect(isRasterImageType('image/svg+xml')).toBe(false);
});

// ---------------------------------------------------------------------------
// computeDownscaledDimensions
// ---------------------------------------------------------------------------

test('computeDownscaledDimensions: passes small images through unchanged', () => {
  expect(computeDownscaledDimensions(800, 600)).toEqual({ width: 800, height: 600 });
  expect(computeDownscaledDimensions(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION)).toEqual({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION });
});

test('computeDownscaledDimensions: caps the longer edge, preserves aspect ratio', () => {
  const result = computeDownscaledDimensions(4096, 2048);
  expect(result.width).toBe(MAX_IMAGE_DIMENSION);
  expect(result.height).toBe(1024);
});

test('computeDownscaledDimensions: caps a taller-than-wide image on its height', () => {
  const result = computeDownscaledDimensions(1000, 5000, 2000);
  expect(result.height).toBe(2000);
  expect(result.width).toBe(400);
});

test('computeDownscaledDimensions: degenerate (zero/negative) input yields zero, not NaN or a crash', () => {
  expect(computeDownscaledDimensions(0, 100)).toEqual({ width: 0, height: 0 });
  expect(computeDownscaledDimensions(-5, 100)).toEqual({ width: 0, height: 0 });
});

// ---------------------------------------------------------------------------
// Ids + prompt-ref fencing
// ---------------------------------------------------------------------------

test('nextImageAttachmentId: unique, prefixed for legibility in logs', () => {
  const a = nextImageAttachmentId();
  const b = nextImageAttachmentId();
  expect(a).not.toBe(b);
  expect(a.startsWith('img:')).toBe(true);
});

test('attachedImagePromptRef: fences the path as untrusted data, mirroring src/chat-attachment.ts', () => {
  const ref = attachedImagePromptRef('/state/chat-attachments/abc.png');
  expect(ref).toContain('untrusted data');
  expect(ref).toContain('/state/chat-attachments/abc.png');
  expect(ref).toMatch(/BEGIN attached image/);
  expect(ref).toMatch(/END attached image/);
});

test('joinImagePromptRefs: empty for no attachments, preserves attach order for multiple', () => {
  expect(joinImagePromptRefs([])).toBe('');
  const joined = joinImagePromptRefs(['/state/a.png', '/state/b.png']);
  expect(joined.indexOf('/state/a.png')).toBeLessThan(joined.indexOf('/state/b.png'));
});
