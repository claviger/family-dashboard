import { and, asc, desc, eq, gte, inArray, lt, max, ne } from 'drizzle-orm';
import {
  compareBoardOrder, describeSchedule, isRepeating, TILE_ROWS, type BoardResponse, type BoardRow, type ChorePeopleEntry,
  type ChorePerson, type ChoreSummaryResponse, type HistoryEntry, type HistoryQuery, type HistoryRange, type HistoryResponse,
} from '../../../shared/chores.js';
import { addDays } from '../../../shared/dates.js';
import { localDate } from '../../core/clock.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import { choreOccurrences, chores, panelGrants, users, type ChoreRow } from '../../db/schema.js';
import { newerOnReopen } from './actions.js';
import { choreState } from './generator.js';
import { upcomingOccurrence, weekStart } from './schedule.js';
import { familyTimeZone, getChoreRow, peopleById, personOf, type ChoresDeps } from './store.js';

/** What the Chores panel reads: the board, the home tile, history, and the people list. */

/** Everyone, by name, with whether they have the Chores and To-do panels (for pickers and warnings). */
export function listChorePeople(db: Db): ChorePeopleEntry[] {
  const grants = db.select().from(panelGrants).where(inArray(panelGrants.panelId, ['chores', 'todo'])).all();
  const has = (userId: number, panel: string) => grants.some((g) => g.userId === userId && g.panelId === panel);
  return db
    .select({ id: users.id, displayName: users.displayName, color: users.color, active: users.active })
    .from(users)
    .orderBy(asc(users.displayName), asc(users.id))
    .all()
    .map((u) => ({ ...u, hasChores: has(u.id, 'chores'), hasTodo: has(u.id, 'todo') }));
}

/** A chore's row on the board (chore board spec, "The board"). */
export function boardRow(db: Db, chore: ChoreRow, people: Map<number, ChorePerson>, today: string, timeZone: string): BoardRow {
  const { open, timeline } = choreState(db, chore.id, today, timeZone);
  const base = {
    choreId: chore.id,
    title: chore.title,
    notes: chore.notes,
    schedule: chore.schedule,
    frequency: describeSchedule(chore.schedule),
    assignee: personOf(people, chore.assigneeUserId),
    occurrenceId: open?.id ?? null,
    todoSyncStatus: open?.todoSyncStatus ?? null,
  };
  // Unassigned chores have no due date and are never late.
  if (chore.assigneeUserId === null) return { ...base, state: 'unassigned', date: null, occurrenceId: null, todoSyncStatus: null };
  if (open) {
    if (open.dueDate === null) return { ...base, state: 'on_list', date: null };
    return { ...base, state: open.dueDate < today ? 'overdue' : 'due', date: open.dueDate };
  }
  // As needed, assigned, and not yet back on their list (e.g. resumed a moment ago): it will be by the next run.
  if (!isRepeating(chore.schedule)) return { ...base, state: 'on_list', date: null };
  return { ...base, state: 'waiting', date: upcomingOccurrence(chore.schedule, chore.startDate, timeline).dueDate };
}

/** GET /board: every active chore, most often first, then by title. Paused and archived chores aren't on it. */
export function choreBoard(deps: Pick<ChoresDeps, 'db' | 'clock'>): BoardResponse {
  const timeZone = familyTimeZone(deps.db);
  const today = localDate(deps.clock.now(), timeZone);
  const people = peopleById(deps.db);
  const rows = deps.db
    .select()
    .from(chores)
    .where(eq(chores.status, 'active'))
    .all()
    .map((c) => boardRow(deps.db, c, people, today, timeZone));
  return { today, rows: rows.sort(compareBoardOrder) };
}

/** One chore's row, whatever its status: what claim, release, and assign respond with. */
export function boardRowFor(deps: Pick<ChoresDeps, 'db' | 'clock'>, choreId: number): BoardRow {
  const chore = getChoreRow(deps.db, choreId);
  if (!chore) throw new AppError('not_found', 'Chore not found.');
  const timeZone = familyTimeZone(deps.db);
  return boardRow(deps.db, chore, peopleById(deps.db), localDate(deps.clock.now(), timeZone), timeZone);
}

/**
 * The tile's six-row rule: every due chore; then waiting ones, then Up for grabs, in what's left of
 * `limit`.
 */
export function fillTile<T>(due: T[], waiting: T[], upForGrabs: T[], limit = TILE_ROWS): { due: T[]; waiting: T[]; upForGrabs: T[] } {
  const room = Math.max(0, limit - due.length);
  const shownWaiting = waiting.slice(0, room);
  return { due, waiting: shownWaiting, upForGrabs: upForGrabs.slice(0, room - shownWaiting.length) };
}

