import { describe, expect, it } from 'vitest';
import { savingsViewFromSearch, searchForSavingsView } from './savingsSearch.js';

describe("the Savings drill-down's query string", () => {
  it('reads the tab and a strict month, and writes them back leaving out the defaults', () => {
    expect(savingsViewFromSearch({})).toEqual({ tab: 'overview', month: null });
    expect(savingsViewFromSearch({ tab: 'settings', month: '2026-10' })).toEqual({ tab: 'settings', month: '2026-10' });
    for (const bad of ['2026-13', '2026-1', ' 2026-10', 202610, '2026-10-01', '2026-00']) expect(savingsViewFromSearch({ month: bad }).month, String(bad)).toBeNull();
    expect(searchForSavingsView({ tab: 'overview', month: null })).toEqual({});
    expect(searchForSavingsView({ tab: 'overview', month: '2026-10' })).toEqual({ month: '2026-10' });
    expect(searchForSavingsView({ tab: 'settings', month: null })).toEqual({ tab: 'settings' });
  });
});
