import { expect, test } from 'bun:test';
import { initialTheme } from './ThemeContext';

test('initialTheme: a saved explicit choice wins over OS preference', () => {
  expect(initialTheme('light', false)).toBe('light'); // saved light, OS dark → light (was lost on reload before)
  expect(initialTheme('dark', true)).toBe('dark'); // saved dark, OS light → dark
});

test('initialTheme: with no saved choice, fall back to OS preference', () => {
  expect(initialTheme(null, true)).toBe('light');
  expect(initialTheme(null, false)).toBe('dark');
});

test('initialTheme: garbage/absent storage values fall back to OS then dark default', () => {
  expect(initialTheme('', false)).toBe('dark');
  expect(initialTheme('LIGHT', false)).toBe('dark'); // not an exact 'light'/'dark' match
  expect(initialTheme(undefined as unknown as null, false)).toBe('dark');
});
