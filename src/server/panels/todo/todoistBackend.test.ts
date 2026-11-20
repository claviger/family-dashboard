import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { TodoEvent } from '../../core/events.js';
import { todoistState, todos } from '../../db/schema.js';
import type { FakeAccount } from '../../test/fakeTodoist.js';
import { addUser, linkTodoistForTest, makeTestApp, type TestApp } from '../../test/helpers.js';
import { LIVE_ITEM_NOT_FOUND } from '../../test/todoistFixtures.js';

const KID = { type: 'user', userId: 0, role: 'member' } as const;

async function setup() {
  const t = makeTestApp({ todoist: true, listen: false });
  const kid = addUser(t.db, t.clock, { email: 'kid@example.com', panels: ['todo'] });
  const account = linkTodoistForTest(t, kid);
  const chores = t.fakeTodoist.addProject(account, 'Chores');
  await t.todoist!.requestSync(kid);
  const events: { name: string; e: TodoEvent }[] = [];
  for (const name of ['todo.completed', 'todo.uncompleted', 'todo.deleted'] as const) {
    t.events.on(name, (e) => { events.push({ name, e }); });
  }
  const actor = { ...KID, userId: kid };
  return { t, kid, account, chores, events, actor };
}

function task(account: FakeAccount, content: string) {
  return [...account.items.values()].find((i) => i.content === content && !i.is_deleted);
}

function syncCalls(t: TestApp) {
  return t.fakeTodoist.requests.filter((r) => r.path === '/api/v1/sync').length;
}

function liveRows(t: TestApp, owner: number) {
  return t.db.select().from(todos).where(and(eq(todos.ownerUserId, owner), isNull(todos.deletedAt))).all();
}

/** An open internal row from before linking, waiting to move into Todoist. */
function internalRow(t: TestApp, owner: number, title: string): number {
  const now = t.clock.now();
  return t.db.insert(todos).values({ ownerUserId: owner, backend: 'internal', title, createdAt: now, updatedAt: now }).returning({ id: todos.id }).get().id;
}

