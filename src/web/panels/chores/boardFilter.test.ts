import { describe, expect, it } from 'vitest';
import type { BoardRow, ChorePeopleEntry, ChorePerson } from '../../../shared/chores.js';
import { parsePanelSearch, validatePanelSearch } from '../../panelSearch.js';
import { boardCountLabel, boardEmptyMessage, boardWhoFromSearch, boardWhoPeople, boardWhoSearch, filterBoardRows } from './boardFilter.js';

const ME = 1;
const grant: ChorePerson = { id: 1, displayName: 'Alex', color: '#378ADD' };
const riley: ChorePerson = { id: 2, displayName: 'Riley', color: '#1D9E75' };
const jordan: ChorePerson = { id: 3, displayName: 'Jordan', color: '#D85A30' };
const gone: ChorePerson = { id: 4, displayName: 'Bea', color: '#888888' };

function row(choreId: number, assignee: ChorePerson | null): BoardRow {
  return {
    choreId,
    title: `Chore ${choreId}`,
    notes: null,
    schedule: { kind: 'daily' },
    frequency: 'Every day',
    assignee,
    state: assignee ? 'due' : 'unassigned',
    date: assignee ? '2026-11-15' : null,
    occurrenceId: assignee ? choreId * 10 : null,
    todoSyncStatus: null,
  } as BoardRow;
}

const entry = (p: ChorePerson, active = true): ChorePeopleEntry => ({ ...p, active, hasChores: true, hasTodo: true });
// In board order (most often first), which filtering keeps.
const rows = [row(5, riley), row(3, null), row(8, grant), row(1, jordan), row(9, riley), row(2, null), row(7, gone)];
const people = [entry(grant), entry(riley), entry(jordan), entry(gone, false), entry({ id: 6, displayName: 'Cleo', color: '#000000' })];
const fromUrl = (search: string) => boardWhoFromSearch(validatePanelSearch(parsePanelSearch(search)).who);

describe('boardWhoFromSearch', () => {
  it('reads Everyone, Mine, Unassigned, or a person id, from the URL or from navigate()', () => {
    expect(fromUrl('')).toBe('all');
    expect(fromUrl('?who=mine')).toBe('mine');
    expect(fromUrl('?who=unassigned')).toBe('unassigned');
    expect(fromUrl('?who=7')).toBe(7);
    expect(boardWhoFromSearch(7)).toBe(7);
    expect(boardWhoFromSearch('mine')).toBe('mine');
  });

  it.each(['1e3', '%207', '7%20', '0', '-1', '1.0', '0x1f', 'MINE', 'all', 'everyone', '', '9007199254740993'])('falls back to Everyone for ?who=%s', (raw) => {
    expect(fromUrl(`?who=${raw}`)).toBe('all');
  });
});

describe('boardWhoSearch', () => {
  it('drops Everyone from the URL and writes the rest as text', () => {
    expect(boardWhoSearch('all')).toBeUndefined();
    expect(boardWhoSearch('mine')).toBe('mine');
    expect(boardWhoSearch('unassigned')).toBe('unassigned');
    expect(boardWhoSearch(7)).toBe('7');
    expect(fromUrl(`?who=${boardWhoSearch(7)}`)).toBe(7);
  });
});

describe('filterBoardRows', () => {
  const ids = (who: Parameters<typeof filterBoardRows>[1]) => filterBoardRows(rows, who, ME).map((r) => r.choreId);

  it('keeps every row, in board order, for Everyone', () => {
    expect(ids('all')).toEqual([5, 3, 8, 1, 9, 2, 7]);
  });

  it("keeps yours, the unassigned ones, or one person's, in board order", () => {
    expect(ids('mine')).toEqual([8]);
    expect(ids('unassigned')).toEqual([3, 2]);
    expect(ids(riley.id)).toEqual([5, 9]);
    expect(ids(99)).toEqual([]);
  });
});

describe('boardWhoPeople', () => {
  it('offers each active person who has a chore on the board, by name, leaving out you (that is Mine)', () => {
    expect(boardWhoPeople(rows, people, ME, 'all').map((p) => p.displayName)).toEqual(['Jordan', 'Riley']);
  });

  it('keeps the picked person while they are picked, even with nothing left on the board or deactivated', () => {
    expect(boardWhoPeople(rows, people, ME, 6).map((p) => p.displayName)).toEqual(['Cleo', 'Jordan', 'Riley']);
    expect(boardWhoPeople(rows, people, ME, gone.id).map((p) => p.displayName)).toEqual(['Bea', 'Jordan', 'Riley']);
  });

  it('offers nobody it does not know', () => {
    expect(boardWhoPeople(rows, people, ME, 99).map((p) => p.id)).toEqual([jordan.id, riley.id]);
  });
});

describe('boardCountLabel and boardEmptyMessage', () => {
  it('says how many show, and of how many when filtered', () => {
    expect(boardCountLabel(10, 10, 'all')).toBe('(10)');
    expect(boardCountLabel(4, 10, 'mine')).toBe('(4 of 10)');
    expect(boardCountLabel(10, 10, 'unassigned')).toBe('(10 of 10)');
  });

  it('says plainly why nothing shows', () => {
    expect(boardEmptyMessage('mine', undefined)).toBe("You don't have any chores right now.");
    expect(boardEmptyMessage('unassigned', undefined)).toBe('Every chore has someone.');
    expect(boardEmptyMessage(2, 'Riley')).toBe("Riley doesn't have any chores right now.");
    expect(boardEmptyMessage(99, undefined)).toBe('No chores match this filter.');
  });
});
