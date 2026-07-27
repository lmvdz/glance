/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useAuth } from '../context/AuthContext';

// Shown when a user's domain-matched join request is awaiting an org admin's approval (org policy =
// "require approval"). They have a valid session but no org yet, so we hold them here rather than dropping
// them into an empty viewer dashboard.
export const PendingApproval = () => {
  const { pendingOrg, signOut } = useAuth();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-8" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      <div className="w-full" style={{ maxWidth: 560 }}>
        <div style={{ fontFamily: "'JetBrains Mono',ui-monospace,monospace", fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>
          NOTHING IS WRONG · SOMEBODY HAS TO LET YOU IN
        </div>
        {/* The old version put a clock glyph in a circle above a centred card, which reads as an
            error state. Nobody has failed anything here — a person simply has not answered yet. */}
        <div className="mt-3.5 text-[17px] leading-[1.5]" style={{ textWrap: 'pretty' }}>
          You asked to join {pendingOrg ?? 'this organisation'}, and it is set up so that a person there decides. Until one
          of them does, there is nothing here for you to see — not because anything went wrong, but because you are not in
          the room yet.
        </div>
        <div className="mt-3 text-[12.5px] leading-[1.55]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>
          Nothing is being held against you and nothing needs doing on your side. Come back and you will either be in, or
          still waiting on the same person.
        </div>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-6 h-8 rounded-[3px] px-3"
          style={{ border: '1px solid #26262B', fontFamily: "'JetBrains Mono',ui-monospace,monospace", fontSize: 10.5, color: '#C9C9CF' }}
        >
          sign out
        </button>
      </div>
    </div>
  );
};
