import type { BoardRow, ChorePeopleEntry, ChorePerson, HistoryEntry } from '../../../shared/chores.js';
import { formatDue } from '../todo/format.js';

/** "Today", "Tomorrow", "Yesterday", or a short date like "Wed, Nov 18" (with the year if it differs). */
export function formatDay(date: string, today: string): string {
  return formatDue({ dueDate: date, dueTime: null }, today)!;
}

/** "Today", "Tomorrow", and "Yesterday" read lower-case after a word ("Due today"); other days as written. */
export function dayAfterWord(date: string, today: string): string {
  const day = formatDay(date, today);
  return ['Today', 'Tomorrow', 'Yesterday'].includes(day) ? day.toLowerCase() : day;
}

/**
 * A board row's state (chore board spec), for the board and the home tile alike: "Due today",
 * "Overdue since Mon, Nov 9", "Next: Fri, Nov 27", or "On your list" / "On their list". A due date
 * after today isn't due yet, so it reads "Next: …" like a waiting chore. Null for Unassigned: it has
 * no date and is never late.
 */
export function boardStateLabel(row: Pick<BoardRow, 'state' | 'date'>, today: string, mine: boolean): string | null {
  switch (row.state) {
    case 'unassigned':
      return null;
    case 'due':
      // Dates are family-local YYYY-MM-DD, so they compare as strings.
      return row.date! > today ? `Next: ${formatDay(row.date!, today)}` : `Due ${dayAfterWord(row.date!, today)}`;
    case 'overdue':
      return `Overdue since ${dayAfterWord(row.date!, today)}`;
    case 'waiting':
      return `Next: ${formatDay(row.date!, today)}`;
    case 'on_list':
      return mine ? 'On your list' : 'On their list';
  }
}

/** A person who would never see a chore assigned to them (spec §11.4). */
export function wontSeeChores(p: ChorePeopleEntry | undefined): boolean {
  return p !== undefined && !p.hasChores && !p.hasTodo;
}

export function wontSeeWarning(name: string): string {
  return `${name} has neither the Chores nor the To-do panel, so they won't see this chore.`;
}

export interface CreditOption {
  id: number;
  label: string;
  disabled: boolean;
}

/**
 * The History tab's "Change credit" picker: every active person, plus the credited person as a
 * disabled "<name> (deactivated)" option if they've been deactivated, so the current value still
 * shows. It starts on the credited person if they're active, else on you, else the first active
 * person; never on someone who can't be picked.
 */
export function creditPicker(
  credited: ChorePerson | null,
  people: ChorePeopleEntry[],
  meId: number,
): { initial: number; options: CreditOption[] } {
  const active = people.filter((p) => p.active);
  const creditedEntry = credited ? people.find((p) => p.id === credited.id) : undefined;
  const options: CreditOption[] = [
    ...(creditedEntry && !creditedEntry.active ? [{ id: creditedEntry.id, label: `${creditedEntry.displayName} (deactivated)`, disabled: true }] : []),
    ...active.map((p) => ({ id: p.id, label: p.displayName, disabled: false })),
  ];
  const initial = [credited?.id, meId].find((id) => active.some((p) => p.id === id)) ?? active[0]?.id ?? meId;
  return { initial, options };
}

/** "Riley", "Riley · checked off by Alex", or "Skipped by Alex" (spec §11.7). */
export function whoLine(e: Pick<HistoryEntry, 'state' | 'credited' | 'closedBy'>): string {
  if (e.state === 'skipped') return `Skipped by ${e.closedBy?.displayName ?? 'someone'}`;
  const credited = e.credited?.displayName ?? 'Nobody';
  return e.closedBy && e.closedBy.id !== e.credited?.id ? `${credited} · checked off by ${e.closedBy.displayName}` : credited;
}
