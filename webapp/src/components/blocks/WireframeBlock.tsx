import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import rough from 'roughjs';
import { sanitizeHtml as sanitize, sanitizeStyle } from '../../lib/sanitize';
import type { BlockProps } from '../PlanBlocks';

const ICON_PATHS: Record<string, string> = {
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  bell: '<path d="M10.27 21a2 2 0 0 0 3.46 0"/><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  'dots-horizontal': '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  'dots-vertical': '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
};

const ICON_ALIASES: Record<string, string> = {
  chevronleft: 'chevron-left',
  chevronright: 'chevron-right',
  chevronup: 'chevron-up',
  chevrondown: 'chevron-down',
  arrowleft: 'arrow-left',
  arrowright: 'arrow-right',
  arrowup: 'arrow-up',
  arrowdown: 'arrow-down',
  dots: 'dots-horizontal',
  ellipsis: 'dots-horizontal',
  'more-horizontal': 'dots-horizontal',
  'more-vertical': 'dots-vertical',
};

const SURFACE_PRESETS = {
  browser: { width: '720px', minHeight: '360px', aspectRatio: '16 / 10' },
  desktop: { width: '840px', minHeight: '420px', aspectRatio: '16 / 9' },
  mobile: { width: '360px', minHeight: '560px', aspectRatio: '9 / 16' },
  popover: { width: '360px', minHeight: '220px', aspectRatio: '4 / 3' },
  panel: { width: '520px', minHeight: '280px', aspectRatio: '4 / 3' },
} as const;

type SurfacePreset = keyof typeof SURFACE_PRESETS;

