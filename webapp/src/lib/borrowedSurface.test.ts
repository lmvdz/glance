import { describe, expect, it } from 'bun:test';
import { borrowedHeadline, inForce, onOffer, requiresLine, reversalNote, type BorrowedPack } from './borrowedSurface';

const pack = (over: Partial<BorrowedPack> = {}): BorrowedPack => ({
  id: 'p', title: 'p', description: '', health: 'active', detail: '', requiredEnv: [], toolCount: 2, skillCount: 0, workflowCount: 0, ...over,
});

describe('inForce / onOffer', () => {
  it('keeps what is acting on your behalf apart from a catalogue', () => {
    // "Available" sitting in the same list as "Active" puts a thing you have not installed next to a
    // thing already acting for you.
    const packs = [pack({ id: 'a', health: 'available' }), pack({ id: 'b', health: 'active' })];
    expect(inForce(packs).map((p) => p.id)).toEqual(['b']);
    expect(onOffer(packs).map((p) => p.id)).toEqual(['a']);
  });

  it('puts broken first', () => {
    const packs = [pack({ id: 'idle', health: 'idle', title: 'i' }), pack({ id: 'bad', health: 'broken', title: 'b' }), pack({ id: 'ok', health: 'active', title: 'a' })];
    expect(inForce(packs).map((p) => p.id)).toEqual(['bad', 'ok', 'idle']);
  });
});

describe('borrowedHeadline', () => {
  it('treats nothing borrowed as the goal, not a gap', () => {
    expect(borrowedHeadline([pack({ health: 'available' })])).toContain('not a state to fix');
  });

  it('leads with broken, and says why it is worse than off', () => {
    const line = borrowedHeadline([pack({ health: 'broken' }), pack({ id: 'x', health: 'active' })]);
    expect(line).toContain('worse than one plainly switched off');
  });

  it('says borrowed capabilities are reversible when they are working', () => {
    expect(borrowedHeadline([pack()])).toContain('all reversible');
  });
});

describe('reversalNote', () => {
  it('counts what the fleet loses rather than offering a bare toggle', () => {
    expect(reversalNote(pack({ toolCount: 3, skillCount: 1 }))).toContain('removes 4 things');
  });
  it('says switching off a broken one changes nothing that works', () => {
    expect(reversalNote(pack({ health: 'broken' }))).toContain('changes nothing that is working');
  });
  it('says a catalogue entry is doing nothing on your behalf', () => {
    expect(reversalNote(pack({ health: 'available' }))).toContain('doing nothing on your behalf');
  });
});

describe('requiresLine', () => {
  it('states missing configuration as a fact that overrides the state', () => {
    expect(requiresLine(pack({ requiredEnv: ['OPENAI_API_KEY'] }))).toContain('whatever its state says');
  });
  it('is silent when nothing is required', () => {
    expect(requiresLine(pack())).toBeUndefined();
  });
});