describe('TodoistBackend through TodoService', () => {
  it('creates in Todoist first (Inbox, or the chores project for a chore) and mirrors the result', async () => {
    const { t, kid, account, chores, actor } = await setup();
    t.db.update(todoistState).set({ choresProjectId: chores.id }).run();
    const milk = await t.todos.create(actor, kid, { title: 'Milk', notes: 'Oat', dueDate: '2026-11-20', dueTime: '09:30' });
    expect(milk).toMatchObject({ title: 'Milk', notes: 'Oat', dueDate: '2026-11-20', dueTime: '09:30', todoistProjectId: account.inboxId, recurring: false });
    expect(task(account, 'Milk')).toMatchObject({ project_id: account.inboxId, description: 'Oat', due: expect.objectContaining({ date: '2026-11-20T09:30:00' }) });
    const chore = await t.todos.create({ type: 'system' }, kid, { title: 'Feed cat' }, { choreOccurrenceId: 5 });
    expect(task(account, 'Feed cat')!.project_id).toBe(chores.id);
    expect(chore).toMatchObject({ choreOccurrenceId: 5, todoistProjectId: chores.id, createdByUserId: null });
    // A second to-do for the same occurrence is refused before anything is sent to Todoist.
    const calls = syncCalls(t);
    await expect(t.todos.create({ type: 'system' }, kid, { title: 'Feed cat' }, { choreOccurrenceId: 5 })).rejects.toMatchObject({ code: 'conflict' });
    expect(syncCalls(t)).toBe(calls);
  });

  it('reads from the mirror without calling Todoist', async () => {
    const { t, kid, actor } = await setup();
    const item = await t.todos.create(actor, kid, { title: 'Milk' }, { choreOccurrenceId: 9 });
    const calls = t.fakeTodoist.requests.length;
    expect(await t.todos.get(kid, item.id)).toEqual(item);
    expect(await t.todos.findByChoreOccurrence(kid, 9)).toEqual(item);
    expect(await t.todos.findAnyByChoreOccurrence(9)).toEqual(item);
    expect((await t.todos.list(kid)).groups.none).toEqual([item]);
    expect(t.fakeTodoist.requests.length).toBe(calls);
  });

  it('updates only what changed, and clears a due date with due: null', async () => {
    const { t, kid, account, actor } = await setup();
    const item = await t.todos.create(actor, kid, { title: 'Milk', dueDate: '2026-11-20' });
    await t.todos.update(actor, kid, item.id, { title: 'Oat milk', dueDate: '2026-11-20' });
    const cmd = JSON.parse(t.fakeTodoist.requests.at(-1)!.fields.commands!)[0];
    expect(cmd.args).toEqual({ id: task(account, 'Oat milk')!.id, content: 'Oat milk' });
    const cleared = await t.todos.update(actor, kid, item.id, { dueDate: null });
    expect(cleared).toMatchObject({ dueDate: null, dueTime: null });
    expect(task(account, 'Oat milk')!.due).toBeNull();
    const calls = syncCalls(t);
    await t.todos.update(actor, kid, item.id, { title: 'Oat milk' });
    expect(syncCalls(t)).toBe(calls);
  });

  it("refuses to change a repeating task's date, but lets its title change", async () => {
    const { t, kid, account } = await setup();
    t.fakeTodoist.addTask(account, { content: 'Water plants', due: { date: '2026-11-16', timezone: null, is_recurring: true, string: 'every day' } });
    await t.todoist!.requestSync(kid);
    const row = liveRows(t, kid).find((r) => r.title === 'Water plants')!;
    const actor = { type: 'user', userId: kid, role: 'member' } as const;
    await expect(t.todos.update(actor, kid, row.id, { dueDate: '2026-11-18' })).rejects.toMatchObject({ code: 'validation' });
    await expect(t.todos.update(actor, kid, row.id, { title: 'Water the plants', dueDate: '2026-11-16' })).resolves.toMatchObject({ title: 'Water the plants', recurring: true });
  });

  it('completes and reopens, emitting one event each for chore to-dos, decided from the mirror', async () => {
    const { t, kid, account, events, actor } = await setup();
    const item = await t.todos.create({ type: 'system' }, kid, { title: 'Feed cat' }, { choreOccurrenceId: 3 });
    const done = await t.todos.complete(actor, kid, item.id);
    expect(done.completedAt).not.toBeNull();
    expect(task(account, 'Feed cat')!.checked).toBe(true);
    // Already complete: nothing is sent (Todoist would answer "ok" and change nothing).
    const calls = syncCalls(t);
    await t.todos.complete(actor, kid, item.id);
    expect(syncCalls(t)).toBe(calls);
    const open = await t.todos.uncomplete(actor, kid, item.id);
    expect(open.completedAt).toBeNull();
    expect(events.map((e) => [e.name, e.e.actor.type])).toEqual([['todo.completed', 'user'], ['todo.uncompleted', 'user']]);
  });

  it('completing a repeating task moves its date and leaves it open, with no event', async () => {
    const { t, kid, account, events } = await setup();
    t.fakeTodoist.addTask(account, { content: 'Water plants', due: { date: '2026-11-16', timezone: null, is_recurring: true, string: 'every day' } });
    await t.todoist!.requestSync(kid);
    const row = liveRows(t, kid).find((r) => r.title === 'Water plants')!;
    t.db.update(todos).set({ choreOccurrenceId: 8 }).where(eq(todos.id, row.id)).run();
    const after = await t.todos.complete({ type: 'user', userId: kid, role: 'member' }, kid, row.id);
    expect(after).toMatchObject({ id: row.id, completedAt: null, dueDate: '2026-11-17', recurring: true });
    expect(events).toEqual([]);
  });

  it('deletes in Todoist; a task already gone there counts as deleted', async () => {
    const { t, kid, account, events, actor } = await setup();
    const a = await t.todos.create(actor, kid, { title: 'A' }, { choreOccurrenceId: 1 });
    await t.todos.delete({ type: 'system' }, kid, a.id);
    expect(task(account, 'A')).toBeUndefined();
    const b = await t.todos.create(actor, kid, { title: 'B' }, { choreOccurrenceId: 2 });
    t.fakeTodoist.change(account, task(account, 'B')!.id, { is_deleted: true });
    await t.todos.delete({ type: 'system' }, kid, b.id);
    expect(liveRows(t, kid)).toEqual([]);
    // B's deletion in Todoist came first, and the failed command doesn't hide it, so it's reported
    // as Todoist's; the dashboard's delete then succeeds too. Handlers re-read state, so the second
    // event changes nothing.
    expect(events.map((e) => [e.name, e.e.item.title, e.e.actor.type])).toEqual([
      ['todo.deleted', 'A', 'system'],
      ['todo.deleted', 'B', 'todoist'],
      ['todo.deleted', 'B', 'system'],
    ]);
  });

  it("completing a task that's gone in Todoist is not_found, and its removal is reported as a Todoist change", async () => {
    const { t, kid, account, events, actor } = await setup();
    const item = await t.todos.create(actor, kid, { title: 'Gone' }, { choreOccurrenceId: 4 });
    // Deleted in Todoist, and no sync has seen it yet.
    t.fakeTodoist.vanish(task(account, 'Gone')!.id);
    await expect(t.todos.complete(actor, kid, item.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(liveRows(t, kid)).toEqual([]);
    expect(events.map((e) => [e.name, e.e.actor.type])).toEqual([['todo.deleted', 'todoist']]);
  });

  it('treats an item_add that fails with ITEM_NOT_FOUND as refused, never as a 500', async () => {
    const { t, kid, actor } = await setup();
    // E.g. the project it was sent to is gone; there's no task for "not found" to be about.
    t.fakeTodoist.commandErrors.set('item_add', LIVE_ITEM_NOT_FOUND);
    await expect(t.todos.create(actor, kid, { title: 'Milk' })).rejects.toMatchObject({ code: 'integration_unavailable', message: "Todoist didn't accept that change." });
    t.fakeTodoist.commandErrors.set('item_add', LIVE_ITEM_NOT_FOUND);
    await expect(t.todos.create({ type: 'system' }, kid, { title: 'Feed cat' }, { choreOccurrenceId: 30 })).rejects.toMatchObject({ code: 'integration_unavailable' });
    const id = internalRow(t, kid, 'From before');
    t.fakeTodoist.commandErrors.set('item_add', LIVE_ITEM_NOT_FOUND);
    await expect(t.todoist!.migrate(kid)).resolves.toEqual({ moved: 0, waiting: 0 });
    expect(liveRows(t, kid)).toEqual([expect.objectContaining({ id, backend: 'internal', todoistMoveError: 'ITEM_NOT_FOUND' })]);
  });

  it('reports a deletion in Todoist once, when a write finds the task gone and the same response lists it deleted', async () => {
    const { t, kid, account, events, actor } = await setup();
    const item = await t.todos.create(actor, kid, { title: 'Gone' }, { choreOccurrenceId: 31 });
    t.fakeTodoist.change(account, task(account, 'Gone')!.id, { is_deleted: true });
    await expect(t.todos.complete(actor, kid, item.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(events.map((e) => [e.name, e.e.actor.type])).toEqual([['todo.deleted', 'todoist']]);
  });

  it('decides what closing did from the response: a task made repeating in Todoist moves on, with no event', async () => {
    const { t, kid, account, events, actor } = await setup();
    const item = await t.todos.create({ type: 'system' }, kid, { title: 'Water plants', dueDate: '2026-11-16' }, { choreOccurrenceId: 32 });
    // Made repeating in Todoist; the mirror hasn't heard yet.
    t.fakeTodoist.change(account, task(account, 'Water plants')!.id, { due: { date: '2026-11-16', timezone: null, is_recurring: true, string: 'every day' } });
    const after = await t.todos.complete(actor, kid, item.id);
    expect(after).toMatchObject({ id: item.id, completedAt: null, dueDate: '2026-11-17', recurring: true });
    expect(events).toEqual([]);
  });

  it('decides what closing did from the response: a task no longer repeating in Todoist completes, with one event', async () => {
    const { t, kid, account, events, actor } = await setup();
    const water = t.fakeTodoist.addTask(account, { content: 'Water plants', due: { date: '2026-11-16', timezone: null, is_recurring: true, string: 'every day' } });
    await t.todoist!.requestSync(kid);
    const row = liveRows(t, kid).find((r) => r.title === 'Water plants')!;
    t.db.update(todos).set({ choreOccurrenceId: 33 }).where(eq(todos.id, row.id)).run();
    t.fakeTodoist.change(account, water.id, { due: { date: '2026-11-16', timezone: null, is_recurring: false, string: '2026-11-16' } });
    const after = await t.todos.complete(actor, kid, row.id);
    expect(after.completedAt).not.toBeNull();
    expect(events.map((e) => [e.name, e.e.actor.type])).toEqual([['todo.completed', 'user']]);
  });

  it("completes a task's subtasks with it, as Todoist does", async () => {
    const { t, kid, account, actor } = await setup();
    const parent = t.fakeTodoist.addTask(account, { content: 'Pack' });
    t.fakeTodoist.addTask(account, { content: 'Socks', parent_id: parent.id });
    await t.todoist!.requestSync(kid);
    const row = liveRows(t, kid).find((r) => r.title === 'Pack')!;
    await t.todos.complete(actor, kid, row.id);
    expect(liveRows(t, kid).map((r) => [r.title, r.completedAt !== null]).sort()).toEqual([['Pack', true], ['Socks', true]]);
  });

  it('changes nothing locally when the write fails', async () => {
    const { t, kid, actor } = await setup();
    const item = await t.todos.create(actor, kid, { title: 'Milk' });
    t.fakeTodoist.failures.push({ path: 'sync', status: 503 });
    await expect(t.todos.update(actor, kid, item.id, { title: 'Bread' })).rejects.toMatchObject({ code: 'integration_unavailable', message: "Couldn't reach Todoist. Try again in a few minutes." });
    t.fakeTodoist.commandErrors.set('item_close', { error_tag: 'INVALID_ARGUMENT_VALUE', error_code: 20, error: 'Invalid argument value', http_code: 400 });
    await expect(t.todos.complete(actor, kid, item.id)).rejects.toMatchObject({ code: 'integration_unavailable', message: "Todoist didn't accept that change." });
    expect(await t.todos.get(kid, item.id)).toEqual(item);
  });

  it('a write that waited out an unlink goes to the dashboard list instead of failing', async () => {
    const { t, kid, actor } = await setup();
    const milk = await t.todos.create(actor, kid, { title: 'Milk' });
    const eggs = await t.todos.create(actor, kid, { title: 'Eggs' });
    // The unlink holds the person's lock while it revokes; the writes queue behind it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const revoke = t.todoist!.client.revoke.bind(t.todoist!.client);
    t.todoist!.client.revoke = (...args) => gate.then(() => revoke(...args));
    const unlinking = t.todoist!.unlink(kid);
    const writes = Promise.all([
      t.todos.complete(actor, kid, milk.id),
      t.todos.create(actor, kid, { title: 'Bread' }),
      t.todos.update(actor, kid, eggs.id, { title: 'Brown eggs' }),
    ]);
    release();
    await unlinking;
    const [completed, created, updated] = await writes;
    expect(completed).toMatchObject({ id: milk.id, completedAt: expect.any(String) });
    expect(updated).toMatchObject({ id: eggs.id, title: 'Brown eggs' });
    const rows = liveRows(t, kid).sort((a, b) => a.id - b.id);
    expect(rows.map((r) => [r.title, r.backend])).toEqual([['Milk', 'internal'], ['Brown eggs', 'internal'], ['Bread', 'internal']]);
    expect(created.id).toBe(rows[2]!.id);
  });

  it("reports other tasks' changes from the same response with the todoist actor, but not the written one", async () => {
    const { t, kid, account, events, actor } = await setup();
    const mine = await t.todos.create(actor, kid, { title: 'Mine' }, { choreOccurrenceId: 1 });
    const other = await t.todos.create({ type: 'system' }, kid, { title: 'Other' }, { choreOccurrenceId: 2 });
    t.fakeTodoist.close(account, task(account, 'Other')!.id);
    await t.todos.complete(actor, kid, mine.id);
    expect(events.map((e) => [e.name, e.e.item.id, e.e.actor.type])).toEqual([
      ['todo.completed', other.id, 'todoist'],
      ['todo.completed', mine.id, 'user'],
    ]);
  });

  it('moves an open internal row into Todoist on its first write, keeping its id', async () => {
    const { t, kid, account, actor } = await setup();
    const now = t.clock.now();
    const { id } = t.db.insert(todos).values({ ownerUserId: kid, backend: 'internal', title: 'From before', choreOccurrenceId: 6, createdAt: now, updatedAt: now }).returning({ id: todos.id }).get();
    await t.todos.complete(actor, kid, id);
    expect(liveRows(t, kid)).toEqual([expect.objectContaining({ id, backend: 'todoist', todoistTaskId: expect.any(String) })]);
    expect(task(account, 'From before')!.checked).toBe(true);
    expect([...account.items.values()].filter((i) => i.content === 'From before')).toHaveLength(1);
  });

  it('never creates a second task when a move is retried after its response was lost', async () => {
    for (const omitReplayMappings of [false, true]) {
      const { t, kid, account, actor } = await setup();
      t.fakeTodoist.omitReplayMappings = omitReplayMappings;
      const now = t.clock.now();
      const { id } = t.db.insert(todos).values({ ownerUserId: kid, backend: 'internal', title: 'From before', createdAt: now, updatedAt: now }).returning({ id: todos.id }).get();
      t.fakeTodoist.loseNextResponse = true;
      await expect(t.todos.update(actor, kid, id, { notes: 'x' })).rejects.toMatchObject({ code: 'integration_unavailable' });
      // A sync in between mirrors the task as a row of its own; the retry recognizes it.
      t.clock.advance(60_000);
      await t.todoist!.requestSync(kid);
      await t.todos.update(actor, kid, id, { notes: 'x' });
      expect([...account.items.values()].filter((i) => i.content === 'From before')).toHaveLength(1);
      expect(liveRows(t, kid)).toEqual([expect.objectContaining({ id, backend: 'todoist', notes: 'x' })]);
    }
  });

  describe('a move whose response was lost, replayed without a temp_id_mapping', () => {
    async function lostMove(title: string) {
      const s = await setup();
      s.t.fakeTodoist.omitReplayMappings = true;
      const id = internalRow(s.t, s.kid, title);
      s.t.clock.advance(60_000);
      s.t.fakeTodoist.loseNextResponse = true;
      await expect(s.t.todos.update(s.actor, s.kid, id, { notes: 'x' })).rejects.toMatchObject({ code: 'integration_unavailable' });
      s.t.clock.advance(60_000);
      return { ...s, id };
    }

    it("never claims the person's own task with the same title, which was mirrored before the move", async () => {
      const { t, kid, account, actor } = await setup();
      t.fakeTodoist.omitReplayMappings = true;
      const own = t.fakeTodoist.addTask(account, { content: 'Milk' });
      await t.todoist!.requestSync(kid);
      const ownRow = liveRows(t, kid).find((r) => r.todoistTaskId === own.id)!;
      const id = internalRow(t, kid, 'Milk');
      t.clock.advance(60_000);
      t.fakeTodoist.loseNextResponse = true;
      await expect(t.todos.update(actor, kid, id, { notes: 'x' })).rejects.toMatchObject({ code: 'integration_unavailable' });
      t.clock.advance(60_000);
      // The replay's own response is the first to list the task the lost move made, so there's no
      // copy to claim yet: the person's own Milk mustn't be taken for it.
      await expect(t.todos.update(actor, kid, id, { notes: 'x' })).rejects.toMatchObject({ code: 'integration_unavailable' });
      expect(liveRows(t, kid).find((r) => r.id === ownRow.id)).toMatchObject({ todoistTaskId: own.id });
      t.clock.advance(60_000);
      await t.todos.update(actor, kid, id, { notes: 'x' });
      const moved = liveRows(t, kid).find((r) => r.id === id)!;
      expect(moved).toMatchObject({ backend: 'todoist', notes: 'x' });
      expect(moved.todoistTaskId).not.toBe(own.id);
      expect(liveRows(t, kid).find((r) => r.id === ownRow.id)).toMatchObject({ todoistTaskId: own.id, notes: null });
      expect([...account.items.values()].filter((i) => i.content === 'Milk' && !i.is_deleted)).toHaveLength(2);
    });

    it('keeps the row on the dashboard after 3 replays that settle nothing, instead of failing every write', async () => {
      const { t, kid, account, actor, id } = await lostMove('Lost for good');
      // The task the lost move made is gone before any sync saw it, so no replay can find it.
      t.fakeTodoist.vanish(task(account, 'Lost for good')!.id);
      for (let i = 0; i < 2; i++) {
        await expect(t.todos.update(actor, kid, id, { notes: 'x' })).rejects.toMatchObject({ code: 'integration_unavailable' });
      }
      await expect(t.todos.update(actor, kid, id, { notes: 'local now' })).resolves.toMatchObject({ notes: 'local now' });
      expect(liveRows(t, kid)).toEqual([expect.objectContaining({ id, backend: 'internal', todoistMoveError: 'unconfirmed' })]);
      expect(t.todoist!.waitingToMove(kid)).toBe(0);
      const calls = syncCalls(t);
      await t.todos.complete(actor, kid, id);
      expect(syncCalls(t)).toBe(calls);
    });

    it("carries over the completion of the copy it claims", async () => {
      const { t, kid, account, id } = await lostMove('Done meanwhile');
      t.fakeTodoist.close(account, task(account, 'Done meanwhile')!.id);
      await t.todoist!.requestSync(kid); // mirrors the copy, completed
      t.clock.advance(60_000);
      // Only the move, so nothing else brings the item back.
      await t.todoist!.migrate(kid);
      expect(liveRows(t, kid)).toEqual([expect.objectContaining({ id, backend: 'todoist', completedAt: expect.any(Date) })]);
    });

    it('deleting the row replays the move and deletes the task it made in Todoist', async () => {
      const { t, kid, account, id } = await lostMove('Delete me');
      t.fakeTodoist.omitReplayMappings = false;
      await t.todos.delete({ type: 'system' }, kid, id);
      expect(liveRows(t, kid)).toEqual([]);
      expect(task(account, 'Delete me')).toBeUndefined();
    });

    it("deleting the row still works when the replay can't find the task", async () => {
      const { t, kid, account, id } = await lostMove('Orphaned');
      await t.todos.delete({ type: 'system' }, kid, id);
      // The possible orphan is logged. The replay's response listed the task the lost move made,
      // so it shows up as a to-do of its own, which the person can delete.
      const orphan = task(account, 'Orphaned')!;
      expect(liveRows(t, kid)).toEqual([expect.objectContaining({ backend: 'todoist', todoistTaskId: orphan.id, title: 'Orphaned' })]);
      expect(liveRows(t, kid).some((r) => r.id === id)).toBe(false);
    });
  });

  it("reports a completion made in Todoist while a title edit was out, even though it's the edited row", async () => {
    const { t, kid, account, events, actor } = await setup();
    const item = await t.todos.create({ type: 'system' }, kid, { title: 'Feed cat' }, { choreOccurrenceId: 7 });
    t.fakeTodoist.close(account, task(account, 'Feed cat')!.id);
    const after = await t.todos.update(actor, kid, item.id, { title: 'Feed the cat' });
    expect(after).toMatchObject({ title: 'Feed the cat', completedAt: expect.any(String) });
    expect(events.map((e) => [e.name, e.e.actor.type])).toEqual([['todo.completed', 'todoist']]);
  });

  it('never creates a second chore task when a create is retried after its response was lost', async () => {
    for (const omitReplayMappings of [false, true]) {
      const { t, kid, account } = await setup();
      t.fakeTodoist.omitReplayMappings = omitReplayMappings;
      t.fakeTodoist.loseNextResponse = true;
      const system = { type: 'system' } as const;
      await expect(t.todos.create(system, kid, { title: 'Feed cat' }, { choreOccurrenceId: 11 })).rejects.toMatchObject({ code: 'integration_unavailable' });
      // A sync in between mirrors the task the lost create made, as a row of its own.
      t.clock.advance(60_000);
      await t.todoist!.requestSync(kid);
      const again = await t.todos.create(system, kid, { title: 'Feed cat' }, { choreOccurrenceId: 11 });
      expect([...account.items.values()].filter((i) => i.content === 'Feed cat')).toHaveLength(1);
      expect(liveRows(t, kid)).toEqual([expect.objectContaining({ id: again.id, choreOccurrenceId: 11, todoistTaskId: task(account, 'Feed cat')!.id })]);
    }
  });

  describe('a lost chore create in a chores project outside the Inbox, replayed without a mapping', () => {
    const system = { type: 'system' } as const;
    const feedCat = (dueDate: string) => ({ title: 'Feed cat', dueDate });

    /** Chore creates whose responses are lost, one per occurrence, with Todoist's replays answering without a mapping. */
    async function lostCreates(occurrences: [number, string][]) {
      const s = await setup();
      s.t.todoist!.setChoresProject(s.kid, s.chores.id);
      s.t.fakeTodoist.omitReplayMappings = true;
      for (const [occ, due] of occurrences) {
        s.t.fakeTodoist.loseNextResponse = true;
        await expect(s.t.todos.create(system, s.kid, feedCat(due), { choreOccurrenceId: occ })).rejects.toMatchObject({ code: 'integration_unavailable' });
      }
      s.t.clock.advance(60_000);
      return s;
    }

    function feedCats(account: FakeAccount) {
      return [...account.items.values()].filter((i) => i.content === 'Feed cat' && !i.is_deleted);
    }

    it('claims the task it made by looking it up in the chores project, when a sync in between left it out (the usual case)', async () => {
      const { t, kid, account, chores } = await lostCreates([[11, '2026-11-15']]);
      // The lost create's own webhook sync: it lists the task, outside the Inbox and not linked yet, so it's left out.
      await t.todoist!.requestSync(kid);
      t.clock.advance(5 * 60_000);
      const lookups = () => t.fakeTodoist.requests.filter((r) => r.path === '/api/v1/tasks').length;
      const before = lookups();
      const again = await t.todos.create(system, kid, feedCat('2026-11-15'), { choreOccurrenceId: 11 });
      expect(lookups()).toBe(before + 1);
      expect(feedCats(account)).toHaveLength(1);
      expect(liveRows(t, kid)).toEqual([expect.objectContaining({ id: again.id, choreOccurrenceId: 11, todoistTaskId: feedCats(account)[0]!.id, todoistProjectId: chores.id })]);
    });

    it('claims it the same way when no sync ran in between', async () => {
      const { t, kid, account } = await lostCreates([[11, '2026-11-15']]);
      const again = await t.todos.create(system, kid, feedCat('2026-11-15'), { choreOccurrenceId: 11 });
      expect(feedCats(account)).toHaveLength(1);
      expect(liveRows(t, kid)).toEqual([expect.objectContaining({ id: again.id, todoistTaskId: feedCats(account)[0]!.id })]);
    });

    it("claims nothing when the person's own task matches too: two matches are ambiguous", async () => {
      const { t, kid, account, chores } = await lostCreates([[11, '2026-11-15']]);
      await t.todoist!.requestSync(kid);
      // The person adds their own "Feed cat" to the chores project, for the same day, after the lost create.
      const own = t.fakeTodoist.addTask(account, { content: 'Feed cat', project_id: chores.id, due: { date: '2026-11-15', timezone: null, is_recurring: false, string: '' } });
      t.clock.advance(5 * 60_000);
      await expect(t.todos.create(system, kid, feedCat('2026-11-15'), { choreOccurrenceId: 11 })).rejects.toMatchObject({ code: 'integration_unavailable' });
      expect(liveRows(t, kid)).toEqual([]);
      expect(feedCats(account)).toHaveLength(2); // nothing made, nothing claimed
      expect(account.items.get(own.id)).toMatchObject({ checked: false, is_deleted: false });
    });

    it('tells two lost creates for occurrences of the same chore apart by their due dates', async () => {
      const { t, kid, account } = await lostCreates([[11, '2026-11-15'], [12, '2026-11-16']]);
      await t.todoist!.requestSync(kid);
      t.clock.advance(5 * 60_000);
      const first = await t.todos.create(system, kid, feedCat('2026-11-15'), { choreOccurrenceId: 11 });
      const second = await t.todos.create(system, kid, feedCat('2026-11-16'), { choreOccurrenceId: 12 });
      expect(feedCats(account)).toHaveLength(2);
      const byDue = new Map(feedCats(account).map((i) => [i.due!.date, i.id]));
      expect(liveRows(t, kid).map((r) => [r.id, r.choreOccurrenceId, r.todoistTaskId]).sort()).toEqual([
        [first.id, 11, byDue.get('2026-11-15')],
        [second.id, 12, byDue.get('2026-11-16')],
      ].sort());
    });
  });

  it("never claims the person's own task with a chore's title when a chore create is replayed without a mapping", async () => {
    const { t, kid, account } = await setup();
    t.fakeTodoist.omitReplayMappings = true;
    const own = t.fakeTodoist.addTask(account, { content: 'Feed cat' });
    await t.todoist!.requestSync(kid);
    t.clock.advance(60_000);
    const system = { type: 'system' } as const;
    t.fakeTodoist.loseNextResponse = true;
    await expect(t.todos.create(system, kid, { title: 'Feed cat' }, { choreOccurrenceId: 13 })).rejects.toMatchObject({ code: 'integration_unavailable' });
    t.clock.advance(60_000);
    await expect(t.todos.create(system, kid, { title: 'Feed cat' }, { choreOccurrenceId: 13 })).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(liveRows(t, kid).find((r) => r.todoistTaskId === own.id)).toMatchObject({ choreOccurrenceId: null });
    t.clock.advance(60_000);
    const chore = await t.todos.create(system, kid, { title: 'Feed cat' }, { choreOccurrenceId: 13 });
    expect(liveRows(t, kid).find((r) => r.id === chore.id)!.todoistTaskId).not.toBe(own.id);
    expect(liveRows(t, kid).find((r) => r.todoistTaskId === own.id)).toMatchObject({ choreOccurrenceId: null });
  });

  it("a chore's next to-do after a deletion is a new task, not a replay of the old one", async () => {
    const { t, kid, account } = await setup();
    const system = { type: 'system' } as const;
    const first = await t.todos.create(system, kid, { title: 'Feed cat' }, { choreOccurrenceId: 12 });
    await t.todos.delete(system, kid, first.id);
    await t.todos.create(system, kid, { title: 'Feed cat' }, { choreOccurrenceId: 12 });
    expect([...account.items.values()].filter((i) => i.content === 'Feed cat' && !i.is_deleted)).toHaveLength(1);
    expect([...account.items.values()].filter((i) => i.content === 'Feed cat')).toHaveLength(2);
  });

  it("gives each install its own command uuids, so a second install linked to the same account doesn't replay the first's", async () => {
    // Same user ids, connection ids, row ids, and occurrence ids in both databases.
    const a = makeTestApp({ todoist: true, listen: false });
    const b = makeTestApp({ todoist: true, listen: false, fakeTodoist: a.fakeTodoist });
    const account = a.fakeTodoist.createAccount();
    for (const [t, name] of [[a, 'A'], [b, 'B']] as const) {
      const kid = addUser(t.db, t.clock, { email: 'kid@example.com', panels: ['todo'] });
      linkTodoistForTest(t, kid, account);
      const now = t.clock.now();
      t.db.insert(todos).values({ ownerUserId: kid, backend: 'internal', title: `Moved from ${name}`, createdAt: now, updatedAt: now }).run();
      await t.todoist!.migrate(kid);
      await t.todos.create({ type: 'system' }, kid, { title: `Chore from ${name}` }, { choreOccurrenceId: 5 });
    }
    expect([...account.items.values()].map((i) => i.content).sort()).toEqual(['Chore from A', 'Chore from B', 'Moved from A', 'Moved from B']);
  });

  it('gives a row id reused after a restore a new command uuid, because its createdAt differs', async () => {
    const { t, kid, account } = await setup();
    const insert = (title: string) => {
      const now = t.clock.now();
      return t.db.insert(todos).values({ ownerUserId: kid, backend: 'internal', title, createdAt: now, updatedAt: now }).returning({ id: todos.id }).get().id;
    };
    const first = insert('Before the restore');
    await t.todoist!.migrate(kid);
    // A backup from before that row existed: the row is gone and its id is handed out again.
    t.sqlite.exec(`delete from todos where id = ${first}; update sqlite_sequence set seq = seq - 1 where name = 'todos'`);
    t.clock.advance(60_000);
    expect(insert('After the restore')).toBe(first);
    await t.todoist!.migrate(kid);
    expect(task(account, 'After the restore')).toBeDefined();
  });

  it("leaves a shared project's tasks out of each member's mirror, except a member's own chore to-do there", async () => {
    const { t, kid, account, actor } = await setup();
    const sib = addUser(t.db, t.clock, { email: 'sib@example.com', panels: ['todo'] });
    const sibAccount = linkTodoistForTest(t, sib);
    const family = t.fakeTodoist.addProject(account, 'Family');
    t.fakeTodoist.share(family, sibAccount);
    t.fakeTodoist.addTask(account, { content: 'Take out bins', project_id: family.id });
    await t.todoist!.requestSync(kid);
    // The kid's chore to-dos go to the shared project, so the sibling's Todoist has them too.
    t.todoist!.setChoresProject(kid, family.id);
    await t.todos.create(actor, kid, { title: 'Feed the cat' }, { choreOccurrenceId: 21 });
    t.clock.advance(60_000);
    await t.todoist!.requestSync(kid);
    await t.todoist!.requestSync(sib);
    expect(task(account, 'Feed the cat')).toMatchObject({ project_id: family.id });
    expect(liveRows(t, kid).map((r) => [r.title, r.choreOccurrenceId])).toEqual([['Feed the cat', 21]]);
    // Neither is in the sibling's Inbox, and the chore to-do isn't the sibling's.
    expect(liveRows(t, sib)).toEqual([]);
  });

  it("keeps a fixed-timezone task's zone when its time is edited here", async () => {
    const { t, kid, account, actor } = await setup();
    t.fakeTodoist.addTask(account, { content: 'Call Madrid', due: { date: '2026-11-20T15:00:00Z', timezone: 'Europe/Madrid', is_recurring: false, string: '' } });
    await t.todoist!.requestSync(kid);
    const row = liveRows(t, kid).find((r) => r.title === 'Call Madrid')!;
    expect(row).toMatchObject({ dueTime: '15:00', todoistDueTimezone: 'Europe/Madrid' }); // the test family is in UTC
    await t.todos.update(actor, kid, row.id, { dueTime: '16:30' });
    expect(task(account, 'Call Madrid')!.due).toMatchObject({ date: '2026-11-20T16:30:00Z', timezone: 'Europe/Madrid' });
  });

  it('keeps a to-do Todoist refuses to take on the dashboard, and changes it locally from then on', async () => {
    const { t, kid, actor } = await setup();
    const now = t.clock.now();
    const { id } = t.db.insert(todos).values({ ownerUserId: kid, backend: 'internal', title: 'Too odd', createdAt: now, updatedAt: now }).returning({ id: todos.id }).get();
    t.fakeTodoist.commandErrors.set('item_add', { error_tag: 'INVALID_ARGUMENT_VALUE', error_code: 20, error: 'Invalid argument value', http_code: 400 });
    const done = await t.todos.complete(actor, kid, id);
    expect(done.completedAt).not.toBeNull();
    expect(liveRows(t, kid)).toEqual([expect.objectContaining({ id, backend: 'internal', todoistMoveError: 'INVALID_ARGUMENT_VALUE' })]);
    const calls = syncCalls(t);
    await t.todos.uncomplete(actor, kid, id);
    await t.todos.update(actor, kid, id, { title: 'Still odd' });
    expect(syncCalls(t)).toBe(calls);
  });
});
