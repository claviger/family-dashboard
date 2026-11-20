import { beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '../../../shared/api.js';
import type { Actor, TodoEvent } from '../../core/events.js';
import { AppError } from '../../core/errors.js';
import { setFamilySettings } from '../../settings.js';
import { addUser, makeTestApp, type TestApp } from '../../test/helpers.js';
import { getSummaryView, setSummaryView } from './prefs.js';
import { TodoService } from './service.js';

const SYSTEM: Actor = { type: 'system' };
const TODOIST: Actor = { type: 'todoist' };
const user = (userId: number, role: Role = 'member'): Actor => ({ type: 'user', userId, role });

let t: TestApp;
let svc: TodoService;
let owner: number;
let admin: number;
let me: Actor;
let asAdmin: Actor;

beforeEach(() => {
  // Without the Chores panel's handlers: these chore to-dos point at occurrences that don't exist,
  // which the handlers would treat as orphans and remove.
  t = makeTestApp({ listen: false });
  svc = new TodoService(t);
  owner = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo'] });
  admin = addUser(t.db, t.clock, { email: 'admin@example.com', displayName: 'Admin', role: 'admin', panels: ['todo'] });
  me = user(owner);
  asAdmin = user(admin, 'admin');
});

function recordEvents() {
  const seen: { name: string; e: TodoEvent }[] = [];
  t.events.on('todo.completed', (e) => { seen.push({ name: 'completed', e }); });
  t.events.on('todo.uncompleted', (e) => { seen.push({ name: 'uncompleted', e }); });
  t.events.on('todo.deleted', (e) => { seen.push({ name: 'deleted', e }); });
  return seen;
}

describe('TodoService.today', () => {
  it('uses the family time zone across the UTC date boundary', () => {
    t.clock.set(new Date('2026-11-16T07:30:00Z')); // 23:30 on Nov 15 in Los Angeles
    expect(svc.today()).toBe('2026-11-16');
    setFamilySettings(t.db, { name: 'Smiths', timeZone: 'America/Los_Angeles' });
    expect(svc.today()).toBe('2026-11-15');
  });
});

describe('TodoService.list', () => {
  it('groups by the family-local date', async () => {
    setFamilySettings(t.db, { name: 'Smiths', timeZone: 'America/Los_Angeles' });
    t.clock.set(new Date('2026-11-16T07:30:00Z')); // still Nov 15 locally
    await svc.create(me, owner, { title: 'Due 15th', dueDate: '2026-11-15' });
    await svc.create(me, owner, { title: 'Due 14th', dueDate: '2026-11-14' });
    await svc.create(me, owner, { title: 'Due 16th', dueDate: '2026-11-16' });
    await svc.create(me, owner, { title: 'Someday' });
    const before = await svc.list(owner);
    expect(before.today).toBe('2026-11-15');
    expect(before.groups.overdue.map((i) => i.title)).toEqual(['Due 14th']);
    expect(before.groups.today.map((i) => i.title)).toEqual(['Due 15th']);
    expect(before.groups.upcoming.map((i) => i.title)).toEqual(['Due 16th']);
    expect(before.groups.none.map((i) => i.title)).toEqual(['Someday']);

    t.clock.set(new Date('2026-11-16T08:30:00Z')); // 00:30 on Nov 16 locally
    const after = await svc.list(owner);
    expect(after.groups.overdue.map((i) => i.title)).toEqual(['Due 14th', 'Due 15th']);
    expect(after.groups.today.map((i) => i.title)).toEqual(['Due 16th']);
  });

  it('shows completions from the last 7 days only', async () => {
    const old = await svc.create(me, owner, { title: 'Old' });
    await svc.complete(me, owner, old.id);
    t.clock.advance(7 * 24 * 60 * 60 * 1000 + 1);
    const recent = await svc.create(me, owner, { title: 'Recent' });
    await svc.complete(me, owner, recent.id);
    const list = await svc.list(owner);
    expect(list.completed.map((i) => i.title)).toEqual(['Recent']);
    expect(Object.values(list.groups).flat()).toEqual([]);
  });
});

describe('TodoService.summary', () => {
  it('applies the default view, sorts, and caps at 8 with a count of the rest', async () => {
    await svc.create(me, owner, { title: 'Next week', dueDate: '2026-11-22' });
    for (let i = 1; i <= 8; i++) {
      t.clock.advance(1000);
      await svc.create(me, owner, { title: `Undated ${i}` });
    }
    await svc.create(me, owner, { title: 'Overdue', dueDate: '2026-11-10' });
    await svc.create(me, owner, { title: 'Today 9am', dueDate: '2026-11-15', dueTime: '09:00' });
    const s = await svc.summary(owner);
    expect(s.view).toBe('overdue_today_undated');
    expect(s.today).toBe('2026-11-15');
    expect(s.items.map((i) => i.title)).toEqual([
      'Overdue', 'Today 9am', 'Undated 1', 'Undated 2', 'Undated 3', 'Undated 4', 'Undated 5', 'Undated 6',
    ]);
    expect(s.more).toBe(2);
  });

  it("uses the owner's chosen view and leaves out completed items", async () => {
    await svc.create(me, owner, { title: 'Undated' });
    await svc.create(me, owner, { title: 'In 3 days', dueDate: '2026-11-18' });
    const done = await svc.create(me, owner, { title: 'Done', dueDate: '2026-11-15' });
    await svc.complete(me, owner, done.id);
    setSummaryView(t.db, owner, 'next_7_days');
    const s = await svc.summary(owner);
    expect(s.view).toBe('next_7_days');
    expect(s.items.map((i) => i.title)).toEqual(['In 3 days']);
    expect(s.more).toBe(0);
  });
});

describe('TodoService create and update', () => {
  it('records the creator, normalizes blank notes, and drops a time without a date', async () => {
    const item = await svc.create(user(admin), owner, { title: 'Call Grandma', notes: '   ', dueTime: null });
    expect(item).toMatchObject({ ownerUserId: owner, createdByUserId: admin, notes: null, dueDate: null, dueTime: null, choreOccurrenceId: null });
  });

  it('creates and deletes as the system actor, with no user as creator', async () => {
    const seen = recordEvents();
    const item = await svc.create(SYSTEM, owner, { title: 'Feed the cat' }, { choreOccurrenceId: 12 });
    expect(item).toMatchObject({ ownerUserId: owner, createdByUserId: null, choreOccurrenceId: 12 });
    await svc.delete(SYSTEM, owner, item.id);
    expect((await svc.list(owner)).groups.none).toEqual([]);
    expect(seen.map((s) => [s.name, s.e.actor])).toEqual([['deleted', SYSTEM]]);
  });

  it('refuses a second live to-do for the same chore occurrence', async () => {
    await svc.create(SYSTEM, owner, { title: 'Feed the cat' }, { choreOccurrenceId: 12 });
    const err = await svc.create(SYSTEM, owner, { title: 'Feed the cat' }, { choreOccurrenceId: 12 }).catch((e: unknown) => e);
    expect((err as AppError).code).toBe('conflict');
  });

  it('clears the time when the date is cleared and refuses a time without a date', async () => {
    const item = await svc.create(me, owner, { title: 'Dentist', dueDate: '2026-11-20', dueTime: '15:30' });
    const cleared = await svc.update(me, owner, item.id, { dueDate: null });
    expect(cleared).toMatchObject({ dueDate: null, dueTime: null });
    const err = await svc.update(me, owner, item.id, { dueTime: '10:00' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('validation');
  });

  it("throws not_found for another owner's item", async () => {
    const item = await svc.create(me, owner, { title: 'Mine' });
    for (const p of [
      svc.update(user(admin), admin, item.id, { title: 'x' }),
      svc.complete(user(admin), admin, item.id),
      svc.uncomplete(user(admin), admin, item.id),
      svc.delete(user(admin), admin, item.id),
    ]) {
      expect(((await p.catch((e: unknown) => e)) as AppError).code).toBe('not_found');
    }
  });
});

describe('TodoService chore to-dos', () => {
  it("doesn't let members delete them, even their own", async () => {
    const seen = recordEvents();
    const item = await svc.create(SYSTEM, owner, { title: 'Feed the cat' }, { choreOccurrenceId: 4 });
    const err = await svc.delete(me, owner, item.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('forbidden');
    expect(await svc.get(owner, item.id)).toEqual(item);
    expect(seen).toEqual([]);
  });

  it('lets admins delete them, and members delete ordinary to-dos', async () => {
    const chore = await svc.create(SYSTEM, owner, { title: 'Feed the cat' }, { choreOccurrenceId: 4 });
    await svc.delete(asAdmin, owner, chore.id);
    expect(await svc.get(owner, chore.id)).toBeNull();
    const plain = await svc.create(me, owner, { title: 'Plain' });
    await svc.delete(me, owner, plain.id);
    expect(await svc.get(owner, plain.id)).toBeNull();
  });

  it('finds the live to-do for an occurrence on the given list only', async () => {
    const item = await svc.create(SYSTEM, owner, { title: 'Feed the cat' }, { choreOccurrenceId: 4 });
    expect(await svc.findByChoreOccurrence(owner, 4)).toEqual(item);
    expect(await svc.findByChoreOccurrence(admin, 4)).toBeNull();
    expect(await svc.findByChoreOccurrence(owner, 5)).toBeNull();
    await svc.delete(SYSTEM, owner, item.id);
    expect(await svc.findByChoreOccurrence(owner, 4)).toBeNull();
  });

  it("finds the live to-do for an occurrence on anyone's list", async () => {
    const item = await svc.create(SYSTEM, owner, { title: 'Feed the cat' }, { choreOccurrenceId: 4 });
    expect(await svc.findAnyByChoreOccurrence(4)).toEqual(item);
    expect(await svc.findAnyByChoreOccurrence(5)).toBeNull();
    await svc.delete(SYSTEM, owner, item.id);
    expect(await svc.findAnyByChoreOccurrence(4)).toBeNull();
  });
});

describe('TodoService events', () => {
  it('emits completed, uncompleted, and deleted with the given actor for chore to-dos', async () => {
    const seen = recordEvents();
    const item = await svc.create(SYSTEM, owner, { title: 'Take out trash' }, { choreOccurrenceId: 7 });
    await svc.complete(me, owner, item.id);
    await svc.uncomplete(asAdmin, owner, item.id);
    await svc.complete(SYSTEM, owner, item.id);
    await svc.delete(asAdmin, owner, item.id);
    expect(seen.map((s) => [s.name, s.e.actor, s.e.item.id, s.e.item.choreOccurrenceId])).toEqual([
      ['completed', me, item.id, 7],
      ['uncompleted', asAdmin, item.id, 7],
      ['completed', SYSTEM, item.id, 7],
      ['deleted', asAdmin, item.id, 7],
    ]);
    expect(seen[0]!.e.item.completedAt).toBe('2026-11-15T12:00:00.000Z');
    expect(seen[1]!.e.item.completedAt).toBeNull();
  });

  it('emits nothing for ordinary to-dos or for no-op changes', async () => {
    const seen = recordEvents();
    const plain = await svc.create(me, owner, { title: 'Plain' });
    await svc.complete(me, owner, plain.id);
    await svc.delete(me, owner, plain.id);
    const chore = await svc.create(me, owner, { title: 'Chore' }, { choreOccurrenceId: 3 });
    expect((await svc.uncomplete(me, owner, chore.id)).completedAt).toBeNull(); // already open
    const done = await svc.complete(me, owner, chore.id);
    t.clock.advance(60_000);
    expect(await svc.complete(me, owner, chore.id)).toEqual(done); // already complete: unchanged
    expect(seen.map((s) => s.name)).toEqual(['completed']);
  });

  it('emits once when two completes race', async () => {
    const seen = recordEvents();
    const chore = await svc.create(me, owner, { title: 'Chore' }, { choreOccurrenceId: 3 });
    const [a, b] = await Promise.all([svc.complete(me, owner, chore.id), svc.complete(user(admin), owner, chore.id)]);
    expect(a.completedAt).not.toBeNull();
    expect(b).toEqual(a);
    expect(seen.map((s) => s.name)).toEqual(['completed']);
    const [c, d] = await Promise.all([svc.uncomplete(me, owner, chore.id), svc.uncomplete(me, owner, chore.id)]);
    expect(c.completedAt).toBeNull();
    expect(d.completedAt).toBeNull();
    expect(seen.map((s) => s.name)).toEqual(['completed', 'uncompleted']);
  });

  it('keeps the change when a subscriber fails', async () => {
    t.events.on('todo.completed', () => { throw new Error('chores exploded'); });
    const item = await svc.create(me, owner, { title: 'Chore' }, { choreOccurrenceId: 3 });
    const done = await svc.complete(me, owner, item.id);
    expect(done.completedAt).not.toBeNull();
    expect(t.eventErrors.map((e) => e.event)).toEqual(['todo.completed']);
  });
});

describe('TodoService.applyRemoteChange', () => {
  it('emits events from a before/after diff with the given actor', async () => {
    const seen = recordEvents();
    const open = await svc.create(SYSTEM, owner, { title: 'Water plants' }, { choreOccurrenceId: 5 });
    const done = { ...open, completedAt: '2026-11-15T13:00:00.000Z' };
    await svc.applyRemoteChange(open, done, TODOIST);
    await svc.applyRemoteChange(done, open, TODOIST);
    await svc.applyRemoteChange(open, { ...open, title: 'Water the plants' }, TODOIST); // no completion change
    await svc.applyRemoteChange(null, open, TODOIST); // created remotely: nothing to report
    await svc.applyRemoteChange(open, null, TODOIST);
    expect(seen.map((s) => [s.name, s.e.actor, s.e.item.completedAt])).toEqual([
      ['completed', TODOIST, '2026-11-15T13:00:00.000Z'],
      ['uncompleted', TODOIST, null],
      ['deleted', TODOIST, null],
    ]);
  });

  it('ignores items that are not linked to a chore', async () => {
    const seen = recordEvents();
    const open = await svc.create(me, owner, { title: 'Plain' });
    await svc.applyRemoteChange(open, { ...open, completedAt: '2026-11-15T13:00:00.000Z' }, TODOIST);
    await svc.applyRemoteChange(open, null, TODOIST);
    expect(seen).toEqual([]);
  });
});

describe('summary view prefs', () => {
  it('defaults and saves per user', () => {
    expect(getSummaryView(t.db, owner)).toBe('overdue_today_undated');
    setSummaryView(t.db, owner, 'everything');
    setSummaryView(t.db, owner, 'overdue_today');
    expect(getSummaryView(t.db, owner)).toBe('overdue_today');
    expect(getSummaryView(t.db, admin)).toBe('overdue_today_undated');
  });
});
