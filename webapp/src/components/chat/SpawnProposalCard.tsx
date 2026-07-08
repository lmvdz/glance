import React from 'react';
import { Rocket } from 'lucide-react';

/**
 * Feature 2 D3 — the proposal card. Rendered by `AssistantChat` under the assistant's most recent
 * settled reply whenever `spawnProposal.ts`'s `spawnProposalFor` finds that reply answered a user
 * turn carrying an attached image (the honest v1 trigger — see that module's header comment for
 * why this, not a model-emitted marker). This component itself does nothing but announce the
 * option and hand off to the confirm sheet on click — it never spawns anything (D3/D5: "never
 * auto-spawn").
 */
export const SpawnProposalCard = ({ onPropose }: { onPropose: () => void }) => (
  <div
    className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/20"
    data-spawn-proposal-card
  >
    <p className="text-[11px] text-amber-800 dark:text-amber-300">This turn carries an annotated capture — turn it into a real unit?</p>
    <button
      type="button"
      onClick={onPropose}
      className="flex flex-shrink-0 items-center gap-1.5 rounded-full bg-amber-600 px-3 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-amber-700 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 dark:bg-amber-500 dark:text-gray-950 dark:hover:bg-amber-400 dark:focus-visible:ring-offset-gray-950"
    >
      <Rocket className="h-3.5 w-3.5" aria-hidden />
      Spawn a unit to build this.
    </button>
  </div>
);
