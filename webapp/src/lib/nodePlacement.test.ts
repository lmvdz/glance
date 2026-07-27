import { describe, expect, it } from 'bun:test';
import { beneathSentence, besideLabel, inherited, inheritedAbsence, placement, trail, type PlacementNode } from './nodePlacement';

const nodes: PlacementNode[] = [
  { id: '3', name: 'payments-retry' },
  { id: '3.3', name: 'circuit-breaker', parentId: '3', goal: 'Half-open uses a single probe call, and refusals are per endpoint.' },
  { id: '3.3.1', name: 'tripped-counter', parentId: '3.3' },
  { id: '3.3.2', name: 'the note in the docs', parentId: '3.3' },
];

describe('placement', () => {
  it('finds what is above, beneath and beside', () => {
    const p = placement(nodes, '3.3')!;
    expect(p.above?.id).toBe('3');
    expect(p.beneath.map((n) => n.id)).toEqual(['3.3.1', '3.3.2']);
    expect(p.beside).toEqual([]);
  });

  it('names siblings without including the node itself', () => {
    const p = placement(nodes, '3.3.2')!;
    expect(p.beside.map((n) => n.id)).toEqual(['3.3.1']);
    expect(p.beneath).toEqual([]);
  });

  it('builds the path root-first', () => {
    expect(trail(placement(nodes, '3.3.2')!.path)).toBe('payments-retry › circuit-breaker › the note in the docs');
  });

  it('returns undefined for an id that is not there rather than an empty placement', () => {
    // An empty placement would render as "nothing above, nothing beneath", which is a claim about a
    // node we cannot see.
    expect(placement(nodes, 'missing')).toBeUndefined();
  });

  it('does not hang on a parentId cycle', () => {
    const cyclic: PlacementNode[] = [{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }];
    expect(placement(cyclic, 'a')!.path.map((n) => n.id).sort()).toEqual(['a', 'b']);
  });
});

describe('beneathSentence', () => {
  it('says why a leaf is a leaf rather than leaving a heading over nothing', () => {
    expect(beneathSentence(0)).toContain('two people could do the halves at once');
  });
  it('counts sub-units', () => {
    expect(beneathSentence(1)).toContain('1 sub-unit,');
    expect(beneathSentence(2)).toContain('2 sub-units');
  });
});

describe('inherited', () => {
  it('quotes what the work above wrote down', () => {
    expect(inherited(nodes[1])).toContain('single probe call');
  });

  it('refuses to invent a constraint from a bare title', () => {
    expect(inherited({ id: '3', name: 'payments-retry' })).toBeUndefined();
    expect(inheritedAbsence({ id: '3', name: 'payments-retry' })).toContain('has not written down');
  });

  it('says a root inherited nothing rather than that its parent was silent', () => {
    expect(inheritedAbsence(undefined)).toContain('Nothing sits above this');
  });
});

describe('besideLabel', () => {
  it('keeps the reference’s singular heading', () => {
    expect(besideLabel(1)).toBe('BESIDE IT · ITS SIBLING');
    expect(besideLabel(3)).toBe('BESIDE IT · 3 SIBLINGS');
  });
});
