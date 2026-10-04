/**
 * The tab-bar split is the one piece of navigation policy that can be tested
 * without a browser: five destinations fit, a sixth must move into the «بیشتر»
 * sheet instead of squeezing tap targets under 44px.
 */
import { describe, expect, it } from 'vitest';

import { MAX_TABS, splitNavItems } from './primitives';

const many = Array.from({ length: 9 }, (_, i) => `s${i + 1}`);

describe('splitNavItems', () => {
  it('keeps every destination on the bar while it fits', () => {
    for (const n of [0, 1, 4, MAX_TABS]) {
      const { tabs, overflow } = splitNavItems(many.slice(0, n));
      expect(tabs).toHaveLength(n);
      expect(overflow).toEqual([]);
    }
  });

  it('reserves the last slot for the sheet once the bar is full', () => {
    const six = splitNavItems(many.slice(0, 6));
    expect(six.tabs).toEqual(['s1', 's2', 's3', 's4']);
    expect(six.overflow).toEqual(['s5', 's6']);

    const nine = splitNavItems(many);
    expect(nine.tabs).toHaveLength(MAX_TABS - 1);
    expect([...nine.tabs, ...nine.overflow]).toEqual(many);
    expect(nine.overflow).toHaveLength(many.length - (MAX_TABS - 1));
  });

  it('never returns more tabs than the bar can hold at 44px', () => {
    expect(splitNavItems(many).tabs.length).toBeLessThanOrEqual(MAX_TABS - 1);
  });

  it('does not mutate the input', () => {
    const source = [...many];
    splitNavItems(source);
    expect(source).toEqual(many);
  });
});
