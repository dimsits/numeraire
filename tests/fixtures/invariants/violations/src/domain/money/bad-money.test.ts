// Fixture: a test file containing the same patterns. It must be EXEMPT --
// tests legitimately reference the banned constructs in assertions.
import { toMajor } from './bad-money.js';

it('parses', () => {
  expect(parseFloat('100')).toBe(100);
  expect((1.5).toFixed(2)).toBe('1.50');
  expect(new Date()).toBeInstanceOf(Date);
  expect(toMajor('100')).toBe(1);
});
