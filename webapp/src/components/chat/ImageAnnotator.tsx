import React, { useRef, useState } from 'react';
import { Check, MapPin, Square, Undo2, X } from 'lucide-react';

/**
 * Annotation v1 (Feature 2 D2/D3, CANVAS-AND-PAGE-CHAT.md) — box + text-pin overlay on an
 * attached/captured image, flattened into the sent PNG before it uploads. Freehand is explicitly
 * LATER per the design doc; this file only ever builds axis-aligned boxes and point pins.
 *
 * Coordinates are always in the image's own NATURAL pixel space (post-downscale, so this is
 * exactly the grid the final PNG is drawn on) — never in on-screen display pixels, which vary with
 * viewport/zoom. The SVG overlay's `viewBox` is set to `0 0 width height`, so every draw op below
 * places shapes directly in that space; `screenToImagePoint` is the one conversion from a raw
 * pointer event's client coordinates into it.
 */

export interface AnnotationBox {
  id: string;
  kind: 'box';
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnnotationPin {
  id: string;
  kind: 'pin';
  x: number;
  y: number;
  text: string;
}

export type Annotation = AnnotationBox | AnnotationPin;

/** The one warm signal (D2's canvas-grammar convention, reused here for consistency): every
 *  annotation stroke/fill uses this single accent rather than a color picker — v1 doesn't need one,
 *  and a fixed color keeps the flattened image legible against anything underneath it. */
export const ANNOTATION_ACCENT = '#f59e0b'; // amber-500

let annotationSeq = 0;

/** Stable per-annotation id — same pattern as Composer's chip ids and imageAttachment.ts's
 *  attachment ids (timestamp + session counter + random, no crypto dependency needed client-side). */
export function nextAnnotationId(): string {
  annotationSeq += 1;
  return `ann:${Date.now()}:${annotationSeq}:${Math.random().toString(36).slice(2)}`;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Normalize two arbitrary drag corners (a mousedown point and the current pointer point, which
 *  may be dragged in ANY of the four directions) into a canonical top-left+size rect, clamped to
 *  the image's own bounds. Pure — this is the fiddly part of box-drawing worth testing directly. */
export function clampBox(x0: number, y0: number, x1: number, y1: number, maxWidth: number, maxHeight: number): Rect {
  const left = Math.max(0, Math.min(x0, x1));
  const top = Math.max(0, Math.min(y0, y1));
  const right = Math.min(maxWidth, Math.max(x0, x1));
  const bottom = Math.min(maxHeight, Math.max(y0, y1));
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

/** A box smaller than this in either dimension is almost certainly an accidental click, not a
 *  deliberate drag — discarded rather than committed as a zero-signal annotation. */
export const MIN_BOX_SIZE_PX = 4;

export function isTrivialBox(w: number, h: number, minSize = MIN_BOX_SIZE_PX): boolean {
  return w < minSize || h < minSize;
}

/** Convert a pointer event's viewport client coordinates into the image's natural pixel space,
 *  given the on-screen bounding rect of the (100%-scaled) overlay element. Pure — takes a plain
 *  `DOMRect`-shaped object rather than a live element so it's testable without a real DOM. */
export function screenToImagePoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  naturalWidth: number,
  naturalHeight: number,
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  const x = ((clientX - rect.left) / rect.width) * naturalWidth;
  const y = ((clientY - rect.top) / rect.height) * naturalHeight;
  return { x: Math.max(0, Math.min(naturalWidth, x)), y: Math.max(0, Math.min(naturalHeight, y)) };
}

/**
 * Draw `annotations` onto a fresh copy of `baseDataUrl` at its native `width`x`height` and return
 * the flattened PNG data URL. DOM/canvas-dependent (decodes an `<img>`, draws to `<canvas>`) — not
 * unit-tested directly (bun:test has no jsdom/canvas); every pure decision it depends on
 * (`clampBox`, `isTrivialBox`, `screenToImagePoint`) is tested above instead. Exercised live via
 * the scratch-daemon proof.
 */
export async function flattenAnnotations(baseDataUrl: string, width: number, height: number, annotations: Annotation[]): Promise<string> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('could not decode base image for flattening'));
    img.src = baseDataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(img, 0, 0, width, height);

  const shortEdge = Math.min(width, height);
  const lineWidth = Math.max(2, Math.round(shortEdge * 0.004));
  const pinRadius = Math.max(6, Math.round(shortEdge * 0.01));
  const fontSize = Math.max(12, Math.round(shortEdge * 0.02));

