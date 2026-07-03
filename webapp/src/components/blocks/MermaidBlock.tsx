import { useEffect, useState } from 'react';
import type { BlockProps } from '../PlanBlocks';

// Unique-per-render id (mermaid requires a fresh id each render call).
let seq = 0;

function isDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

/**
 * Renders a ```mermaid fence as an actual diagram. Mermaid is large, so it is
 * lazy-imported (code-split) — it only loads when a plan doc actually contains a
 * mermaid block. Re-renders on light/dark toggle; falls back to the raw source on
 * a parse error rather than crashing the doc.
 */
export default function MermaidBlock({ body, blockId }: BlockProps) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function render() {
      if (typeof document === 'undefined') return;
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark() ? 'dark' : 'default' });
        const { svg } = await mermaid.render(`mmd-${blockId}-${seq++}`, body);
        if (!cancelled) {
          setSvg(svg);
          setError('');
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void render();
    // Redraw when the app toggles the `.dark` class so the diagram theme follows.
    const observer = new MutationObserver(() => void render());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [body, blockId]);

  if (error) {
    return (
      <div
        data-block-id={blockId}
        className="not-prose my-3 rounded-md border border-[var(--wf-border)] bg-[var(--wf-surface-raised)] p-3 text-sm"
      >
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--wf-warn, #f59e0b)' }}>
          Mermaid error
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-[var(--wf-text-muted)]">{error}{'\n\n'}{body}</pre>
      </div>
    );
  }

  return (
    <div
      data-block-id={blockId}
      className="not-prose my-3 flex justify-center overflow-x-auto rounded-md border border-[var(--wf-border)] bg-[var(--wf-surface-raised)] p-3"
      // svg is produced by mermaid with securityLevel:'strict' (sanitized).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
