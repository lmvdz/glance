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
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-ink-border bg-white shadow-xl border-ink-border bg-ink">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-ink-border px-4 py-3 border-ink-border">
          <h2 className="text-sm font-semibold text-ink-text">Spawn a unit to build this</h2>
          <button type="button" onClick={onCancel} aria-label="Cancel" className="rounded-md p-1 text-ink-text-subtle hover:bg-ink-surface">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {imagePaths.length > 0 && (
            <div>
              <div className="mb-1 text-caption font-medium uppercase tracking-wide text-ink-text-muted">Annotated capture</div>
              <div className="flex flex-wrap gap-2" aria-label="Annotated capture thumbnails">
                {imagePaths.map((p) => {
                  const id = attachmentIdFromPath(p);
                  return id ? (
                    <img
                      key={p}
                      src={`/api/chat-attachments/${id}`}
                      alt="Annotated capture attached to this turn"
                      className="h-20 w-20 rounded-lg border border-ink-border object-cover border-ink-border-2"
                    />
                  ) : null;
                })}
              </div>
            </div>
          )}

          <div>
            <label htmlFor="spawn-confirm-prompt" className="mb-1 block text-caption font-medium uppercase tracking-wide text-ink-text-muted">
              Prompt (editable)
            </label>
            <textarea
              id="spawn-confirm-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              className="w-full rounded-lg border border-ink-border-2 bg-panel p-2 text-caption leading-relaxed text-ink-text-body outline-none focus-visible:ring-2 focus-visible:ring-ember"
            />
          </div>

          <div className="rounded-lg border border-ink-border-2 bg-panel p-2">
            <div className="mb-1 font-mono text-caption font-medium uppercase tracking-[0.16em] text-ink-text-muted">Target repo</div>
            <div className="font-mono text-caption text-ink-text-label">{repoLabel}</div>
          </div>

          {pageContextBlock && (
            <details className="rounded-lg border border-ink-border bg-ink p-2 border-ink-border-2 bg-panel">
              <summary className="cursor-pointer text-caption font-medium uppercase tracking-wide text-ink-text-muted">
                Serialized page context
              </summary>
              <pre className="mt-1 whitespace-pre-wrap font-mono text-caption leading-relaxed text-ink-text-label text-ink-text-subtle">{pageContextBlock}</pre>
            </details>
          )}

          <div className="rounded-lg border border-dashed border-ink-border-2 p-2 text-caption text-ink-text0 border-ink-border-2 text-ink-text-subtle">
            {SPAWN_CONTRACT_LINE}
          </div>

          {error && (
            <p role="alert" className="text-caption text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-ink-border px-4 py-3 border-ink-border">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-full border border-ink-border-2 px-3 py-1.5 text-caption font-medium text-ink-text-label transition-colors hover:bg-ink-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={busy || !prompt.trim()}
            className="flex items-center gap-1.5 rounded-full bg-ember px-3.5 py-1.5 text-caption font-semibold text-ink transition-colors hover:bg-ember-link disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Rocket className="h-3.5 w-3.5" aria-hidden />}
            Confirm — spawn the unit
          </button>
        </div>
      </div>
    </div>
  );
};
