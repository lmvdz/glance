import React from 'react';
import { useTaskContext } from '../../context/TaskContext';
import { summarizeCapabilities } from '../../lib/capabilityStatus';
import { HEALTH_TONE, HEALTH_WORD, borrowedHeadline, inForce, onOffer, requiresLine, reversalNote, type BorrowedPack } from '../../lib/borrowedSurface';

/**
 * BorrowedSurface — what this product can do that you did not teach it.
 *
 * `05-first-week.html` runs its whole first week on one distinction: what the product knows because
 * you said it, and what it does because it borrowed a default. Its meta line is *"borrowed defaults in
 * force · 6, all reversible"*. A capability pack is exactly that — an ability nobody here wrote — so
 * this is the borrowed-defaults list, not an app store and not a health dashboard.
 *
 * Replaces a panel of five coloured badge states over cards counting tools, skills and workflows.
 * Counting a pack's tools tells a reader nothing about whether they want it, and "Available" sat in
 * the same list as "Active" — a thing you have not installed beside a thing already acting for you.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

function Row({ pack, onToggle, onInstall }: { pack: BorrowedPack; onToggle?: () => void; onInstall?: () => void }) {
  const requires = requiresLine(pack);
  return (
    <div className="flex gap-3 py-3" style={{ borderTop: '1px solid #17171A' }}>
      <div className="mt-[7px] h-[5px] w-[5px] flex-none rounded-full" style={{ background: HEALTH_TONE[pack.health] }} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2.5">
          <div className="truncate text-[13px]" style={{ color: '#DEDEE2' }}>{pack.title}</div>
          <div style={{ fontFamily: MONO, fontSize: 10, color: HEALTH_TONE[pack.health] }}>{HEALTH_WORD[pack.health]}</div>
        </div>
        {pack.description ? (
          <div className="mt-[3px] text-[12px] leading-[1.5]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>{pack.description}</div>
        ) : null}
        {/* Missing configuration is a fact that overrides the state word above it, not a warning colour. */}
        {requires ? <div className="mt-1 text-[11.5px] leading-[1.45]" style={{ color: '#C2704A', textWrap: 'pretty' }}>{requires}</div> : null}
        {/* What taking it back costs, never a bare toggle. */}
        <div className="mt-1 text-[11.5px] leading-[1.45]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>{reversalNote(pack)}</div>
      </div>
      {onInstall ? (
        <button type="button" onClick={onInstall} className="h-7 flex-none rounded-[3px] px-2.5" style={{ border: '1px solid #26262B', fontFamily: MONO, fontSize: 10, color: '#C9C9CF' }}>
          borrow it
        </button>
      ) : onToggle ? (
        <button type="button" onClick={onToggle} className="h-7 flex-none rounded-[3px] px-2.5" style={{ border: '1px solid #26262B', fontFamily: MONO, fontSize: 10, color: '#C9C9CF' }}>
          {pack.health === 'idle' ? 'switch on' : 'take it back'}
        </button>
      ) : null}
    </div>
  );
}

export function BorrowedSurface() {
  const { capabilities, publicCatalog, setCapabilityEnabled, importCatalogCapability } = useTaskContext();
  // Installed packs and the public catalogue are different wire types, so they are summarised
  // separately and then kept apart on screen anyway — which is the point.
  const summary = React.useMemo(
    () => summarizeCapabilities(capabilities?.packs ?? [], capabilities?.installs ?? []),
    [capabilities],
  );

  const packs: BorrowedPack[] = React.useMemo(
    () => summary.packs.map((status) => ({
      id: status.pack.id,
      title: status.pack.title,
      description: status.pack.description,
      health: status.health,
      detail: status.detail,
      requiredEnv: status.pack.requiredEnv,
      toolCount: status.toolCount,
      skillCount: status.skillCount,
      workflowCount: status.workflowCount,
    })),
    [summary],
  );
  const force = inForce(packs);
  // The catalogue never carries an install, so every entry is "on offer" by construction — there is
  // no state to derive and nothing here is acting on anyone's behalf.
  const offered = onOffer([
    ...packs,
    ...(publicCatalog ?? []).map((entry) => ({
      id: entry.id,
      title: entry.title,
      description: entry.description,
      health: 'available' as const,
      detail: '',
      requiredEnv: entry.requiredEnv,
      toolCount: entry.tools.length,
      skillCount: entry.skills.length,
      workflowCount: entry.workflows.length,
    })),
  ]);
  const statusById = React.useMemo(() => new Map(summary.packs.map((status) => [status.pack.id, status])), [summary]);

  return (
    <div className="h-full overflow-y-auto" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      <div className="mx-auto max-w-[900px] px-8 py-9">
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>
          WHAT THIS PRODUCT CAN DO THAT YOU DID NOT TEACH IT
        </div>
        <div className="mt-3.5 text-[17px] leading-[1.5]" style={{ color: '#E8E8EA', textWrap: 'pretty', maxWidth: 720 }}>
          {borrowedHeadline(packs)}
        </div>

        {force.length > 0 ? (
          <>
            <div className="mt-7" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>IN FORCE · {force.length}</div>
            <div className="mt-1.5 flex flex-col">
              {force.map((pack) => {
                const status = statusById.get(pack.id);
                return (
                  <Row
                    key={pack.id}
                    pack={pack}
                    onToggle={status?.runnable ? () => setCapabilityEnabled(status.runnable!.id, !status.runnable!.enabled) : undefined}
                  />
                );
              })}
            </div>
          </>
        ) : null}

        {offered.length > 0 ? (
          <>
            {/* A catalogue, kept apart from the things already acting on your behalf. */}
            <div className="mt-8" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>ON OFFER · {offered.length}</div>
            <div className="mt-1 text-[12px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty', maxWidth: 700 }}>
              None of these is doing anything. They are here so the list above stays a list of what is actually in force.
            </div>
            <div className="mt-1.5 flex flex-col">
              {offered.map((pack) => (
                <Row key={pack.id} pack={pack} onInstall={() => importCatalogCapability(pack.id)} />
              ))}
            </div>
          </>
        ) : null}

        <div className="mt-8 pt-3" style={{ borderTop: '1px solid #1F1F22', fontFamily: MONO, fontSize: 10, color: '#4A4A52', lineHeight: 1.8 }}>
          <div>every borrowed capability is reversible · none of them is a setting you cannot read</div>
        </div>
      </div>
    </div>
  );
}
