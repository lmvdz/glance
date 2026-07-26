/**
 * roomFrame.ts — the room's own copy, taken from the reference rather than from a summary of it.
 *
 * The previous attempt at concern 03 implemented the design's RULES and none of its FORM, and the
 * result was the old room with a strip bolted to the side. This module carries the strings the
 * reference actually shows, so the frame beside it has something true to render.
 *
 * Values are the reference's, not approximations: the top line reads "47 units working · 5 plans · 3
 * waiting on you", the alarm eyebrow counts in words, and the right rail closes with the line about
 * saying an address out loud.
 */

import type { RoomNode } from './roomState';

/** The one-line state of the whole fleet, in the top bar. */
export function fleetSummary(nodes: readonly RoomNode[], plans: number): string {
	const working = nodes.filter((node) => node.state === 'in-flight' || node.state === 'blocked').length;
	const waiting = nodes.filter((node) => node.state === 'needs-you').length;
	const parts = [
		`${working} unit${working === 1 ? '' : 's'} working`,
		`${plans} plan${plans === 1 ? '' : 's'}`,
		waiting === 0 ? 'nothing waiting on you' : `${waiting} waiting on you`,
	];
	return parts.join(' · ');
}

const WORDS = ['nothing', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** The alarm eyebrow. Counts in words, because a numeral reads as a metric and this is a sentence. */
export function alarmEyebrow(waiting: number): string {
	if (waiting === 0) return 'NOTHING IS WAITING ON YOU';
	const word = (WORDS[waiting] ?? String(waiting)).toUpperCase();
	return waiting === 1 ? 'ONE THING IS WAITING ON YOU' : `${word} THINGS ARE WAITING ON YOU`;
}

/**
 * The explanation under the eyebrow. Several at once is a statement about the WORK — the fleet is
 * meant to finish without asking — not a to-do list handed to a person.
 */
export function alarmExplanation(waiting: number, autonomy: { sinceMs?: number; now: number }): string {
	if (waiting === 0) {
		if (autonomy.sinceMs === undefined) return 'The fleet has not had to stop for anyone.';
		const mins = Math.round(Math.max(0, autonomy.now - autonomy.sinceMs) / 60_000);
		const elapsed = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
		return `${elapsed} of unbroken autonomy. The fleet is meant to finish without asking, and it has.`;
	}
	if (waiting === 1) return 'The fleet is meant to finish without asking. This one could not, and said so rather than guessing.';
	return 'The fleet is meant to finish without asking. Several of these at once is a defect in the work, not a list for you to keep.';
}

/** The right-hand statistics beside the alarm band: how long, and what normal looks like. */
export function alarmStats(nodes: readonly RoomNode[], now: number): string[] {
	const waiting = nodes.filter((node) => node.state === 'needs-you');
	if (waiting.length === 0) return ['nothing stalled', 'normal: 0'];
	const oldest = waiting.reduce((worst, node) => Math.min(worst, node.lastMovementAt ?? now), now);
	const mins = Math.round((now - oldest) / 60_000);
	const label = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
	// "Normal is 0" is the standing law stated as a number, so a non-zero count reads as the defect it is.
	return [`oldest stalled ${label}`, 'normal: 0'];
}

/** Where the reader is standing, in one line under the heading. */
export function standingLine(nodes: readonly RoomNode[]): string {
	const depth = nodes.reduce((max, node) => Math.max(max, node.address.split('.').length), 1);
	return `${nodes.length} unit${nodes.length === 1 ? '' : 's'} · depth ${depth}`;
}

/** The reference closes the rail with this. It is the addressability principle, said once. */
export const ADDRESSABILITY_NOTE = 'say “three point two” out loud and you both mean the same unit';
