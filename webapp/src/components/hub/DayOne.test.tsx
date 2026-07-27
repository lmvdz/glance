import { describe, expect, it } from 'bun:test';
import { guessedName } from './DayOne';

describe('guessedName', () => {
  it('marks a name taken from the path as a guess, not something you said', () => {
    expect(guessedName('/home/you/glance', '')).toEqual({ name: 'glance', guessed: true });
  });

  it('stops guessing the moment you name it', () => {
    expect(guessedName('/home/you/glance', 'Billing')).toEqual({ name: 'Billing', guessed: false });
  });

  it('tolerates a trailing slash rather than producing an empty name', () => {
    expect(guessedName('/home/you/glance/', '').name).toBe('glance');
  });

  it('still admits to guessing when there is nothing to guess from', () => {
    expect(guessedName('', '')).toEqual({ name: 'First project', guessed: true });
  });
});