/** Overdue first, then dated by due date, then as-needed ones; ties in board order. */
function byUrgency(a: BoardRow, b: BoardRow): number {
  const rank = (r: BoardRow) => (r.state === 'overdue' ? 0 : r.date !== null ? 1 : 2);
  return rank(a) - rank(b) || (a.date ?? '').localeCompare(b.date ?? '') || compareBoardOrder(a, b);
}

/** The home tile (chore board spec, "Home tile"): your due chores, yours coming up, and the top of Up for grabs. */
export function choresSummary(deps: Pick<ChoresDeps, 'db' | 'clock'>, userId: number): ChoreSummaryResponse {
  const board = choreBoard(deps);
  const mine = board.rows.filter((r) => r.assignee?.id === userId);
  const due = mine.filter((r) => r.occurrenceId !== null).sort(byUrgency);
  const waiting = mine
    .filter((r) => r.occurrenceId === null)
    .sort((a, b) => (a.date ?? '9999-12-31').localeCompare(b.date ?? '9999-12-31') || compareBoardOrder(a, b));
  const upForGrabs = board.rows.filter((r) => r.assignee === null);
  return { today: board.today, ...fillTile(due, waiting, upForGrabs) };
}

/** The dates a history range covers, inclusive. Weeks start on Sunday. */
export function resolveRange(range: HistoryRange, today: string, custom: { from?: string; to?: string } = {}): { from: string; to: string } {
  switch (range) {
    case 'this_week':
      return { from: weekStart(today), to: today };
    case 'this_month':
      return { from: `${today.slice(0, 8)}01`, to: today };
    case 'last_30_days':
      return { from: addDays(today, -29), to: today };
    case 'custom':
      return { from: custom.from!, to: custom.to! };
  }
}

/**
 * Completion history (spec §11.7). The range applies to the family-local date each occurrence was
 * completed or skipped. A person matches the completions credited to them and the skips of
 * occurrences assigned to them. Totals cover the whole filter, whether or not skips are shown.
 */
export function history(deps: Pick<ChoresDeps, 'db' | 'clock'>, q: HistoryQuery): HistoryResponse {
  const timeZone = familyTimeZone(deps.db);
  const today = localDate(deps.clock.now(), timeZone);
  const { from, to } = resolveRange(q.range, today, q);
  const people = peopleById(deps.db);

  // UTC offsets are under a day, so a day's margin on each side catches every local date in range;
  // the exact local-date test happens below.
  const conditions = [
    ne(choreOccurrences.state, 'open'),
    gte(choreOccurrences.completedAt, new Date(`${addDays(from, -1)}T00:00:00Z`)),
    lt(choreOccurrences.completedAt, new Date(`${addDays(to, 2)}T00:00:00Z`)),
  ];
  if (q.choreId !== undefined) conditions.push(eq(choreOccurrences.choreId, q.choreId));
  const rows = deps.db
    .select({ o: choreOccurrences, choreStatus: chores.status })
    .from(choreOccurrences)
    .innerJoin(chores, eq(chores.id, choreOccurrences.choreId))
    .where(and(...conditions))
    .orderBy(desc(choreOccurrences.completedAt), desc(choreOccurrences.id))
    .all();

  const choreIds = [...new Set(rows.map((r) => r.o.choreId))];
  const latestId = new Map(
    choreIds.length === 0
      ? []
      : deps.db
          .select({ choreId: choreOccurrences.choreId, id: max(choreOccurrences.id) })
          .from(choreOccurrences)
          .where(inArray(choreOccurrences.choreId, choreIds))
          .groupBy(choreOccurrences.choreId)
          .all()
          .map((r) => [r.choreId, r.id]),
  );

  const matching: HistoryEntry[] = [];
  for (const { o, choreStatus } of rows) {
    const closedDate = localDate(o.completedAt!, timeZone);
    if (closedDate < from || closedDate > to) continue;
    const person = o.state === 'done' ? o.creditedUserId : o.assigneeUserId;
    if (q.person !== 'all' && person !== q.person) continue;
    matching.push({
      id: o.id,
      choreId: o.choreId,
      title: o.titleSnapshot,
      dueDate: o.dueDate,
      state: o.state === 'done' ? 'done' : 'skipped',
      closedAt: o.completedAt!.toISOString(),
      closedDate,
      credited: personOf(people, o.creditedUserId),
      closedBy: personOf(people, o.actorUserId),
      assignee: personOf(people, o.assigneeUserId),
      assignmentSource: o.assignmentSource,
      // As-needed occurrences have no due date, so they're never late.
      late: o.state === 'done' && o.dueDate !== null && closedDate > o.dueDate,
      canReopen: choreStatus === 'active' && (latestId.get(o.choreId) === o.id || !newerOnReopen(deps.db, o, timeZone).blocked),
    });
  }
  const done = matching.filter((e) => e.state === 'done');
  return {
    today,
    from,
    to,
    totals: { completed: done.length, late: done.filter((e) => e.late).length, skipped: matching.length - done.length },
    entries: q.skipped ? matching : done,
  };
}
