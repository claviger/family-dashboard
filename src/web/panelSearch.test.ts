import { defaultStringifySearch } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { parsePanelSearch, stringifyPanelSearch, validatePanelSearch } from './panelSearch.js';
import { defaultHistoryFilter, historyFilterFromSearch, historySearchFor, type HistoryFilter } from './panels/chores/historySearch.js';
import { searchForView, spendViewFromSearch, type SpendView } from './panels/spend/spendSearch.js';

describe('validatePanelSearch', () => {
  it('keeps a positive integer userId, as a number or a digit string', () => {
    expect(validatePanelSearch({ userId: 7 })).toEqual({ userId: 7 });
    expect(validatePanelSearch({ userId: '12' })).toEqual({ userId: 12 });
  });

  it.each([0, -1, 1.5, '0', '-3', '1e3', ' 7', '7 ', '0x1f', '1.0', '', 'abc', true, null, [1], { a: 1 }, 2 ** 53, '9007199254740993', Number.NaN, Infinity])(
    'drops userId %j',
    (userId) => {
      expect(validatePanelSearch({ userId, card: 'x' })).toEqual({ card: 'x' });
    },
  );

  it('passes unknown keys through untouched', () => {
    expect(validatePanelSearch({ userId: '3', card: 'visa', cycle: 2 })).toEqual({ userId: 3, card: 'visa', cycle: 2 });
    expect(validatePanelSearch({ card: 'visa' })).toEqual({ card: 'visa' });
  });
});

describe('parsePanelSearch', () => {
  const fromUrl = (search: string) => validatePanelSearch(parsePanelSearch(search));

  it('accepts a plain digit userId from the URL', () => {
    expect(fromUrl('?userId=42')).toEqual({ userId: 42 });
  });

  it.each(['?userId=1e3', '?userId=%207', '?userId=7%20', '?userId=1.0', '?userId=-1', '?userId=0', '?userId=', '?userId=1&userId=2', '?userId=9007199254740993'])(
    'drops the userId in %s',
    (search) => {
      expect(fromUrl(search)).toEqual({});
    },
  );

  it('parses other keys as the router normally does', () => {
    expect(parsePanelSearch('?userId=3&page=2&kind=visa')).toEqual({ userId: '3', page: 2, kind: 'visa' });
    expect(fromUrl('?kind=visa&userId=x')).toEqual({ kind: 'visa' });
  });

  it("keeps the Savings drill-down's month as raw text, for savingsViewFromSearch's strict check", () => {
    expect(parsePanelSearch('?month=2026-10')).toEqual({ month: '2026-10' });
    // The default parser would make this the number 2026.
    expect(parsePanelSearch('?month=2026')).toEqual({ month: '2026' });
  });

  it("keeps Spend's card, cycle, and category as raw text, for spendViewFromSearch's strict check", () => {
    expect(fromUrl('?card=007&cycle=2026-10-16&category=1e3&person=household&q=%222%22')).toEqual({
      card: '007', cycle: '2026-10-16', category: '1e3', person: 'household', q: '2',
    });
  });

  it("keeps the Chores History filters as raw text, for that tab's strict check", () => {
    expect(fromUrl('?tab=history&person=1e3&choreId=7&skipped=false&range=%22custom%22&from=2026-11-01')).toEqual({
      tab: 'history', person: '1e3', choreId: '7', skipped: 'false', range: '"custom"', from: '2026-11-01',
    });
  });

  it("keeps the Calendar's open event as raw text, on the drill-down and on the home card", () => {
    // Event ids are Google's base32hex, so one can look like a number ("1e3", "0012").
    expect(fromUrl('?event=1e3&view=week&date=2026-11-18')).toEqual({ event: '1e3', view: 'week', date: '2026-11-18' });
    expect(fromUrl('?calendarEvent=1e3')).toEqual({ calendarEvent: '1e3' });
    expect(fromUrl('?calendarEvent=0012')).toEqual({ calendarEvent: '0012' });
  });
});

