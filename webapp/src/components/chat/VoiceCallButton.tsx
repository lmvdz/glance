import React from 'react';
import { PhoneCall } from 'lucide-react';

/**
 * The "start a live voice call" affordance in `Composer`'s icon row (webapp-voice-lane concern
 * 08). Deliberately a SEPARATE control from concern 01's plain-STT mic button beside it — two
 * different capabilities (free browser transcription into the text draft, vs. a metered
 * provider-direct S2S call) that must never look like the same button. `PhoneCall`/`amber` (the
 * brand's ember accent, `brand.md` — this repo's in-app components already use `amber-*` as that
 * accent) instead of `Mic`/gray|red keeps the two visually unambiguous at a glance.
 *
 * Purely presentational — no context reads, mirroring every other Composer icon-row button
 * (`ComposerSendButton` et al.) so it's directly testable with `renderToStaticMarkup` (this repo
 * has no jsdom). `AssistantChat.tsx` reads `useVoiceCall()` and passes the derived props down.
 */
export const VoiceCallButton = ({
  enabled,
  active,
  onStart,
}: {
  /** `GET /api/voice/config`'s `{enabled}` — hidden entirely (not disabled) when false, per
   *  DESIGN.md's "Flagging" row: "no button that 404s". */
  enabled: boolean;
  /** A voice call — for THIS session or any other — is already live. Only one `VoiceSession`
   *  exists at a time (provider-level); this button stays visible but disabled rather than
   *  vanishing, since "why did the button disappear" is a worse experience than a disabled state
   *  with an explanatory title. */
  active: boolean;
  onStart: () => void;
}) => {
  if (!enabled) return null;
  return (
    <button
      type="button"
      aria-label={active ? 'Voice call already in progress' : 'Start voice call'}
      title={active ? 'A voice call is already in progress' : 'Start a live voice call — you speak, the fleet answers'}
      disabled={active}
      onClick={onStart}
      className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? 'border-amber-300 bg-amber-50 text-amber-600 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-400'
          : 'border-transparent text-gray-500 hover:bg-amber-50 hover:text-amber-600 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 dark:text-gray-400 dark:hover:bg-amber-900/20 dark:hover:text-amber-400 dark:focus-visible:ring-offset-gray-950'
      }`}
    >
      <PhoneCall className="h-4 w-4" aria-hidden />
    </button>
  );
};