  for (const a of annotations) {
    if (a.kind === 'box') {
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = ANNOTATION_ACCENT;
      ctx.strokeRect(a.x, a.y, a.w, a.h);
      continue;
    }
    ctx.fillStyle = ANNOTATION_ACCENT;
    ctx.beginPath();
    ctx.arc(a.x, a.y, pinRadius, 0, Math.PI * 2);
    ctx.fill();
    const text = a.text.trim();
    if (!text) continue;
    ctx.font = `${fontSize}px sans-serif`;
    const paddingX = 6;
    const textWidth = ctx.measureText(text).width;
    const boxX = Math.min(width - textWidth - paddingX * 2, a.x + pinRadius + 4);
    const boxY = Math.max(0, a.y - fontSize - 4);
    ctx.fillStyle = 'rgba(17, 17, 17, 0.85)';
    ctx.fillRect(boxX, boxY, textWidth + paddingX * 2, fontSize + 8);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, boxX + paddingX, boxY + fontSize + 1);
  }
  return canvas.toDataURL('image/png');
}

type Tool = 'box' | 'pin';

/** Small toolbar row — pulled out as its own component so its static markup is directly
 *  unit-testable (bun:test has no jsdom to drive click interaction), same convention as
 *  Composer.tsx's `ComposerAttachmentChip`/`ComposerSendButton`. */
