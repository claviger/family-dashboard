import type { BoardRow, ChorePeopleEntry } from '../../../shared/chores.js';

/** The Board's "Who has it" filter (spec §11.9): everyone, you, nobody, or one person by user id. */
export type BoardWho = 'all' | 'mine' | 'unassigned' | number;

/**
 * Reads `?who=` (spec §7), so the filter survives reloads and back/forward: "mine", "unassigned",
 * or a plain positive safe integer user id, as the URL gives it (text, see `parsePanelSearch`) or as
 * `navigate()` gives it. Anything else is Everyone.
 */
export function boardWhoFromSearch(raw: unknown): BoardWho {
  if (raw === 'mine' || raw === 'unassigned') return raw;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
  if (!/^\d+$/.test(text)) return 'all';
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : 'all';
}

/** The `?who=` value for `who`: Everyone comes out as `undefined`, which drops it from the URL. */
export function boardWhoSearch(who: BoardWho): string | undefined {
  return who === 'all' ? undefined : String(who);
}

/** The rows `who` keeps, in the board's own order. */
export function filterBoardRows(rows: BoardRow[], who: BoardWho, meId: number): BoardRow[] {
  if (who === 'all') return rows;
  if (who === 'unassigned') return rows.filter((r) => r.assignee === null);
  const id = who === 'mine' ? meId : who;
  return rows.filter((r) => r.assignee?.id === id);
}

/**
 * The people the filter offers after Everyone, Mine, and Unassigned: each active person who has a
 * chore on the board, by name, leaving out you (that's Mine). The person picked stays offered while
 * picked, even once they have nothing on the board or were deactivated, so the picker still shows
 * the filter in use; an id nobody has is never offered.
 */
export function boardWhoPeople(rows: BoardRow[], people: ChorePeopleEntry[], meId: number, who: BoardWho): ChorePeopleEntry[] {
  const onBoard = new Set(rows.flatMap((r) => (r.assignee ? [r.assignee.id] : [])));
  return people
    .filter((p) => p.id !== meId && ((p.active && onBoard.has(p.id)) || p.id === who))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** The count beside the Chores heading: "(10)", or "(4 of 10)" while filtered. */
export function boardCountLabel(shown: number, total: number, who: BoardWho): string {
  return who === 'all' ? `(${total})` : `(${shown} of ${total})`;
}

/** What the board says when the filter leaves nothing. `name` is the picked person's, when known. */
export function boardEmptyMessage(who: BoardWho, name: string | undefined): string {
  if (who === 'mine') return "You don't have any chores right now.";
  if (who === 'unassigned') return 'Every chore has someone.';
  return name ? `${name} doesn't have any chores right now.` : 'No chores match this filter.';
}
