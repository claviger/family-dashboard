import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../core/clock.js';
import { AppError } from '../../core/errors.js';
import { openDb, type Db } from '../../db/index.js';
import { addUser } from '../../test/helpers.js';
import type { NewTodo } from './backend.js';
import { InternalTodoBackend } from './internalBackend.js';

let db: Db;
let sqlite: Database.Database;
let clock: FakeClock;
let backend: InternalTodoBackend;
let alice: number;
let bob: number;

function newTodo(over: Partial<NewTodo> = {}): NewTodo {
  return { title: 'Buy milk', notes: null, dueDate: null, dueTime: null, createdByUserId: alice, choreOccurrenceId: null, ...over };
}

beforeEach(() => {
  ({ db, sqlite } = openDb(':memory:'));
  clock = new FakeClock(new Date('2026-11-15T12:00:00Z'));
  backend = new InternalTodoBackend({ db, clock });
  alice = addUser(db, clock, { email: 'alice@example.com', displayName: 'Alice' });
  bob = addUser(db, clock, { email: 'bob@example.com', displayName: 'Bob' });
});

async function expectAppError(p: Promise<unknown>, code: string) {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
}

describe('InternalTodoBackend', () => {
  it('creates and reads items', async () => {
    const created = await backend.create(alice, newTodo({ notes: 'Oat', dueDate: '2026-11-16', dueTime: '09:00', choreOccurrenceId: 4 }));
    expect(created).toEqual({
      id: created.id,
      ownerUserId: alice,
      title: 'Buy milk',
      notes: 'Oat',
      dueDate: '2026-11-16',
      dueTime: '09:00',
      completedAt: null,
      createdAt: '2026-11-15T12:00:00.000Z',
      createdByUserId: alice,
      choreOccurrenceId: 4,
      todoistProjectId: null,
      recurring: false,
    });
    expect(await backend.get(alice, created.id)).toEqual(created);
    expect(await backend.listOpen(alice)).toEqual([created]);
  });

  it('stores a null creator for items the system creates', async () => {
    const created = await backend.create(alice, newTodo({ createdByUserId: null }));
    expect(created.createdByUserId).toBeNull();
  });

  it("never shows or changes another owner's items", async () => {
    const mine = await backend.create(alice, newTodo());
    expect(await backend.get(bob, mine.id)).toBeNull();
    expect(await backend.listOpen(bob)).toEqual([]);
    await expectAppError(backend.update(bob, mine.id, { title: 'Hacked' }), 'not_found');
    expect(await backend.complete(bob, mine.id, clock.now())).toBeNull();
    await expectAppError(backend.remove(bob, mine.id), 'not_found');
    expect(await backend.get(alice, mine.id)).toMatchObject({ title: 'Buy milk', completedAt: null });
  });

  it('updates only the given fields', async () => {
    const t = await backend.create(alice, newTodo({ notes: 'Oat', dueDate: '2026-11-16' }));
    const updated = await backend.update(alice, t.id, { title: 'Buy bread' });
    expect(updated).toMatchObject({ title: 'Buy bread', notes: 'Oat', dueDate: '2026-11-16' });
  });

  it('completes and reopens only when the state actually changes', async () => {
    const t = await backend.create(alice, newTodo());
    const first = await backend.complete(alice, t.id, new Date('2026-11-15T10:00:00Z'));
    expect(first?.completedAt).toBe('2026-11-15T10:00:00.000Z');
    expect(await backend.complete(alice, t.id, new Date('2026-11-15T11:00:00Z'))).toBeNull();
    expect((await backend.get(alice, t.id))?.completedAt).toBe('2026-11-15T10:00:00.000Z');
    expect((await backend.reopen(alice, t.id))?.completedAt).toBeNull();
    expect(await backend.reopen(alice, t.id)).toBeNull();
    expect(await backend.complete(alice, 9999, clock.now())).toBeNull();
  });

  it('lists recent completions newest first', async () => {
    const a = await backend.create(alice, newTodo({ title: 'A' }));
    const b = await backend.create(alice, newTodo({ title: 'B' }));
    const old = await backend.create(alice, newTodo({ title: 'Old' }));
    await backend.complete(alice, old.id, new Date('2026-11-01T00:00:00Z'));
    await backend.complete(alice, a.id, new Date('2026-11-15T10:00:00Z'));
    await backend.complete(alice, b.id, new Date('2026-11-15T11:00:00Z'));
    expect(await backend.listOpen(alice)).toEqual([]);
    const recent = await backend.listCompletedSince(alice, new Date('2026-11-08T12:00:00Z'));
    expect(recent.map((i) => i.title)).toEqual(['B', 'A']);
  });

  it('soft-deletes and returns the deleted item', async () => {
    const t = await backend.create(alice, newTodo());
    expect(await backend.remove(alice, t.id)).toEqual(t);
    expect(await backend.get(alice, t.id)).toBeNull();
    expect(await backend.listOpen(alice)).toEqual([]);
    await expectAppError(backend.remove(alice, t.id), 'not_found');
    const row = sqlite.prepare('select deleted_at from todos where id = ?').get(t.id) as { deleted_at: number };
    expect(row.deleted_at).toBe(clock.now().getTime());
  });

  it('rejects a due time without a due date in the database', async () => {
    expect(() =>
      sqlite
        .prepare("insert into todos (owner_user_id, title, due_time, created_at, updated_at) values (?, ?, '09:00', 0, 0)")
        .run(alice, 'No date'),
    ).toThrow(/CHECK constraint failed/);
    const item = await backend.create(alice, newTodo());
    expect(() => sqlite.prepare("update todos set due_time = '09:00' where id = ?").run(item.id)).toThrow(/CHECK constraint failed/);
    const dated = await backend.create(alice, newTodo({ dueDate: '2026-11-16', dueTime: '09:00' }));
    expect(() => sqlite.prepare('update todos set due_date = null where id = ?').run(dated.id)).toThrow(/CHECK constraint failed/);
  });

  it('allows only one live to-do per chore occurrence', async () => {
    const first = await backend.create(alice, newTodo({ choreOccurrenceId: 7 }));
    await expectAppError(backend.create(bob, newTodo({ choreOccurrenceId: 7 })), 'conflict');
    // The database enforces it too, not just the backend.
    expect(() =>
      sqlite
        .prepare('insert into todos (owner_user_id, title, chore_occurrence_id, created_at, updated_at) values (?, ?, ?, 0, 0)')
        .run(alice, 'Dup', 7),
    ).toThrow(/UNIQUE constraint failed/);
    // Ordinary to-dos have no occurrence and aren't limited.
    await backend.create(alice, newTodo());
    await backend.create(alice, newTodo());
    // Once deleted, the occurrence can get a new to-do.
    await backend.remove(alice, first.id);
    const again = await backend.create(alice, newTodo({ choreOccurrenceId: 7 }));
    expect(again.choreOccurrenceId).toBe(7);
  });
});
