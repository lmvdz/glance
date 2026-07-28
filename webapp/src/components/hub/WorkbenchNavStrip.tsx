import React from 'react';
import { NAV_ROWS, currentNavRowId, paletteNavigationHref } from '../../lib/commandPalette';
import type { WorkbenchRouteView } from '../../lib/router';

const MONO = "'JetBrains Mono',ui-monospace,monospace";

// Every NAV_ROWS entry resolves to a defined href (commandPalette.test.ts proves it); this is a
// defensive fallback only, never expected to be exercised.
const HREF_FALLBACK = '#fleet';

/**
 * WorkbenchNavStrip — lateral movement between the nine workbench surfaces, on screen.
 *
 * The dogfooding report that prompted this: "i see the tasks, and i see the acceptance criteria,
 * one thing that is difficult is navigating to the other pages, I was only able to do so through
 * the ctrl + K (jump anywhere) menu." True — once you land on Fleet/Tasks/Daily/Fog/Plan reality/
 * Plan briefs/Economics/Capabilities/Organization settings, nothing on screen shows a sibling is
 * even reachable, let alone lets you click to it. ⌘K still works exactly as before; this is an
 * additional, visible path, not a replacement for it.
 *
 * This does NOT apply to the room (RoomFrame's own header comment: "no channel column — plans and
 * doors are reached from the tree and the palette"). That law is about the room staying a narrative
 * home screen with cards as doors — it says nothing about moving sideways once you're already on a
 * workbench surface, which is the thing that was actually broken. RoomFrame never imports this
 * component, so the room keeps exactly the shape that law describes.
 *
 * One source of truth: NAV_ROWS (commandPalette.ts) — the same nine rows the ⌘K palette lists.
 * Adding a destination there is the only edit needed for it to appear here too.
 */
export function WorkbenchNavStrip({ view }: { view: WorkbenchRouteView }) {
  const currentId = currentNavRowId(view);
  return (
    <nav
      aria-label="Workbench surfaces"
      className="flex h-8 flex-none items-center gap-4 overflow-x-auto px-4"
      style={{ borderBottom: '1px solid #1F1F22', background: '#0A0A0B' }}
    >
      {NAV_ROWS.map((row) => {
        const here = row.id === currentId;
        // The current surface is marked, never a link to itself — clicking it would "navigate"
        // nowhere, which reads as broken rather than as confirmation of where you are.
        if (here) {
          return (
            <span key={row.id} aria-current="page" style={{ fontFamily: MONO, fontSize: 11, color: '#F0A35A' }}>
              {row.label}
            </span>
          );
        }
        return (
          <a
            key={row.id}
            href={paletteNavigationHref(row.view) ?? HREF_FALLBACK}
            className="rounded-[2px] transition-colors hover:text-[#E8E8EA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
            style={{ fontFamily: MONO, fontSize: 11, color: '#7A7A82' }}
          >
            {row.label}
          </a>
        );
      })}
    </nav>
  );
}
