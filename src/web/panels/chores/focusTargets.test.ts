import { describe, expect, it } from 'vitest';
import { afterComplete, onceSettled } from './focusTargets.js';

/** Stand-ins for registered elements: only `dataset` is read. */
function el(occurrence?: number): HTMLElement {
  return { dataset: occurrence === undefined ? {} : { occurrence: String(occurrence) } } as unknown as HTMLElement;
}

function registry(entries: Record<string, HTMLElement>) {
  return (key: string) => entries[key];
}

describe('afterComplete', () => {
  it("waits while the chore's checkbox is still the completed occurrence's", () => {
    const get = registry({ 'check-1': el(10), 'check-2': el(20), heading: el() });
    expect(afterComplete(get, 1, 10, [2], 'heading')).toBeNull();
  });

  it("focuses the chore's own checkbox when it's back with its next occurrence (a late repeating chore)", () => {
    const next = el(11);
    expect(afterComplete(registry({ 'check-1': next, 'check-2': el(20) }), 1, 10, [2], 'heading')).toBe(next);
  });

  it('else the next due chore still there, else the fallback', () => {
    const third = el(30);
    const heading = el();
    expect(afterComplete(registry({ 'check-3': third, heading }), 1, 10, [2, 3], 'heading')).toBe(third);
    expect(afterComplete(registry({ heading }), 1, 10, [2, 3], 'heading')).toBe(heading);
  });
});

describe('onceSettled', () => {
  it('finds nothing while the action is still pending', () => {
    const target = el();
    let pending = true;
    const find = onceSettled(() => pending, () => target);
    expect(find()).toBeNull();
    pending = false;
    expect(find()).toBe(target);
  });
});
