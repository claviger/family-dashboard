import { describe, expect, it } from 'vitest';
import { parsePanelSearch, validatePanelSearch } from '../../panelSearch.js';
import { defaultHistoryFilter, historyFilterFromSearch, historySearchFor, type HistoryFilter } from './historySearch.js';

const ME = 4;
const defaults = defaultHistoryFilter(ME);
const fromUrl = (search: string) => historyFilterFromSearch(validatePanelSearch(parsePanelSearch(search)), ME);

describe('historyFilterFromSearch', () => {
  it('defaults to you, the last 30 days, all chores, with skips shown', () => {
    expect(historyFilterFromSearch({}, ME)).toEqual({ person: ME, range: 'last_30_days', from: '', to: '', choreId: null, skipped: true });
    expect(fromUrl('?tab=history')).toEqual(defaults);
  });

  it('reads every filter from the URL', () => {
    expect(fromUrl('?tab=history&person=all&range=custom&from=2026-11-01&to=2026-11-14&choreId=12&skipped=false')).toEqual({
      person: 'all', range: 'custom', from: '2026-11-01', to: '2026-11-14', choreId: 12, skipped: false,
    });
    expect(fromUrl('?person=7&range=this_week')).toMatchObject({ person: 7, range: 'this_week' });
  });

  it('takes the values navigate() gives too: numbers and booleans', () => {
    expect(historyFilterFromSearch({ person: 7, choreId: 3, skipped: false }, ME)).toMatchObject({ person: 7, choreId: 3, skipped: false });
  });

  it.each([
    ['person', ['1e3', '%207', '7%20', '0', '-1', '1.0', '0x1f', 'everyone', '', '9007199254740993']],
    ['choreId', ['1e3', '%207', '0', '-2', '2.5', 'x', '']],
    ['range', ['yesterday', 'CUSTOM', '%22custom%22', '']],
    ['skipped', ['no', '0', 'FALSE', '%22false%22', '']],
  ] as const)('ignores a bad %s and uses its default', (key, values) => {
    for (const value of values) {
      expect(fromUrl(`?${key}=${value}`)).toEqual(defaults);
    }
  });

  it('ignores a repeated key', () => {
    expect(fromUrl('?person=2&person=3')).toEqual(defaults);
  });

  it('reads dates only for a custom range, and only real ones written as YYYY-MM-DD', () => {
    expect(fromUrl('?range=this_month&from=2026-11-01&to=2026-11-14')).toMatchObject({ range: 'this_month', from: '', to: '' });
    expect(fromUrl('?range=custom&from=2026-02-30&to=2026-11-14')).toMatchObject({ from: '', to: '2026-11-14' });
    expect(fromUrl('?range=custom&from=2026-11-1&to=%222026-11-14%22')).toMatchObject({ range: 'custom', from: '', to: '' });
    expect(fromUrl('?range=custom&from=2026-11-01')).toMatchObject({ from: '2026-11-01', to: '' });
  });

  it('drops both dates when the start is after the end', () => {
    expect(fromUrl('?range=custom&from=2026-11-15&to=2026-11-14')).toMatchObject({ range: 'custom', from: '', to: '' });
    expect(fromUrl('?range=custom&from=2026-11-14&to=2026-11-14')).toMatchObject({ from: '2026-11-14', to: '2026-11-14' });
  });
});

describe('historySearchFor', () => {
  const f = (over: Partial<HistoryFilter>): HistoryFilter => ({ ...defaults, ...over });

  it('leaves defaults out of the URL', () => {
    expect(historySearchFor(defaults, ME)).toEqual({
      person: undefined, range: undefined, from: undefined, to: undefined, choreId: undefined, skipped: undefined,
    });
  });

  it('writes the rest, with dates only for a custom range', () => {
    expect(historySearchFor(f({ person: 'all', range: 'custom', from: '2026-11-01', to: '', choreId: 5, skipped: false }), ME)).toEqual({
      person: 'all', range: 'custom', from: '2026-11-01', to: undefined, choreId: 5, skipped: false,
    });
    expect(historySearchFor(f({ person: 9, range: 'this_week', from: '2026-11-01', to: '2026-11-02' }), ME)).toMatchObject({
      person: 9, range: 'this_week', from: undefined, to: undefined,
    });
  });

  it('round-trips through the URL as the router writes it', () => {
    const filter = f({ person: 'all', range: 'custom', from: '2026-11-01', to: '2026-11-14', choreId: 5, skipped: false });
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(historySearchFor(filter, ME))) if (v !== undefined) params.set(k, String(v));
    expect(fromUrl(`?tab=history&${params}`)).toEqual(filter);
  });
});