export const AnnotationToolbar = ({
  tool,
  onToolChange,
  canUndo,
  onUndo,
  canClear,
  onClear,
  onCancel,
  onDone,
}: {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  canUndo: boolean;
  onUndo: () => void;
  canClear: boolean;
  onClear: () => void;
  onCancel: () => void;
  onDone: () => void;
}) => (
  <div className="flex items-center justify-between gap-2 border-b border-gray-200 bg-white px-3 py-2 dark:border-gray-800 dark:bg-gray-950">
    <div className="flex items-center gap-1" role="group" aria-label="Annotation tool">
      <button
        type="button"
        aria-pressed={tool === 'box'}
        onClick={() => onToolChange('box')}
        className={`flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition-colors ${tool === 'box' ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}
      >
        <Square className="h-3.5 w-3.5" aria-hidden /> Box
      </button>
      <button
        type="button"
        aria-pressed={tool === 'pin'}
        onClick={() => onToolChange('pin')}
        className={`flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition-colors ${tool === 'pin' ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}
      >
        <MapPin className="h-3.5 w-3.5" aria-hidden /> Pin
      </button>
      <button
        type="button"
        aria-label="Undo last annotation"
        disabled={!canUndo}
        onClick={onUndo}
        className="flex h-8 w-8 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-gray-800"
      >
        <Undo2 className="h-3.5 w-3.5" aria-hidden />
      </button>
      {canClear && (
        <button
          type="button"
          onClick={onClear}
          className="text-[11px] font-medium text-gray-500 hover:text-gray-800 hover:underline dark:text-gray-400 dark:hover:text-gray-200"
        >
          Clear all
        </button>
      )}
    </div>
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="flex h-8 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
      >
        <X className="h-3.5 w-3.5" aria-hidden /> Cancel
      </button>
      <button
        type="button"
        onClick={onDone}
        className="flex h-8 items-center gap-1 rounded-full bg-gray-900 px-3 text-[11px] font-semibold text-white hover:bg-black dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-white"
      >
        <Check className="h-3.5 w-3.5" aria-hidden /> Done
      </button>
    </div>
  </div>
);

export interface ImageAnnotatorProps {
  image: { dataUrl: string; width: number; height: number };
  initialAnnotations?: Annotation[];
  /** Flattening is async (decodes+draws a fresh `<canvas>`) — the caller awaits the result before
   *  replacing its stored attachment. */
  onDone: (flattenedDataUrl: string, annotations: Annotation[]) => void;
  onCancel: () => void;
}

/**
 * Full-viewport modal: toolbar + the image with its SVG annotation overlay. Box tool drags a
 * rectangle; pin tool places a point and opens an inline text field for its label (empty text on
 * blur discards the pin — an unlabeled dot carries no signal). "Done" flattens every committed
 * annotation into the image and hands the result back; "Cancel" discards the whole session.
 */
export const ImageAnnotator = ({ image, initialAnnotations, onDone, onCancel }: ImageAnnotatorProps) => {
  const [tool, setTool] = useState<Tool>('box');
  const [annotations, setAnnotations] = useState<Annotation[]>(initialAnnotations ?? []);
  const [draftBox, setDraftBox] = useState<Rect | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [pinDraftText, setPinDraftText] = useState('');
  const [isFlattening, setIsFlattening] = useState(false);
  const overlayRef = useRef<SVGSVGElement>(null);

  const toImagePoint = (clientX: number, clientY: number) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return screenToImagePoint(clientX, clientY, rect, image.width, image.height);
  };

  const handlePointerDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (editingPinId) return; // finish labeling the current pin before starting anything new
    const point = toImagePoint(e.clientX, e.clientY);
    if (tool === 'pin') {
      const id = nextAnnotationId();
      setAnnotations((prev) => [...prev, { id, kind: 'pin', x: point.x, y: point.y, text: '' }]);
      setEditingPinId(id);
      setPinDraftText('');
      return;
    }
    dragStartRef.current = point;
    setDraftBox({ x: point.x, y: point.y, w: 0, h: 0 });
  };

  const handlePointerMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragStartRef.current) return;
    const point = toImagePoint(e.clientX, e.clientY);
    const start = dragStartRef.current;
    setDraftBox(clampBox(start.x, start.y, point.x, point.y, image.width, image.height));
  };

  const commitDraftBox = () => {
    dragStartRef.current = null;
    setDraftBox((current) => {
      if (current && !isTrivialBox(current.w, current.h)) {
        setAnnotations((prev) => [...prev, { id: nextAnnotationId(), kind: 'box', ...current }]);
      }
      return null;
    });
  };

  const commitPinText = () => {
    const id = editingPinId;
    setEditingPinId(null);
    if (!id) return;
    const text = pinDraftText.trim();
    setAnnotations((prev) => (text ? prev.map((a) => (a.id === id ? { ...a, text } : a)) : prev.filter((a) => a.id !== id)));
    setPinDraftText('');
  };

  const handleUndo = () => setAnnotations((prev) => prev.slice(0, -1));
  const handleClear = () => setAnnotations([]);

  const handleDone = async () => {
    setIsFlattening(true);
    try {
      const flattened = annotations.length > 0 ? await flattenAnnotations(image.dataUrl, image.width, image.height, annotations) : image.dataUrl;
      onDone(flattened, annotations);
    } finally {
      setIsFlattening(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Annotate image">
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-gray-950">
        <AnnotationToolbar
          tool={tool}
          onToolChange={setTool}
          canUndo={annotations.length > 0}
          onUndo={handleUndo}
          canClear={annotations.length > 0}
          onClear={handleClear}
          onCancel={onCancel}
          onDone={() => void handleDone()}
        />
        <div className="relative flex-1 overflow-auto bg-gray-100 p-3 dark:bg-gray-900">
          <div className="relative mx-auto" style={{ maxWidth: '100%' }}>
            <img src={image.dataUrl} alt="Attachment to annotate" className="block w-full select-none" draggable={false} />
            <svg
              ref={overlayRef}
              viewBox={`0 0 ${image.width} ${image.height}`}
              preserveAspectRatio="none"
              className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
              onMouseDown={handlePointerDown}
              onMouseMove={handlePointerMove}
              onMouseUp={commitDraftBox}
              onMouseLeave={commitDraftBox}
            >
              {annotations.map((a) =>
                a.kind === 'box' ? (
                  <rect key={a.id} x={a.x} y={a.y} width={a.w} height={a.h} fill="none" stroke={ANNOTATION_ACCENT} strokeWidth={Math.max(2, image.width * 0.004)} />
                ) : (
                  <circle key={a.id} cx={a.x} cy={a.y} r={Math.max(6, image.width * 0.01)} fill={ANNOTATION_ACCENT} />
                ),
              )}
              {draftBox && <rect x={draftBox.x} y={draftBox.y} width={draftBox.w} height={draftBox.h} fill="none" stroke={ANNOTATION_ACCENT} strokeWidth={Math.max(2, image.width * 0.004)} strokeDasharray="6 4" />}
            </svg>
            {editingPinId &&
              (() => {
                const pin = annotations.find((a) => a.id === editingPinId);
                if (!pin) return null;
                const leftPct = (pin.x / image.width) * 100;
                const topPct = (pin.y / image.height) * 100;
                return (
                  <div className="absolute z-10 -translate-y-full" style={{ left: `${leftPct}%`, top: `${topPct}%` }}>
                    <input
                      autoFocus
                      value={pinDraftText}
                      onChange={(e) => setPinDraftText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitPinText();
                        if (e.key === 'Escape') {
                          setEditingPinId(null);
                          setAnnotations((prev) => prev.filter((a) => a.id !== editingPinId));
                        }
                      }}
                      onBlur={commitPinText}
                      placeholder="Label this pin…"
                      aria-label="Pin label"
                      className="w-40 rounded-md border border-amber-400 bg-white px-2 py-1 text-xs shadow-lg outline-none dark:bg-gray-900 dark:text-gray-100"
                    />
                  </div>
                );
              })()}
          </div>
        </div>
        <div className="border-t border-gray-200 px-3 py-1.5 text-[11px] text-gray-500 dark:border-gray-800 dark:text-gray-500">
          {isFlattening ? 'Flattening annotations…' : `${annotations.length} annotation${annotations.length === 1 ? '' : 's'} — box to mark an area, pin to leave a note`}
        </div>
      </div>
    </div>
  );
};