describe('stringifyPanelSearch', () => {
  const roundTrip = (search: Record<string, unknown>) => validatePanelSearch(parsePanelSearch(stringifyPanelSearch(search)));

  it.each(['123', '1e3', 'false', 'true', 'null', '-1', '0012', 'a1b2c3d4e5f6g7h8i9j0k1l2m3', 'abc_20261118T170000Z'])(
    'writes a Calendar event id %j as raw text, so it reads back the same',
    (id) => {
      expect(stringifyPanelSearch({ calendarEvent: id })).toBe(`?calendarEvent=${encodeURIComponent(id)}`);
      expect(roundTrip({ calendarEvent: id })).toEqual({ calendarEvent: id });
      expect(roundTrip({ view: 'agenda', date: '2026-11-18', event: id })).toEqual({ view: 'agenda', date: '2026-11-18', event: id });
    },
  );

  it('writes keys that are not raw exactly as the router does', () => {
    for (const search of [{ new: 1 }, { tab: 'history' }, { q: '123' }, { q: 'coffee shop' }, { group: 'project' }, { tab: 'settings', q: 'a&b=c' }]) {
      expect(stringifyPanelSearch(search)).toBe(defaultStringifySearch(search));
    }
    // A text search that looks like a number is still quoted, as spendViewFromSearch expects.
    expect(parsePanelSearch(stringifyPanelSearch({ q: '123' }))).toEqual({ q: '123' });
  });

  it('keeps the keys in order, leaves out undefined ones, and writes nothing for an empty search', () => {
    expect(stringifyPanelSearch({ view: 'agenda', date: '2026-11-18', event: undefined, new: undefined })).toBe('?view=agenda&date=2026-11-18');
    expect(stringifyPanelSearch({ tab: 'history', person: 'all', range: 'custom', from: '2026-11-01', to: '2026-11-07' })).toBe('?tab=history&person=all&range=custom&from=2026-11-01&to=2026-11-07');
    expect(stringifyPanelSearch({})).toBe('');
    expect(stringifyPanelSearch({ event: undefined })).toBe('');
  });

  it("round-trips the To-do person picker's userId, given as a number", () => {
    expect(stringifyPanelSearch({ userId: 7 })).toBe('?userId=7');
    expect(roundTrip({ userId: 7 })).toEqual({ userId: 7 });
  });

  it('round-trips the Chores History filters', () => {
    const meId = 3;
    const filters: HistoryFilter[] = [
      { person: 'all', range: 'custom', from: '2026-11-01', to: '2026-11-07', choreId: 12, skipped: false },
      { person: 9, range: 'this_week', from: '', to: '', choreId: null, skipped: true },
      defaultHistoryFilter(meId),
    ];
    for (const filter of filters) {
      const search = { tab: 'history', ...historySearchFor(filter, meId) };
      expect(historyFilterFromSearch(roundTrip(search), meId)).toEqual(filter);
    }
  });

  it("round-trips Spend's card, cycle, person, category, search, and sort", () => {
    const views: SpendView[] = [
      { tab: 'overview', card: 4, cycle: '2026-10-16', person: 'household', category: 1000, q: '123', sort: { by: 'amount', dir: 'asc' } },
      { tab: 'settings', card: null, cycle: null, person: 2, category: null, q: 'blue bottle', sort: { by: 'date', dir: 'desc' } },
      { tab: 'overview', card: null, cycle: null, person: null, category: null, q: '', sort: { by: 'name', dir: 'desc' } },
    ];
    for (const view of views) expect(spendViewFromSearch(roundTrip(searchForView(view)))).toEqual(view);
  });

  it("round-trips the Calendar's view, day, open event, and New event", () => {
    expect(roundTrip({ view: 'month', date: '2026-02-01', event: '1e3' })).toEqual({ view: 'month', date: '2026-02-01', event: '1e3' });
    expect(roundTrip({ view: 'week', date: '2026-11-18', new: 1 })).toEqual({ view: 'week', date: '2026-11-18', new: 1 });
  });
});
