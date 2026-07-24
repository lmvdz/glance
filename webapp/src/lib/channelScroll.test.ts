import { describe, expect, test } from 'bun:test';
import { channelScrollAfterRowsChange, channelScrollAfterSend, channelScrollAfterUserScroll, initialChannelScrollState } from './channelScroll';

describe('channel scroll modes', () => {
  test('starts following the end and sticks to bottom on row changes', () => {
    const result = channelScrollAfterRowsChange(initialChannelScrollState(), { scrollTop: 0, scrollHeight: 900, clientHeight: 300 });
    expect(result.state.mode).toBe('following-end');
    expect(result.scrollTop).toBe(600);
  });

  test('user scrolling away enters free-scrolling and does not re-scroll', () => {
    const state = channelScrollAfterUserScroll(initialChannelScrollState(), { scrollTop: 100, scrollHeight: 900, clientHeight: 300 });
    const result = channelScrollAfterRowsChange(state, { scrollTop: 100, scrollHeight: 1200, clientHeight: 300 });
    expect(result.state.mode).toBe('free-scrolling');
    expect(result.scrollTop).toBeUndefined();
  });

  test('send anchors the new turn near top instead of per-token bottom scrolling', () => {
    const state = channelScrollAfterSend('u1', { scrollTop: 600, scrollHeight: 900, clientHeight: 300 });
    const first = channelScrollAfterRowsChange(state, { scrollTop: 600, scrollHeight: 930, clientHeight: 300 }, 650);
    const second = channelScrollAfterRowsChange(first.state, { scrollTop: first.scrollTop ?? 0, scrollHeight: 960, clientHeight: 300 }, 16);
    expect(first.state.mode).toBe('anchoring-new-turn');
    expect(first.scrollTop).toBe(1234); // current scrollTop + 650 anchor top - 16 target
    expect(second.state.mode).toBe('anchoring-new-turn');
    expect(second.scrollTop).toBe(first.scrollTop);
  });
});
