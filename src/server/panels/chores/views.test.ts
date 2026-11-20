import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { HistoryQuerySchema, type NewChoreInput } from '../../../shared/chores.js';
import { updateUser } from '../../admin/users.js';
import { choreOccurrences } from '../../db/schema.js';
import { setFamilySettings } from '../../settings.js';
import { addUser, makeTestApp, type TestApp } from '../../test/helpers.js';
import { completeOccurrence, skipOccurrence, type ChoreUser } from './actions.js';
import { createChore, setChoreStatus } from './definitions.js';
import { generateChores } from './generator.js';
import { choreBoard, choresSummary, fillTile, history, listChorePeople, resolveRange } from './views.js';

let t: TestApp;
let admin: ChoreUser;
let kid: ChoreUser;
let sib: ChoreUser;

beforeEach(() => {
  t = makeTestApp();
  admin = { id: addUser(t.db, t.clock, { email: 'admin@example.com', displayName: 'Admin', role: 'admin', panels: ['chores'] }), role: 'admin' };
  kid = { id: addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo', 'chores'] }), role: 'member' };
  sib = { id: addUser(t.db, t.clock, { email: 'sib@example.com', displayName: 'Sib', panels: ['todo'] }), role: 'member' };
});

async function chore(title: string, over: Partial<NewChoreInput> = {}) {
  const c = await createChore(t, { title, notes: null, assigneeUserId: null, schedule: { kind: 'daily' }, startDate: '2026-11-10', ...over });
  return { chore: c, occId: t.db.select().from(choreOccurrences).where(eq(choreOccurrences.choreId, c.id)).get()?.id };
}

function q(raw: Record<string, string> = {}) {
  return HistoryQuerySchema.parse(raw);
}

describe('listChorePeople', () => {
  it('lists everyone with their Chores and To-do panels', () => {
    updateUser(t.db, sib.id, { active: false });
    expect(listChorePeople(t.db).map((p) => [p.displayName, p.active, p.hasChores, p.hasTodo])).toEqual([
      ['Admin', true, true, false], ['Kid', true, true, true], ['Sib', false, false, true],
    ]);
  });
});

describe('choresSummary', () => {
  it("splits the tile into your due chores, yours coming up, and the top of Up for grabs", async () => {
    await chore('Trash', { assigneeUserId: kid.id, startDate: '2026-11-15' });
    const late = await chore('Dishes', { assigneeUserId: kid.id });
    const fridays = await chore('Vacuum', { assigneeUserId: kid.id, schedule: { kind: 'weekly', interval: 1, weekdays: [5] } });
    await chore('Gutters', { assigneeUserId: kid.id, schedule: { kind: 'none' } });
    const early = await chore('Sweep', { assigneeUserId: kid.id, schedule: { kind: 'weekly', interval: 1, weekdays: [3] } });
    await completeOccurrence(t, kid, early.occId!); // due Wed 11-18, done early: coming up
    await chore('Cat', {});
    await chore('Yard', { assigneeUserId: sib.id });
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    await generateChores(t); // Trash's 11-16 waits behind its open 11-15; nothing else is due

    const s = choresSummary(t, kid.id);
    expect(s.today).toBe('2026-11-16');
    // Overdue first, then by date, then on your list; Dishes and Trash are both overdue since 11-15.
    expect(s.due.map((r) => [r.title, r.state, r.date])).toEqual([
      ['Dishes', 'overdue', '2026-11-15'],
      ['Trash', 'overdue', '2026-11-15'],
      ['Vacuum', 'due', '2026-11-20'],
      ['Gutters', 'on_list', null],
    ]);
    expect(s.due[0]?.occurrenceId).toBe(late.occId);
    expect(s.waiting.map((r) => [r.title, r.date])).toEqual([['Sweep', '2026-11-25']]);
    expect(s.upForGrabs.map((r) => r.title)).toEqual(['Cat']);
    expect(fridays.occId).toBe(s.due[2]?.occurrenceId);
  });

  it('keeps the tile to six rows, but always shows every due chore', () => {
    expect(fillTile([1, 2], [3, 4], [5, 6, 7, 8])).toEqual({ due: [1, 2], waiting: [3, 4], upForGrabs: [5, 6] });
    expect(fillTile([1, 2, 3, 4, 5], [6, 7], [8])).toEqual({ due: [1, 2, 3, 4, 5], waiting: [6], upForGrabs: [] });
    expect(fillTile([1, 2, 3, 4, 5, 6, 7], [8], [9])).toEqual({ due: [1, 2, 3, 4, 5, 6, 7], waiting: [], upForGrabs: [] });
    expect(fillTile([], [], [1, 2, 3, 4, 5, 6, 7])).toEqual({ due: [], waiting: [], upForGrabs: [1, 2, 3, 4, 5, 6] });
  });
});

describe('choreBoard', () => {
  it('lists every active chore, most often first, then by title', async () => {
    await chore('Yard', { schedule: { kind: 'monthly', day: 1 } });
    await chore('Trash', { schedule: { kind: 'weekly', interval: 1, weekdays: [5] } });
    await chore('b dishes', { schedule: { kind: 'daily' } });
    await chore('A cat', { schedule: { kind: 'daily' } });
    await chore('Fix the gate', { schedule: { kind: 'none' } });
    await chore('Water plants', { schedule: { kind: 'after', every: 2, unit: 'days' } });
    await chore('Laundry', { schedule: { kind: 'weekly', interval: 1, weekdays: [1, 4] } });
    const paused = await chore('Paused', {});
    await setChoreStatus(t, paused.chore.id, 'paused');
    const archived = await chore('Archived', {});
    await setChoreStatus(t, archived.chore.id, 'archived');

    const board = choreBoard(t);
    expect(board.today).toBe('2026-11-15');
    expect(board.rows.map((r) => [r.title, r.frequency])).toEqual([
      ['A cat', 'Every day'],
      ['b dishes', 'Every day'],
      ['Water plants', "Every 2 days after it's done"],
      ['Laundry', 'Every week on Mon, Thu'],
      ['Trash', 'Fridays'],
      ['Yard', 'Monthly on the 1st'],
      ['Fix the gate', 'As needed'],
    ]);
    expect(board.rows.every((r) => r.state === 'unassigned' && r.date === null && r.assignee === null && r.occurrenceId === null)).toBe(true);
  });

  it("shows each assigned chore's state: due, overdue, waiting for its next date, or on their list", async () => {
    const due = await chore('Dishes', { assigneeUserId: kid.id });
    const fridays = await chore('Trash', { assigneeUserId: kid.id, schedule: { kind: 'weekly', interval: 1, weekdays: [5] } });
    await chore('Fix the gate', { assigneeUserId: kid.id, schedule: { kind: 'none' } });
    const row = (title: string) => choreBoard(t).rows.find((r) => r.title === title)!;

    expect(row('Dishes')).toMatchObject({
      state: 'due', date: '2026-11-15', assignee: { id: kid.id, displayName: 'Kid' }, occurrenceId: due.occId, todoSyncStatus: 'ok',
    });
    expect(row('Trash')).toMatchObject({ state: 'due', date: '2026-11-20' });
    expect(row('Fix the gate')).toMatchObject({ state: 'on_list', date: null });

    // Done early: waiting until Friday has passed, then due the Friday after.
    await completeOccurrence(t, kid, fridays.occId!);
    expect(row('Trash')).toMatchObject({ state: 'waiting', date: '2026-11-27', occurrenceId: null, todoSyncStatus: null });

    t.clock.set(new Date('2026-11-17T12:00:00Z'));
    expect(row('Dishes')).toMatchObject({ state: 'overdue', date: '2026-11-15' });
  });
});

describe('resolveRange', () => {
  it('turns presets into dates, with weeks starting on Sunday', () => {
    expect(resolveRange('this_week', '2026-11-18')).toEqual({ from: '2026-11-15', to: '2026-11-18' });
    expect(resolveRange('this_month', '2026-11-18')).toEqual({ from: '2026-11-01', to: '2026-11-18' });
    expect(resolveRange('last_30_days', '2026-11-18')).toEqual({ from: '2026-10-20', to: '2026-11-18' });
    expect(resolveRange('custom', '2026-11-18', { from: '2026-01-01', to: '2026-01-31' })).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });
});

describe('history', () => {
  async function setUp() {
    const a = await chore('Trash', { assigneeUserId: kid.id, startDate: '2026-11-12' });
    const b = await chore('Dishes', { assigneeUserId: kid.id });
    const c = await chore('Cat', { assigneeUserId: sib.id });
    t.clock.set(new Date('2026-11-15T13:00:00Z'));
    await completeOccurrence(t, kid, a.occId!); // due 11-15, on time
    t.clock.set(new Date('2026-11-16T09:00:00Z'));
    await completeOccurrence(t, admin, b.occId!); // due 11-15, late, checked off by admin
    await skipOccurrence(t, admin, c.occId!);
    return { a, b, c };
  }

  it('lists completions and skips with credit, checker, and lateness, newest first', async () => {
    const { a } = await setUp();
    const h = history(t, q());
    expect(h).toMatchObject({ today: '2026-11-16', from: '2026-10-18', to: '2026-11-16', totals: { completed: 2, late: 1, skipped: 1 } });
    expect(h.entries.map((e) => [e.title, e.state, e.credited?.displayName ?? null, e.closedBy?.displayName, e.late])).toEqual([
      ['Cat', 'skipped', null, 'Admin', false],
      ['Dishes', 'done', 'Kid', 'Admin', true],
      ['Trash', 'done', 'Kid', 'Kid', false],
    ]);
    expect(h.entries.find((e) => e.title === 'Trash')).toMatchObject({ dueDate: '2026-11-15', closedDate: '2026-11-15', assignmentSource: 'admin', canReopen: true });
    expect(history(t, q({ choreId: String(a.chore.id) })).entries.map((e) => e.title)).toEqual(['Trash']);
  });

  it('filters by person and can hide skips while still counting them', async () => {
    await setUp();
    expect(history(t, q({ person: String(kid.id) })).totals).toEqual({ completed: 2, late: 1, skipped: 0 });
    expect(history(t, q({ person: String(admin.id) })).entries).toEqual([]);
    const hidden = history(t, q({ skipped: 'false' }));
    expect(hidden.entries.map((e) => e.state)).toEqual(['done', 'done']);
    expect(hidden.totals.skipped).toBe(1);
  });

  it('filters by the family-local date it was closed', async () => {
    setFamilySettings(t.db, { name: 'Smiths', timeZone: 'America/Los_Angeles' });
    const { occId } = await chore('Trash', { assigneeUserId: kid.id, startDate: '2026-11-15' });
    t.clock.set(new Date('2026-11-16T07:00:00Z')); // 23:00 on 11-15 in Los Angeles
    await completeOccurrence(t, kid, occId!);
    expect(history(t, q({ range: 'custom', from: '2026-11-15', to: '2026-11-15' })).entries.map((e) => e.closedDate)).toEqual(['2026-11-15']);
    expect(history(t, q({ range: 'custom', from: '2026-11-16', to: '2026-11-16' })).entries).toEqual([]);
  });

  it('allows reopening the most recent occurrence of an active chore, or undoing a late close that brought the next one', async () => {
    const { a, b } = await setUp();
    let h = history(t, q());
    // Dishes was done late, so its next occurrence came right away; it's still open and the kid's, so the close can be undone.
    expect(h.entries.find((e) => e.title === 'Dishes')?.canReopen).toBe(true);
    expect(h.entries.find((e) => e.title === 'Trash')?.canReopen).toBe(true);
    t.clock.set(new Date('2026-11-17T12:00:00Z'));
    // Trash was done on time, and the job brought its next one later: that can't be undone.
    const [next] = await generateChores(t, { choreId: a.chore.id });
    expect(history(t, q()).entries.find((e) => e.title === 'Trash')?.canReopen).toBe(false);
    await completeOccurrence(t, kid, next!);
    h = history(t, q());
    expect(h.entries.filter((e) => e.title === 'Trash').map((e) => [e.dueDate, e.canReopen])).toEqual([['2026-11-17', true], ['2026-11-15', false]]);
    await setChoreStatus(t, b.chore.id, 'archived');
    expect(history(t, q()).entries.find((e) => e.title === 'Dishes')?.canReopen).toBe(false);
  });
});
