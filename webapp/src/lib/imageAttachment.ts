/**
 * Images into the agent conversation — paste/drop/capture/annotate (Feature 2 D2,
 * plans/orchestration/CANVAS-AND-PAGE-CHAT.md). Split from chat/Composer.tsx the same way
 * Composer.tsx's own pure helpers are: framework/DOM-free math here (unit-tested directly, no
 * jsdom), thin DOM-touching wrappers alongside it for the component to call.
 *
 * Trust boundaries (D5): image/* only, client-downscaled to ≤MAX_IMAGE_DIMENSION px and re-encoded
 * fresh through a `<canvas>` — which strips EXIF as a side effect of rasterizing to a brand-new PNG
 * (no metadata chunk survives a canvas round trip) — then re-checked server-side against
 * `MAX_UPLOAD_BYTES` (mirrors src/chat-attachment.ts's own cap; a modified client can't smuggle a
 * bigger blob past this file's downscale).
 *
 * Transport decision (investigated live, D2/D5): neither `/api/console`'s body schema nor the
 * `{type:"prompt"}` command carry an image channel. An annotated PNG is uploaded via
 * `uploadChatAttachment` to `POST /api/chat-attachments` (persisted server-side under
 * `<stateDir>/chat-attachments/<uuid>.png`, src/chat-attachment.ts) and referenced BY PATH in the
 * outgoing prompt text — `attachedImagePromptRef` mirrors that file's `chatAttachmentPromptRef`
 * fenced-untrusted-data wording exactly, so the convention reads identically whichever side wrote
 * it (client and server are separate bundles; there is nothing to import across that boundary).
 */
import { apiFetch } from './api';

/** Client downscale ceiling (D5) — matches src/chat-attachment.ts's re-enforced server-side cap. */
export const MAX_IMAGE_DIMENSION = 2048;
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // 4MB

/** True for any clipboard/drag item whose MIME type is a raster image the browser can decode into
 *  an `<img>`/`ImageBitmap` — `image/svg+xml` is excluded (it's XML, not raster pixels, and a
 *  canvas re-encode of it wouldn't strip anything meaningful; out of v1 scope). */
export function isRasterImageType(mimeType: string): boolean {
  return mimeType.startsWith('image/') && mimeType !== 'image/svg+xml';
}

/** Preserve-aspect-ratio downscale target: passes small images through untouched, caps the longer
 *  edge at `maxDim` otherwise. Pure — this is the one piece of the downscale pipeline worth testing
 *  without a real `<canvas>`. */
export function computeDownscaledDimensions(width: number, height: number, maxDim = MAX_IMAGE_DIMENSION): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const longest = Math.max(width, height);
  if (longest <= maxDim) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxDim / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

let attachmentSeq = 0;

/** Stable per-attachment id — mirrors Composer's `chip:${Date.now()}:${random}` pattern for the
 *  same reason (never collides within a session, no crypto dependency needed client-side). */
export function nextImageAttachmentId(): string {
  attachmentSeq += 1;
  return `img:${Date.now()}:${attachmentSeq}:${Math.random().toString(36).slice(2)}`;
}

/** The fenced-untrusted-data reference folded into the outgoing prompt text — deliberately mirrors
 *  src/chat-attachment.ts's `chatAttachmentPromptRef` wording exactly. */
export function attachedImagePromptRef(attachmentPath: string): string {
  return `===== BEGIN attached image (untrusted data) =====\nImage artifact saved at: ${attachmentPath}\n===== END attached image =====`;
}

/** Join every uploaded attachment's fenced reference, in attach order — `''` when there are none,
 *  so the caller can always do `text + refs` without a conditional. */
export function joinImagePromptRefs(paths: string[]): string {
  return paths.map(attachedImagePromptRef).join('\n\n');
}

export interface DownscaledImage {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Decode `source` (a pasted/dropped File/Blob, or a data URL) into a fresh `<canvas>` at the
 * downscaled dimensions, and re-encode as PNG. The canvas round trip is what strips EXIF (no
 * metadata chunk survives re-rasterization) and is what the module doc comment promises — DOM-
 * dependent, so not unit-tested directly; `computeDownscaledDimensions` above carries the tested
 * math this function delegates to.
 */
export async function downscaleToPng(source: Blob | string): Promise<DownscaledImage> {
  // A pasted/dropped Blob is read as a data: URL (FileReader), never a blob: object URL — this
  // app's CSP is `img-src 'self' data: https: http:` (no `blob:`), so `URL.createObjectURL` would
  // silently fail the `<img>` decode (found live: a real paste 404'd through `onerror` with
  // "could not decode image" until this was traced to the CSP, not a codec issue).
  const srcUrl = typeof source === 'string' ? source : await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('could not read image file'));
    reader.readAsDataURL(source);
  });
  const img = new Image();
  const loaded = await new Promise<HTMLImageElement>((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = srcUrl;
  });
  const { width, height } = computeDownscaledDimensions(loaded.naturalWidth, loaded.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(loaded, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL('image/png'), width, height };
}

/**
 * "Capture view" — a client DOM snapshot of `el` (MainContent, `#omp-main-content`) via
 * `html-to-image`'s canvas-serialization approach. Captures live rendered state (including canvas/
 * SVG children) without a server round trip. Chosen over the zero-dependency alternative
 * (`getDisplayMedia`, the Screen Capture API) because that path requires a per-capture OS/browser
 * permission prompt and lets the operator select an arbitrary window/tab/screen rather than
 * exactly the app's own content pane — worse one-click UX for a feature meant to be a lightweight
 * "grab what I'm looking at" affordance. `html-to-image` is a genuinely small, zero-dependency
 * package (0 transitive deps, ~30KB unminified) next to mermaid/recharts already in this bundle, so
 * the bundle-impact tradeoff clearly favors bundling it over the honest-fallback (paste/drop only)
 * path the spec allowed for.
 */
export async function captureElementToPng(el: HTMLElement): Promise<DownscaledImage> {
  const { toPng } = await import('html-to-image');
  const rawDataUrl = await toPng(el, { pixelRatio: 1 });
  return downscaleToPng(rawDataUrl);
}

export interface UploadedChatAttachment {
  id: string;
  path: string;
}

/** POST the final (annotated-or-not) PNG data URL to the daemon; returns the server-assigned id +
 *  absolute on-disk path that gets fenced into the outgoing prompt. Throws the server's bounded
 *  error text on a non-2xx response (matches `apiJson`'s convention elsewhere in this codebase). */
export async function uploadChatAttachment(dataUrl: string): Promise<UploadedChatAttachment> {
  const response = await apiFetch('/api/chat-attachments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<UploadedChatAttachment>;
}
