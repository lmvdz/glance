import React, { useState } from 'react';
import { Loader2, Rocket, X } from 'lucide-react';
import { attachmentIdFromPath, buildSpawnPrompt, SPAWN_CONTRACT_LINE } from '../../lib/spawnProposal';

/**
 * Feature 2 D3 — THE CONFIRMATION GATE. This is the non-negotiable runaway-guard: nothing this
 * feature does ever spawns a real unit without a human explicitly hitting the one primary button
 * below, having seen the exact prompt (editable), the annotated capture, the serialized page
 * context, the target repo, and the standard draft-PR/verify contract. There is no auto-confirm,
 * no timer, no "confirm all" — one sheet, one unit, one explicit click (D5: "Injected 'spawn 100
 * units' cannot self-execute — every spawn is human-gated").
 */
export interface SpawnConfirmSheetProps {
  promptSeed: string;
  imagePaths: string[];
  pageContextBlock: string;
  repoLabel: string;
  onCancel: () => void;
  /** Receives the fully-assembled prompt (edited text + repo line + fenced images + page context +
   *  contract line) — the caller POSTs it to `/api/spawn` and re-throws on failure, which this
   *  sheet surfaces inline and keeps itself open for, so a rejected spawn (e.g. the WIP cap) never
   *  silently discards the operator's edits. */
  onConfirm: (finalPrompt: string) => Promise<void>;
}

export const SpawnConfirmSheet: React.FC<SpawnConfirmSheetProps> = ({ promptSeed, imagePaths, pageContextBlock, repoLabel, onCancel, onConfirm }) => {
  const [prompt, setPrompt] = useState(promptSeed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(buildSpawnPrompt({ editedPrompt: prompt, imagePaths, pageContextBlock, repoLabel }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Confirm spawning a unit" className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-800 dark:bg-gray-950">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Spawn a unit to build this</h2>
          <button type="button" onClick={onCancel} aria-label="Cancel" className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {imagePaths.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Annotated capture</div>
              <div className="flex flex-wrap gap-2" aria-label="Annotated capture thumbnails">
                {imagePaths.map((p) => {
                  const id = attachmentIdFromPath(p);
                  return id ? (
                    <img
                      key={p}
                      src={`/api/chat-attachments/${id}`}
                      alt="Annotated capture attached to this turn"
                      className="h-20 w-20 rounded-lg border border-gray-200 object-cover dark:border-gray-700"
                    />
                  ) : null;
                })}
              </div>
            </div>
          )}

          <div>
            <label htmlFor="spawn-confirm-prompt" className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Prompt (editable)
            </label>
            <textarea
              id="spawn-confirm-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              className="w-full rounded-lg border border-gray-200 bg-gray-50 p-2 text-[12px] leading-relaxed text-gray-800 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
            />
          </div>

          <div className="rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Target repo</div>
            <div className="font-mono text-[12px] text-gray-700 dark:text-gray-300">{repoLabel}</div>
          </div>

          {pageContextBlock && (
            <details className="rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900">
              <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Serialized page context
              </summary>
              <pre className="mt-1 whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-gray-600 dark:text-gray-400">{pageContextBlock}</pre>
            </details>
          )}

          <div className="rounded-lg border border-dashed border-gray-300 p-2 text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
            {SPAWN_CONTRACT_LINE}
          </div>

          {error && (
            <p role="alert" className="text-[11px] text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-gray-200 px-4 py-3 dark:border-gray-800">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-full border border-gray-200 px-3 py-1.5 text-[12px] font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={busy || !prompt.trim()}
            className="flex items-center gap-1.5 rounded-full bg-amber-600 px-3.5 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-amber-500 dark:text-gray-950 dark:hover:bg-amber-400"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Rocket className="h-3.5 w-3.5" aria-hidden />}
            Confirm — spawn the unit
          </button>
        </div>
      </div>
    </div>
  );
};
