import type { BlockProps } from '../PlanBlocks';

export default function CalloutBlock({ body, params }: BlockProps) {
  return (
    <div className="not-prose rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-500 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400">
      <div className="mb-2 font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300">[callout stub] {params.tone}</div>
      <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-gray-600 dark:text-gray-300">{body}</pre>
    </div>
  );
}
