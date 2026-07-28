import React, { useState } from 'react';
import { ADDRESSABILITY_NOTE, alarmEyebrow, alarmExplanation, alarmStats, fleetSummary, standingLine } from '../../lib/roomFrame';
import { nodeStatusLine, selectionPreview, type RoomNode, type RoomView } from '../../lib/roomState';
import { Kbd } from '../kit/Kbd';

/**
 * RoomFrame — the room as the reference draws it.
 *
 * Three zones, and the shape is the design's rather than the old app's:
 *
 *   ┌ 44px  glance · repo · N units working · M plans · K waiting on you ······ clock ┐
 *   │ alarm band — only when something waits, and it shows the QUESTIONS, readable   │
 *   ├──────────────────────────────────────────────┬────────────────────────────────┤
 *   │ the conversation                             │ 376px  WHERE YOU ARE STANDING  │
 *   │                                              │ the addressable tree           │
 *   └──────────────────────────────────────────────┴────────────────────────────────┘
 *
 * The first attempt at this concern kept the old left rail and wedged a narrow state strip beside it.
 * That produced a room that read as unchanged, because it was: the rules had changed and the shape
 * had not. The tree lives on the RIGHT here, the waiting questions are shown in full at the top where
 * they can be read and answered, and there is no channel column — plans and doors are reached from
 * the tree and the palette.
 *
 * Colours are the reference's own values. `#D9A03C` is the alarm tone, deliberately distinct from the
 * `#F0A35A` action ember — DESIGN.md flags this as a good idea missing from brand.md, so it is used
 * here and should be added there rather than dropped.
 */

export type { RoomView };

export interface RoomFrameProps {
	repo: string;
	/** Every room and node conversation, so "where you are standing" can actually answer the question. */
	rooms: readonly RoomView[];
	activeRoomId: string;
	onOpenRoom: (id: string) => void;
	nodes: readonly RoomNode[];
	plans: number;
	now: number;
	autonomy?: { sinceMs?: number };
	selectedId?: string;
	onSelect: (node: RoomNode) => void;
	onEnter: (node: RoomNode) => void;
	/** The conversation. Supplied by the shell so this frame owns layout, not transport. */
	children: React.ReactNode;
	/** Open when someone is answering. Sits BESIDE the room — answering never takes the room away. */
	decision?: React.ReactNode;
	/**
	 * The call workspace's own panel: a voice decision door, the artifacts index, or one artifact.
	 *
	 * Wide screens put it exactly where `decision` goes — beside the conversation, never over it. A
	 * NARROW screen cannot hold both (376px of panel beside a 320px conversation is two unusable
	 * columns), so the frame becomes a single pane: the panel fills the width and the conversation
	 * is hidden until it is popped. Escape and the panel's own back control do the popping, and the
	 * scroll position and agent filter ride the back stack home (see `PaneStackEntry`).
	 */
	voicePanel?: React.ReactNode;
	/** The fleet's autonomy, readable from the room rather than from a settings page. */
	autonomyPanel?: React.ReactNode;
	/** Shown when standing inside a unit — replaces the tree, same as the other panels. */
	unitPanel?: React.ReactNode;
	autonomyOpen?: boolean;
	onToggleAutonomy?: () => void;
	/** Threaded to the room's own TopBar — see TopBar's doc comment for why this is a prop rather
	 *  than a direct `useTaskContext()` call. */
	onOpenPalette?: () => void;
}

const MONO = "'JetBrains Mono',ui-monospace,monospace";

function Waiting({ nodes, now, onEnter }: { nodes: readonly RoomNode[]; now: number; onEnter: (node: RoomNode) => void }) {
	return (
		<div className="flex flex-col">
			{nodes.map((node) => (
				<div
					key={node.id}
					role="button"
					tabIndex={0}
					onClick={() => onEnter(node)}
					onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onEnter(node); } }}
					className="flex cursor-pointer items-center gap-3.5 px-4 py-3"
					style={{ borderTop: '1px solid #211C16', borderLeft: '2px solid #D9A03C', background: '#161211' }}
				>
					<div className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[3px]" style={{ border: '1px solid #33333A', fontFamily: MONO, fontSize: 11, color: '#C9C9CF' }}>
						{(node.owner ?? node.title).slice(0, 1).toUpperCase()}
					</div>
					<div className="w-[150px] flex-none">
						<div className="text-[13px] font-semibold">{node.owner ?? node.title}</div>
						<div style={{ fontFamily: MONO, fontSize: 10.5, color: '#6A6A72' }}>{node.address} {node.title}</div>
					</div>
					{/* The QUESTION, in full. The old room showed a truncated label and made you go and find it. */}
					<div className="flex-1 text-[13.5px] leading-snug" style={{ color: '#E8E8EA', textWrap: 'pretty' }}>
						{nodeStatusLine(node, now)}
					</div>
				</div>
			))}
		</div>
	);
}

