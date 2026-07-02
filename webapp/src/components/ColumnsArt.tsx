/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

// The dot-rendered classical columns on the login's right panel. Three fluted shafts that dissolve into
// scattered dots at the capitals and erode with height — drawn to a canvas (crisp at any DPR), purely
// decorative. Deterministic-ish per mount; regenerates on resize.
export const ColumnsArt = () => {
  const ref = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (w === 0 || h === 0) return;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const dot = (x: number, y: number, r: number, a: number) => {
        ctx.fillStyle = `rgba(190,192,196,${a})`;
        ctx.fillRect(x, y, r, r);
      };

      // Three columns spread across the panel, each a bit shorter/eroded than a perfect column.
      const cols = 3;
      const gap = w / (cols + 1);
      const top = h * 0.08;
      const baseY = h * 0.94;
      const shaftW = Math.min(gap * 0.42, 120);
      const flutes = 9;
      const stepY = 5;

      for (let c = 0; c < cols; c++) {
        const cx = gap * (c + 1);
        const capY = top + h * 0.14; // shaft starts below the capital scatter
        const jitterSeed = c * 1.7;

        // Capital: a wide scatter of dots dissolving upward (Corinthian-ish foliage feel).
        const capCount = 260;
        for (let i = 0; i < capCount; i++) {
          const t = Math.random();
          const spread = shaftW * (0.7 + t * 0.9);
          const x = cx + (Math.random() - 0.5) * spread;
          const y = top + Math.random() * (capY - top) * 1.05;
          // Sparser toward the very top edge.
          if (Math.random() < (top === y ? 0 : (y - top) / (capY - top)) * 0.15) continue;
          dot(x, y, Math.random() < 0.2 ? 2 : 1, 0.35 + Math.random() * 0.5);
        }

        // Shaft: vertical fluting, denser and cleaner than the capital, eroding with height.
        for (let f = 0; f < flutes; f++) {
          const fx = cx - shaftW / 2 + (shaftW / (flutes - 1)) * f;
          for (let y = capY; y < baseY; y += stepY) {
            const heightFrac = (y - capY) / (baseY - capY); // 0 at top of shaft, 1 at base
            const erosion = 0.22 * (1 - heightFrac); // top erodes more
            if (Math.random() < erosion) continue;
            const jx = fx + Math.sin((y + jitterSeed * 40) * 0.05) * 0.6 + (Math.random() - 0.5) * 1.2;
            const edge = f === 0 || f === flutes - 1;
            dot(jx, y, 1, edge ? 0.4 + Math.random() * 0.3 : 0.5 + Math.random() * 0.45);
          }
        }

        // Base: a denser block anchoring the column.
        for (let i = 0; i < 220; i++) {
          const x = cx + (Math.random() - 0.5) * shaftW * 1.25;
          const y = baseY + Math.random() * (h - baseY) * 0.9;
          dot(x, y, Math.random() < 0.15 ? 2 : 1, 0.4 + Math.random() * 0.45);
        }

        // Stray fallen dots between/around columns (rubble).
        for (let i = 0; i < 80; i++) {
          const x = cx + (Math.random() - 0.5) * gap * 1.1;
          const y = capY + Math.random() * (baseY - capY);
          if (Math.random() < 0.85) continue;
          dot(x, y, 1, 0.15 + Math.random() * 0.25);
        }
      }
    };

    draw();
    const ro = new ResizeObserver(() => draw());
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  return <canvas ref={ref} aria-hidden className="absolute inset-0 h-full w-full" />;
};