const ICON_MARKER = /<[^>]*\sdata-icon\s*=\s*(["'])([^"']+)\1[^>]*>(?:\s*<\/[^>]+>)?/gi;

const WIREFRAME_STYLES = `
.wf-block-host {
  margin: 1rem auto;
  max-width: min(100%, var(--wf-frame-width));
}

.wf-frame-shell {
  --wf-line: var(--wf-border-strong);
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: var(--wf-frame-min-height);
  aspect-ratio: var(--wf-frame-aspect);
  overflow: hidden;
  border: 1px solid var(--wf-border);
  border-radius: 1rem;
  background: var(--wf-surface);
  color: var(--wf-text);
  box-shadow: var(--wf-shadow-soft);
}

.wf-frame-shell.wf-diagram-frame {
  border-radius: 0.875rem;
}

.wf-frame-shell.wf-rough-fallback {
  border-color: var(--wf-line);
}

.wf-browser-bar {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  border-bottom: 1px solid var(--wf-border);
  background: var(--wf-surface-raised);
  padding: 0.625rem 0.875rem;
}

.wf-browser-dots {
  display: flex;
  gap: 0.375rem;
}

.wf-browser-dot {
  width: 0.625rem;
  height: 0.625rem;
  border-radius: 999px;
  background: var(--wf-text-subtle);
}

.wf-browser-dot:nth-child(1) { background: var(--wf-danger); }
.wf-browser-dot:nth-child(2) { background: var(--wf-warning); }
.wf-browser-dot:nth-child(3) { background: var(--wf-success); }

.wf-browser-address {
  min-width: 0;
  flex: 1;
  border: 1px solid var(--wf-border);
  border-radius: 999px;
  background: var(--wf-paper-muted);
  padding: 0.25rem 0.75rem;
  color: var(--wf-text-subtle);
  font: 600 0.72rem/1.2 var(--font-mono);
  text-align: center;
}

.wf-surface.not-prose {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 100%;
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--wf-surface);
  color: var(--wf-text);
  border-color: var(--wf-border);
  font-size: 0.92rem;
  line-height: 1.45;
}

.wf-frame-shell.wf-wireframe-frame .wf-surface.not-prose {
  padding: 1rem;
}

.wf-frame-shell.wf-diagram-frame .wf-surface.not-prose {
  padding: 1.25rem;
  background:
    radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--wf-border) 72%, transparent) 1px, transparent 0) 0 0 / 18px 18px,
    var(--wf-paper);
}

.wf-rough-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.wf-content,
.wf-content * {
  box-sizing: border-box;
}

.wf-content > * {
  max-width: 100%;
}

.wf-content :where(h1, h2, h3, h4, p, ul, ol) {
  margin: 0;
}

.wf-content :where(h1, h2, h3, h4) {
  color: var(--wf-text);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.wf-content p,
.wf-content li {
  color: var(--wf-text-muted);
}

.wf-content a {
  color: var(--wf-accent);
  text-decoration: underline;
  text-underline-offset: 0.18em;
}

.wf-content .wf-stack {
  display: flex;
  flex-direction: column;
}

.wf-content .wf-row {
  display: flex;
  flex-wrap: wrap;
}

.wf-content .wf-grid {
  display: grid;
  gap: 1rem;
}

.wf-content .wf-card,
.wf-content .diagram-card,
.wf-content .diagram-node {
  border: 1px solid var(--wf-border);
  border-radius: 0.75rem;
  background: var(--wf-surface-raised);
  color: var(--wf-text);
  box-shadow: 0 1px 0 color-mix(in srgb, var(--wf-border) 60%, transparent);
}

.wf-content .wf-card {
  padding: 0.875rem;
}

.wf-content .wf-pill {
  display: inline-flex;
  min-height: 1.5rem;
  align-items: center;
  border: 1px solid color-mix(in srgb, var(--wf-accent) 35%, var(--wf-border));
  border-radius: 999px;
  background: var(--wf-accent-soft);
  padding: 0.125rem 0.55rem;
  color: var(--wf-accent);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.wf-content .wf-muted {
  color: var(--wf-text-muted);
}

.wf-content .wf-subtle {
  color: var(--wf-text-subtle);
}

.wf-content :where(button, .button, .primary, .secondary) {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  border: 1px solid var(--wf-border-strong);
  border-radius: 0.65rem;
  background: var(--wf-surface);
  padding: 0.5rem 0.875rem;
  color: var(--wf-text);
  font: inherit;
  font-weight: 700;
}

.wf-content :where(button, .button, .primary, .secondary):focus-visible {
  outline: 2px solid var(--wf-accent);
  outline-offset: 2px;
}

.wf-content :where(button.primary, .button.primary, .primary) {
  border-color: var(--wf-accent);
  background: var(--wf-accent);
  color: var(--wf-paper);
}

.wf-content :where(button.secondary, .button.secondary, .secondary) {
  background: var(--wf-paper-muted);
  color: var(--wf-text);
}

.wf-content .wf-icon {
  display: inline-block;
  width: 1em;
  height: 1em;
  margin-right: 0.35em;
  vertical-align: -0.16em;
  color: currentColor;
}

.wf-content .wf-icon-placeholder {
  display: inline-flex;
  min-width: 1.25em;
  min-height: 1.25em;
  align-items: center;
  justify-content: center;
  margin-right: 0.35em;
  border: 1px dashed var(--wf-border-strong);
  border-radius: 0.25rem;
  color: var(--wf-danger);
  font: 700 0.72em/1 var(--font-mono);
  vertical-align: 0.08em;
}

.wf-content .diagram-panel {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  border: 1px solid var(--wf-border-strong);
  border-radius: 0.875rem;
  background: color-mix(in srgb, var(--wf-surface) 82%, transparent);
  padding: 1rem;
}

.wf-content .diagram-card,
.wf-content .diagram-node {
  padding: 0.75rem 0.875rem;
}

.wf-content .diagram-card {
  border-style: dashed;
}

.wf-content .diagram-node {
  align-self: center;
  border-radius: 999px;
  background: var(--wf-accent-soft);
  color: var(--wf-accent);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  font-weight: 700;
}
`;

function normalizeIconName(name: string): string {
  const normalized = name.trim().toLowerCase();
  return ICON_ALIASES[normalized] ?? normalized;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function iconSvg(name: string): string {
  const iconName = normalizeIconName(name);
  const paths = ICON_PATHS[iconName];
  if (!paths) {
    return `<span class="wf-icon-placeholder" role="img" aria-label="Unknown icon ${escapeHtml(name)}">[?]</span>`;
  }

  return `<svg class="wf-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

function replaceIconMarkers(html: string): string {
  return html.replace(ICON_MARKER, (_match, _quote, name: string) => iconSvg(name));
}

function fallbackSanitize(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+style\s*=\s*(["'])(.*?)\1/gi, (_match, _quote, value: string) => {
      const safeStyle = sanitizeStyle(value);
      return safeStyle ? ` style="${escapeHtml(safeStyle)}"` : '';
    })
    .replace(/\s+style\s*=\s*[^\s>]+/gi, '');
}

function sanitizeWireframeHtml(html: string): string {
  try {
    return sanitize(html);
  } catch {
    return fallbackSanitize(html);
  }
}

function surfacePreset(value: string | undefined, isDiagram: boolean): SurfacePreset {
  if (value && value in SURFACE_PRESETS) {
    return value as SurfacePreset;
  }
  return isDiagram ? 'panel' : 'browser';
}

function surfaceStyle(surface: SurfacePreset): CSSProperties {
  const preset = SURFACE_PRESETS[surface];
  return {
    '--wf-frame-width': preset.width,
    '--wf-frame-min-height': preset.minHeight,
    '--wf-frame-aspect': preset.aspectRatio,
  } as CSSProperties;
}

function BrowserChrome() {
  return (
    <div className="wf-browser-bar" aria-hidden="true">
      <div className="wf-browser-dots">
        <span className="wf-browser-dot" />
        <span className="wf-browser-dot" />
        <span className="wf-browser-dot" />
      </div>
      <div className="wf-browser-address">wireframe.local</div>
    </div>
  );
}

export default function WireframeBlock({ body, params, blockId }: BlockProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [roughFallback, setRoughFallback] = useState(false);
  const isDiagram = params.kind === 'diagram';
  const surface = surfacePreset(params.surface, isDiagram);
  const sanitizedBody = useMemo(() => sanitizeWireframeHtml(replaceIconMarkers(body)), [body]);

  useEffect(() => {
    const frame = frameRef.current;
    const svg = svgRef.current;
    if (
      !frame ||
      !svg ||
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      typeof SVGElement === 'undefined'
    ) {
      setRoughFallback(true);
      return;
    }

    let active = false;
    let frameHandle = 0;
    let intersectionObserver: IntersectionObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;

    const clearSvg = () => {
      while (svg.firstChild) {
        svg.removeChild(svg.firstChild);
      }
    };

    const draw = () => {
      if (!active) {
        return;
      }

      if (frameHandle) {
        window.cancelAnimationFrame(frameHandle);
      }

      frameHandle = window.requestAnimationFrame(() => {
        try {
          const width = frame.clientWidth;
          const height = frame.clientHeight;
          if (width <= 0 || height <= 0) {
            return;
          }

          clearSvg();
          svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
          svg.setAttribute('width', String(width));
          svg.setAttribute('height', String(height));

          const computed = window.getComputedStyle(frame);
          const stroke =
            computed.getPropertyValue('--wf-line').trim() ||
            computed.getPropertyValue('--wf-border-strong').trim() ||
            computed.getPropertyValue('--wf-border').trim() ||
            'currentColor';
          const renderer = rough.svg(svg);
          const node = renderer.rectangle(2, 2, Math.max(0, width - 4), Math.max(0, height - 4), {
            bowing: 1.1,
            fill: 'transparent',
            roughness: 1.25,
            seed: 8,
            stroke,
            strokeWidth: 1.4,
          });
          svg.appendChild(node);
          setRoughFallback(false);
        } catch {
          clearSvg();
          setRoughFallback(true);
        }
      });
    };

    const activate = () => {
      active = true;
      draw();
    };

    if ('IntersectionObserver' in window) {
      intersectionObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          activate();
          intersectionObserver?.disconnect();
          intersectionObserver = null;
        }
      });
      intersectionObserver.observe(frame);
    } else {
      activate();
    }

    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(draw);
      resizeObserver.observe(frame);
    }

    if ('MutationObserver' in window) {
      themeObserver = new MutationObserver(draw);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    }

    return () => {
      active = false;
      if (frameHandle) {
        window.cancelAnimationFrame(frameHandle);
      }
      intersectionObserver?.disconnect();
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
    };
  }, [sanitizedBody, surface]);

  return (
    <section
      className="wf-block-host wf-surface-scoped"
      data-block-id={blockId}
      data-surface={surface}
      style={surfaceStyle(surface)}
    >
      <style>{WIREFRAME_STYLES}</style>
      <div
        ref={frameRef}
        className={`wf-frame-shell ${isDiagram ? 'wf-diagram-frame' : 'wf-wireframe-frame'} ${roughFallback ? 'wf-rough-fallback' : ''}`}
      >
        {!isDiagram && surface === 'browser' ? <BrowserChrome /> : null}
        <div
          className={`wf-surface not-prose wf-content ${isDiagram ? 'wf-diagram-content' : 'wf-wireframe-content'}`}
          dangerouslySetInnerHTML={{ __html: sanitizedBody }}
        />
        <svg ref={svgRef} className="wf-rough-overlay" aria-hidden="true" focusable="false" />
      </div>
    </section>
  );
}
