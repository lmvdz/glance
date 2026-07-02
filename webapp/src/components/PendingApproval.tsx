/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Clock, LogOut } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

// Shown when a user's domain-matched join request is awaiting an org admin's approval (org policy =
// "require approval"). They have a valid session but no org yet, so we hold them here rather than dropping
// them into an empty viewer dashboard.
export const PendingApproval = () => {
  const { pendingOrg, signOut } = useAuth();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0a0a0b] p-6 text-[#e7e7e9]">
      <div className="w-full max-w-[420px] rounded-xl border border-[#1c1c20] bg-[#0d0d0f] p-8 text-center">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full border border-[#2a2a2e] bg-[#161618]">
          <Clock className="h-5 w-5 text-[#8a8a90]" />
        </div>
        <h1 className="text-[17px] font-semibold">Request pending approval</h1>
        <p className="mx-auto mt-2 max-w-[320px] text-[13px] leading-relaxed text-[#8a8a90]">
          Your request to join{' '}
          <span className="font-medium text-[#e7e7e9]">{pendingOrg ?? 'your organization'}</span> is waiting
          for an admin to approve it. You’ll get access as soon as they do — try again shortly.
        </p>
        <button
          onClick={() => void signOut()}
          className="mt-6 inline-flex items-center gap-2 rounded-md border border-[#2a2a2e] px-4 py-2 text-[13px] font-medium text-[#e7e7e9] transition-colors hover:bg-[#161618]"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </div>
    </div>
  );
};