/**
 * The 44px bar the reference puts across every screen: who you are, which repo, what the fleet is
 * doing, and the time. It is exported because a surface opened FROM the room — cost, a plan, the
 * graph — must keep it. The previous shell gave those surfaces a channel rail with a WORKBENCH DOORS
 * list instead, which is why opening one still felt like leaving for the old application.
 *
 * `onOpenPalette`, when given, renders a ⌘K hint here — the dead-doors audit found the palette is
 * now how six of the eight built surfaces are reached (there is no rail left to click instead, see
 * this file's own header comment) and yet nothing on screen had ever said the shortcut exists. A
 * first-time operator who hasn't read a keybindings doc had no way to discover it. This bar is the
 * one element every screen shares, so it is the one place a hint here reaches all of them. Optional
 * (not `useTaskContext()` directly) so this stays the same prop-only component `hub.test.ts` renders
 * with `renderToStaticMarkup` and no provider.
 */
export function TopBar({ repo, summary, now, back, onOpenPalette }: { repo: string; summary?: string; now: number; back?: string; onOpenPalette?: () => void }) {
	return (
		<div className="flex h-11 flex-none items-center gap-3.5 px-4" style={{ borderBottom: '1px solid #1F1F22', background: '#0A0A0B' }}>
			<div className="flex items-baseline gap-2.5">
				<div className="text-sm font-semibold tracking-tight">glance</div>
				<div style={{ fontFamily: MONO, fontSize: 11, color: '#6A6A72' }}>{repo}</div>
			</div>
			<div className="h-4 w-px" style={{ background: '#1F1F22' }} />
			{summary ? <div style={{ fontFamily: MONO, fontSize: 11, color: '#8A8A91' }}>{summary}</div> : null}
			<div className="flex-1" />
			{/* Every surface you can open says how to leave it. */}
			{back ? <a href={back} style={{ fontFamily: MONO, fontSize: 10.5, color: '#5A5A61' }} title="Back to the room. Nothing here is lost.">esc goes back to the room</a> : null}
			{onOpenPalette ? (
				<button
					type="button"
					onClick={onOpenPalette}
					className="flex items-center gap-1.5 rounded-[3px] px-1 py-0.5 hover:bg-ink-surface"
					title="Jump to a view, or search the fleet's memory."
				>
					<Kbd keys="⌘K" label="jump anywhere" />
				</button>
			) : null}
			<div style={{ fontFamily: MONO, fontSize: 11, color: '#5A5A61' }}>
				{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
			</div>
		</div>
	);
}

export function RoomFrame({ repo, rooms, activeRoomId, onOpenRoom, nodes, plans, now, autonomy, autonomyPanel, autonomyOpen, onToggleAutonomy, unitPanel, selectedId, onSelect, onEnter, children, decision, voicePanel, onOpenPalette }: RoomFrameProps) {
	const waiting = nodes.filter((node) => node.state === 'needs-you');
	const selected = nodes.find((node) => node.id === selectedId);
	const stats = alarmStats(nodes, now);
	const quiet = waiting.length === 0;
	// #fleet and every active unit's channel stay on screen unconditionally; a settled unit's channel
	// (its owner finished, or the record behind it is simply gone — roomViewsFrom in lib/roomState.ts
	// treats both the same) folds away instead of piling up beside it forever. Collapsed by default:
	// the working surface is for what is still moving.
	const visibleRooms = rooms.filter((room) => !room.settled);
	const settledRooms = rooms.filter((room) => room.settled);
	const [settledRoomsOpen, setSettledRoomsOpen] = useState(false);
	const renderRoom = (room: RoomView) => {
		const here = room.id === activeRoomId;
		return (
			<button
				key={room.id}
				type="button"
				onClick={() => onOpenRoom(room.id)}
				className="flex items-center gap-2 px-1.5 py-1 text-left"
				style={{ borderLeft: `2px solid ${here ? '#F0A35A' : 'transparent'}`, background: here ? '#131316' : 'transparent' }}
				title={here ? 'You are reading this one.' : `Open ${room.name} — the room you are in now stays where it is.`}
			>
				<span style={{ fontFamily: MONO, fontSize: 11, color: here ? '#E8E8EA' : '#7A7A82' }}>{room.name}</span>
				{room.kind === 'node' ? <span style={{ fontFamily: MONO, fontSize: 9.5, color: '#4A4A52' }}>unit</span> : null}
				<span className="flex-1" />
				{room.unread > 0 ? (
					<span style={{ fontFamily: MONO, fontSize: 10, color: '#D9A03C' }}>{room.unread}</span>
				) : null}
			</button>
		);
	};

	return (
		<div className="flex h-full min-h-0 flex-1 flex-col" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
			<TopBar repo={repo} summary={fleetSummary(nodes, plans)} now={now} onOpenPalette={onOpenPalette} />

			<div className="flex min-h-0 flex-1 flex-col">
				{/* ── alarm band ─────────────────────────────────────────────────────── */}
				<div
					className="flex-none"
					style={{ background: quiet ? '#0C0C0D' : '#131010', borderBottom: '1px solid #1F1F22', borderTop: `1px solid ${quiet ? '#1F1F22' : '#4A3319'}` }}
				>
					<div className="flex items-end justify-between px-4 pb-2.5 pt-3.5 pl-[18px]">
						<div>
							<div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '.16em', color: quiet ? '#5A5A61' : '#D9A03C' }}>
								{alarmEyebrow(waiting.length)}
							</div>
							<div className="mt-1.5 max-w-[640px] text-[13px]" style={{ color: '#9A9AA2', textWrap: 'pretty' }}>
								{alarmExplanation(waiting.length, { sinceMs: autonomy?.sinceMs, now })}
							</div>
						</div>
						<div className="text-right" style={{ fontFamily: MONO, fontSize: 11, color: '#6A6A72', lineHeight: 1.7 }}>
							{stats.map((line) => <div key={line}>{line}</div>)}
						</div>
					</div>
					{waiting.length > 0 ? <Waiting nodes={waiting} now={now} onEnter={onEnter} /> : null}
				</div>

				{/* ── conversation + standing tree ───────────────────────────────────── */}
				<div className="flex min-h-0 flex-1">
					{/* Narrow screens are a single pane: an open workspace panel takes the whole width and
					    the conversation steps aside until it is popped. Wide screens keep both, which is
					    the arrangement the reference draws and the one that makes answering feel like
					    part of the room rather than a departure from it. */}
					<div className={`min-w-0 flex-1 flex-col ${voicePanel ? 'hidden md:flex' : 'flex'}`}>{children}</div>

					{/* Answering sits beside the conversation, never over it. A modal would make a person
					    leave the fleet to answer one question about it, and the standing tree is exactly
					    the context that makes them comfortable answering at all. */}
					{voicePanel}
					{/* The fleet decision panel defers to the call workspace panel, same precedence autonomy
					    and unit already give it below — two side panels at once would squeeze the
					    conversation on wide screens exactly the way a third rail column used to. */}
					{!voicePanel && decision}
					{!voicePanel && autonomyOpen && autonomyPanel ? <div className="hidden w-[520px] flex-none md:block" style={{ borderLeft: '1px solid #1F1F22' }}>{autonomyPanel}</div> : null}
					{!voicePanel && !autonomyOpen && !decision && unitPanel ? <div className="hidden w-[520px] flex-none md:block" style={{ borderLeft: '1px solid #1F1F22' }}>{unitPanel}</div> : null}

					{/* A panel TAKES THE RAIL'S PLACE rather than adding a third column. The reference draws
					    two columns — room and panel — and three at 1600px squeezed the conversation to
					    380px, which is narrower than the reading measure the messages are set to. The
					    rail comes back the moment the panel closes.

					    It is also hidden below the tablet breakpoint outright: 376px of standing tree
					    beside a phone-width conversation leaves neither of them readable, and the rooms
					    list is reachable from the top bar there instead. */}
					{voicePanel || decision || (autonomyOpen && autonomyPanel) || unitPanel ? null : (
					<aside className="hidden w-[376px] flex-none flex-col lg:flex" style={{ borderLeft: '1px solid #1F1F22' }} aria-label="Where you are standing">
						<div className="px-4 pb-1 pt-3.5">
							<div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>WHERE YOU ARE STANDING</div>
							<div className="mt-2 flex items-baseline gap-2">
								<div className="text-sm font-semibold">{repo}</div>
								<div style={{ fontFamily: MONO, fontSize: 10.5, color: '#6A6A72' }}>{standingLine(nodes)}</div>
							</div>
							{/* The question this panel is named after is "where am I", and a list of units does not
							    answer it — you also have to see which conversation you are in and what else there
							    is. Removing the old channel rail without putting this here left the room with no
							    orientation at all, while every other screen still had one. */}
							{/* Bounded and scrollable (the `scrollbar-custom` idiom other panels already use, e.g.
							    ToolCallGroup.tsx) rather than left to grow: a duplicate-riddled or simply
							    long-lived rail used to push everything below it off screen. #fleet and every
							    active unit render unconditionally inside it; only settled units fold away. */}
							<div className="mt-3 flex max-h-64 flex-col gap-px overflow-y-auto scrollbar-custom">
								{visibleRooms.map(renderRoom)}
								{settledRooms.length > 0 ? (
									<div className="flex flex-col gap-px">
										<button
											type="button"
											onClick={() => setSettledRoomsOpen((open) => !open)}
											aria-expanded={settledRoomsOpen}
											className="flex items-center gap-1.5 px-1.5 py-1 text-left"
											style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: '#5A5A61' }}
											title={settledRoomsOpen ? 'Hide settled units’ channels.' : 'Settled units’ channels stay readable — they are just off the working surface.'}
										>
											<span>{settledRoomsOpen ? '▾' : '▸'}</span>
											<span>{settledRooms.length} settled</span>
										</button>
										{settledRoomsOpen ? settledRooms.map(renderRoom) : null}
									</div>
								) : null}
							</div>
							<div className="mt-3" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>UNITS</div>
						</div>

						<div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2.5 scrollbar-custom">
							{nodes.length === 0 ? (
								<div className="px-2 py-3 text-[12px] leading-relaxed" style={{ color: '#6A6A72' }}>
									No work is running. Start something from the composer and it appears here with an address you can say out loud.
								</div>
							) : nodes.map((node) => {
								const isSelected = node.id === selectedId;
								const rule = node.state === 'needs-you' ? '#D9A03C' : isSelected ? '#F0A35A' : 'transparent';
								const dot = node.state === 'needs-you' ? '#D9A03C' : node.state === 'settled' ? '#3E7D57' : node.state === 'blocked' ? '#6A6A72' : '#F0A35A';
								return (
									<div
										key={node.id}
										role="button"
										tabIndex={0}
										aria-current={isSelected ? 'true' : undefined}
										onClick={() => onSelect(node)}
										onDoubleClick={() => onEnter(node)}
										onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); isSelected ? onEnter(node) : onSelect(node); } }}
										className="mb-px flex cursor-pointer gap-2.5 px-2 py-[7px]"
										style={{ borderLeft: `2px solid ${rule}`, background: isSelected ? '#131316' : 'transparent' }}
									>
										<div className="mt-[5px] h-[5px] w-[5px] flex-none rounded-full" style={{ background: dot }} />
										<div className="min-w-0 flex-1">
											<div className="flex items-baseline gap-2">
												<div className="text-[12.5px] font-semibold" style={{ color: node.state === 'settled' ? '#8A8A91' : '#E8E8EA' }}>{node.title}</div>
												<div style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>{node.address}</div>
											</div>
											<div className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: '#7A7A82', textWrap: 'pretty' }}>
												{nodeStatusLine(node, now)}
											</div>
										</div>
									</div>
								);
							})}
						</div>

						{selected ? (
							<div className="px-4 py-2.5 text-[11px] leading-snug" style={{ borderTop: '1px solid #1F1F22', color: '#7A7A82' }}>
								{selectionPreview(selected)}
							</div>
						) : null}
						<div className="px-4 py-3" style={{ borderTop: '1px solid #1F1F22', fontFamily: MONO, fontSize: 10, color: '#4A4A52', lineHeight: 1.8 }}>
							{ADDRESSABILITY_NOTE}
						</div>
						{onToggleAutonomy ? (
							<button
								type="button"
								onClick={onToggleAutonomy}
								className="px-4 py-2.5 text-left"
								style={{ borderTop: '1px solid #1F1F22', fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: autonomyOpen ? '#F0A35A' : '#5A5A61' }}
								title="What the fleet may settle without you, and what it never will — as a state you can read."
							>
								{autonomyOpen ? 'CLOSE AUTONOMY' : 'WHAT THE FLEET MAY SETTLE ›'}
							</button>
						) : null}
					</aside>
					)}
				</div>
			</div>
		</div>
	);
}
