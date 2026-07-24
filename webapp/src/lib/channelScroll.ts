export type ChannelScrollMode = 'following-end' | 'anchoring-new-turn' | 'free-scrolling';

export interface ChannelScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ChannelScrollState {
  mode: ChannelScrollMode;
  anchorEntryId?: string;
  reservedTrailingPx: number;
}

export const CHANNEL_ANCHOR_TOP_PX = 16;
export const CHANNEL_NEAR_END_PX = 48;

export function initialChannelScrollState(): ChannelScrollState {
  return { mode: 'following-end', reservedTrailingPx: 0 };
}

export function isNearChannelEnd(snapshot: ChannelScrollSnapshot, threshold = CHANNEL_NEAR_END_PX): boolean {
  return snapshot.scrollHeight - snapshot.clientHeight - snapshot.scrollTop <= threshold;
}

export function channelScrollAfterUserScroll(state: ChannelScrollState, snapshot: ChannelScrollSnapshot): ChannelScrollState {
  return isNearChannelEnd(snapshot) ? { mode: 'following-end', reservedTrailingPx: 0 } : { ...state, mode: 'free-scrolling', anchorEntryId: undefined, reservedTrailingPx: 0 };
}

export function channelScrollAfterSend(entryId: string, snapshot: ChannelScrollSnapshot): ChannelScrollState {
  return { mode: 'anchoring-new-turn', anchorEntryId: entryId, reservedTrailingPx: Math.max(0, snapshot.clientHeight - CHANNEL_ANCHOR_TOP_PX * 2) };
}

export function channelScrollAfterRowsChange(state: ChannelScrollState, snapshot: ChannelScrollSnapshot, anchorTop?: number): { state: ChannelScrollState; scrollTop?: number } {
  if (state.mode === 'following-end') return { state, scrollTop: Math.max(0, snapshot.scrollHeight - snapshot.clientHeight) };
  if (state.mode === 'free-scrolling') return { state };
  if (anchorTop === undefined) return { state: { mode: 'following-end', reservedTrailingPx: 0 }, scrollTop: Math.max(0, snapshot.scrollHeight - snapshot.clientHeight) };
  return { state, scrollTop: Math.max(0, snapshot.scrollTop + anchorTop - CHANNEL_ANCHOR_TOP_PX) };
}
