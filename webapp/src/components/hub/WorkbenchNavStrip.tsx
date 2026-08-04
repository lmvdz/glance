import React from 'react';
import { NAV_ROWS, currentNavRow, paletteNavigationHref } from '../../lib/commandPalette';
import type { WorkbenchRouteView } from '../../lib/router';

const MONO = "'JetBrains Mono',ui-monospace,monospace";

// Shared type scale for every entry. The first cut drew the strip at 28px tall with 11px #7A7A82 on
// the page's own #0A0A0B — technically present, reported as absent by the operator it was built for
// ("still dont see the nav strip"), which is the same failure as not shipping it. A navigation bar
// has to read as chrome at a glance, so: uppercase with tracking, a lighter ground than the page, a
// real bottom rule, and touch-sized rows. Being findable is the whole feature.
const ENTRY: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 11,
  letterSpacing: '0.09em',
  textTransform: 'uppercase',
  lineHeight: '28px',
  padding: '0 10px',
  borderRadius: 3,
  whiteSpace: 'nowrap',
};

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
 *
 * Exact vs. ancestor (see `currentNavRow`'s doc comment): standing on a row's own list surface
 * marks it as a plain, unclickable span — but standing one level below it (a task's detail, an
 * open plan brief, an open plan-reality doc) must keep that row a LIVE LINK back to the list. The
 * first cut of this strip collapsed both into "current = not a link," which reproduced the exact
 * complaint that prompted the strip, one level down: from a task's detail page, "Tasks" went dead
 * with no on-screen way back to the list it came from. An ancestor match stays a link, marked with
 * `aria-current="true"` (not `"page"` — the operator isn't standing on that literal page) so it
 * still reads as the section they're in without being a dead end.
 */
export function WorkbenchNavStrip({ view, id }: { view: WorkbenchRouteView; id?: string }) {
  const current = currentNavRow(view, id);
  return (
    <nav
      aria-label="Workbench surfaces"
      className="flex h-9 flex-none items-center gap-1 overflow-x-auto px-3"
      style={{ borderBottom: '1px solid #26262B', background: '#17171A' }}
    >
      {NAV_ROWS.map((row) => {
        const isExact = current?.id === row.id && current.match === 'exact';
        const isAncestor = current?.id === row.id && current.match === 'ancestor';
        // Only the exact match is unclickable — a link back to where you already stand is noise.
        // An ancestor match (one level below the row) must stay a real link, or the operator lands
        // exactly where the original report started: on a detail page with no way back to the list.
        if (isExact) {
          return (
            <span
              key={row.id}
              aria-current="page"
              style={{
                ...ENTRY,
                color: '#F0A35A',
                background: 'rgba(240,163,90,0.13)',
                boxShadow: 'inset 0 -2px 0 #F0A35A',
              }}
            >
              {row.label}
            </span>
          );
        }
        return (
          <a
            key={row.id}
            href={paletteNavigationHref(row.view) ?? HREF_FALLBACK}
            aria-current={isAncestor ? 'true' : undefined}
            className="transition-colors hover:bg-[#26262B] hover:text-[#E8E8EA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
            style={{
              ...ENTRY,
              color: isAncestor ? '#F0A35A' : '#8A8A91',
              // The section you are inside but not standing on: ember text, no fill, a dimmer rule —
              // distinguishable from both the exact match and a plain sibling without a legend. The
              // alpha is a floor, not a taste knob: this rule is the ONLY non-colour carrier of "you
              // are in this section", so it has to clear WCAG 1.4.11's 3:1 for non-text contrast
              // against the bar's own #17171A ground. 0.45 composites to ~2.72:1 and fails; 0.55
              // composites to ~3.44:1. Don't dim it without recomputing.
              ...(isAncestor ? { boxShadow: 'inset 0 -2px 0 rgba(240,163,90,0.55)' } : null),
            }}
          >
            {row.label}
          </a>
        );
      })}
    </nav>
  );
}
