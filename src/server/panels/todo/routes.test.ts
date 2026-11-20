import { beforeEach, describe, expect, it } from 'vitest';
import type { TodoItem, TodoListResponse, TodoPerson, TodoSummaryResponse } from '../../../shared/todo.js';
import { updateUser } from '../../admin/users.js';
import { addUser, call, cookieFor, makeTestApp, type TestApp } from '../../test/helpers.js';

let t: TestApp;
let adminId: number;
let admin: string;
let kidId: number;
let kid: string;
let otherKidId: number;
let otherKid: string;
let noTodoId: number;

beforeEach(() => {
  t = makeTestApp();
  adminId = addUser(t.db, t.clock, { email: 'admin@example.com', displayName: 'Admin', role: 'admin', panels: ['todo'] });
  admin = cookieFor(t.db, t.clock, adminId);
  kidId = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo'] });
  kid = cookieFor(t.db, t.clock, kidId);
  otherKidId = addUser(t.db, t.clock, { email: 'other@example.com', displayName: 'Other', panels: ['todo'] });
  otherKid = cookieFor(t.db, t.clock, otherKidId);
  noTodoId = addUser(t.db, t.clock, { email: 'chores@example.com', displayName: 'Chores only', panels: ['chores'] });
});

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

async function add(cookie: string, body: unknown, query = ''): Promise<TodoItem> {
  const res = await call(t.app, 'POST', `/api/panels/todo/items${query}`, { cookie, body });
  expect(res.status).toBe(201);
  return json<TodoItem>(res);
}

describe('to-do API: own list', () => {
  it('creates, lists, updates, completes, reopens, and deletes', async () => {
    const created = await add(kid, { title: 'Homework', dueDate: '2026-11-15', dueTime: '17:00', notes: 'Math' });
    expect(created).toMatchObject({ ownerUserId: kidId, createdByUserId: kidId, title: 'Homework', dueTime: '17:00' });

    const list = await json<TodoListResponse>(call(t.app, 'GET', '/api/panels/todo/items', { cookie: kid }));
    expect(list.owner).toEqual({ id: kidId, displayName: 'Kid' });
    expect(list.today).toBe('2026-11-15');
    expect(list.groups.today.map((i) => i.id)).toEqual([created.id]);

    const patched = await call(t.app, 'PATCH', `/api/panels/todo/items/${created.id}`, { cookie: kid, body: { title: 'Homework (math)' } });
    expect(patched.status).toBe(200);
    expect((await json<TodoItem>(patched)).title).toBe('Homework (math)');

    const done = await json<TodoItem>(call(t.app, 'POST', `/api/panels/todo/items/${created.id}/complete`, { cookie: kid }));
    expect(done.completedAt).toBe('2026-11-15T12:00:00.000Z');
    const afterDone = await json<TodoListResponse>(call(t.app, 'GET', '/api/panels/todo/items', { cookie: kid }));
    expect(afterDone.completed.map((i) => i.id)).toEqual([created.id]);

    const reopened = await json<TodoItem>(call(t.app, 'POST', `/api/panels/todo/items/${created.id}/uncomplete`, { cookie: kid }));
    expect(reopened.completedAt).toBeNull();

    const del = await call(t.app, 'DELETE', `/api/panels/todo/items/${created.id}`, { cookie: kid });
    expect(del.status).toBe(204);
    const missing = await call(t.app, 'DELETE', `/api/panels/todo/items/${created.id}`, { cookie: kid });
    expect(missing.status).toBe(404);
  });

  it('returns the summary for the signed-in user only', async () => {
    await add(kid, { title: 'Mine' });
    await add(otherKid, { title: 'Theirs' });
    const s = await json<TodoSummaryResponse>(call(t.app, 'GET', '/api/panels/todo/summary', { cookie: kid }));
    expect(s).toMatchObject({ view: 'overdue_today_undated', today: '2026-11-15', more: 0 });
    expect(s.items.map((i) => i.title)).toEqual(['Mine']);
  });

  it('leaves deleted items out of completed and the summary', async () => {
    const done = await add(kid, { title: 'Done then deleted' });
    expect((await call(t.app, 'POST', `/api/panels/todo/items/${done.id}/complete`, { cookie: kid })).status).toBe(200);
    const open = await add(kid, { title: 'Open then deleted' });
    for (const id of [done.id, open.id]) {
      expect((await call(t.app, 'DELETE', `/api/panels/todo/items/${id}`, { cookie: kid })).status).toBe(204);
    }
    const list = await json<TodoListResponse>(call(t.app, 'GET', '/api/panels/todo/items', { cookie: kid }));
    expect(list.completed).toEqual([]);
    expect(Object.values(list.groups).flat()).toEqual([]);
    const s = await json<TodoSummaryResponse>(call(t.app, 'GET', '/api/panels/todo/summary', { cookie: kid }));
    expect(s.items).toEqual([]);
    expect(s.more).toBe(0);
  });

  it('reads and saves the summary-view pref', async () => {
    expect(await json(call(t.app, 'GET', '/api/panels/todo/prefs', { cookie: kid }))).toEqual({ summaryView: 'overdue_today_undated' });
    const put = await call(t.app, 'PUT', '/api/panels/todo/prefs', { cookie: kid, body: { summaryView: 'next_7_days' } });
    expect(put.status).toBe(204);
    expect(await json(call(t.app, 'GET', '/api/panels/todo/prefs', { cookie: kid }))).toEqual({ summaryView: 'next_7_days' });
    expect((await json<TodoSummaryResponse>(call(t.app, 'GET', '/api/panels/todo/summary', { cookie: kid }))).view).toBe('next_7_days');
    const bad = await call(t.app, 'PUT', '/api/panels/todo/prefs', { cookie: kid, body: { summaryView: 'someday' } });
    expect(bad.status).toBe(400);
  });
});

describe('to-do API: validation', () => {
  it('rejects bad bodies with 400 validation errors', async () => {
    // Messages are shown as-is, so they carry no field paths.
    const cases: [unknown, string][] = [
      [{}, 'Enter a title'],
      [{ title: '' }, 'Enter a title'],
      [{ title: 'x'.repeat(501) }, 'Keep the title to 500 characters or fewer'],
      [{ title: 'A', dueDate: '2026-02-30' }, 'Enter a real date written as YYYY-MM-DD'],
      [{ title: 'A', dueTime: '09:00' }, 'Pick a date before setting a time'],
      [{ title: 'A', dueDate: '2026-11-15', dueTime: '25:00' }, 'Enter a 24-hour time written as HH:MM'],
      [{ title: '', dueDate: 'soon' }, 'Enter a title; Enter a real date written as YYYY-MM-DD'],
    ];
    for (const [body, message] of cases) {
      const res = await call(t.app, 'POST', '/api/panels/todo/items', { cookie: kid, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await json(res), JSON.stringify(body)).toEqual({ error: { code: 'validation', message } });
    }
    const item = await add(kid, { title: 'A' });
    const empty = await call(t.app, 'PATCH', `/api/panels/todo/items/${item.id}`, { cookie: kid, body: {} });
    expect(empty.status).toBe(400);
    expect(await json(empty)).toEqual({ error: { code: 'validation', message: 'Nothing to change' } });
    const timeOnly = await call(t.app, 'PATCH', `/api/panels/todo/items/${item.id}`, { cookie: kid, body: { dueTime: '10:00' } });
    expect(timeOnly.status).toBe(400);
    expect(await json(timeOnly)).toEqual({ error: { code: 'validation', message: 'Pick a date before setting a time' } });
  });

  it('rejects a malformed userId and junk item ids', async () => {
    const res = await call(t.app, 'GET', '/api/panels/todo/items?userId=abc', { cookie: admin });
    expect(res.status).toBe(400);
    const junk = await call(t.app, 'POST', '/api/panels/todo/items/abc/complete', { cookie: kid });
    expect(junk.status).toBe(404);
    for (const userId of ['0x10', '1e1']) {
      const r = await call(t.app, 'GET', `/api/panels/todo/items?userId=${userId}`, { cookie: admin });
      expect(r.status, userId).toBe(400);
    }
  });

  it('returns 404 for item ids that only look numeric', async () => {
    // Number() reads 0x10 as 16 and 1e1 as 10, so make sure items with those ids exist.
    for (let i = 0; i < 16; i++) await add(kid, { title: `Item ${i + 1}` });
    for (const id of ['0x10', '1e1', '1.0', '+1', ' 1']) {
      const res = await call(t.app, 'POST', `/api/panels/todo/items/${encodeURIComponent(id)}/complete`, { cookie: kid });
      expect(res.status, id).toBe(404);
      const patch = await call(t.app, 'PATCH', `/api/panels/todo/items/${encodeURIComponent(id)}`, { cookie: kid, body: { title: 'x' } });
      expect(patch.status, id).toBe(404);
    }
  });

  it('requires the CSRF header on mutations', async () => {
    const res = await call(t.app, 'POST', '/api/panels/todo/items', { cookie: kid, body: { title: 'A' }, csrf: false });
    expect(res.status).toBe(403);
  });
});

describe('to-do API: permissions', () => {
  it('requires a session and the To-do panel', async () => {
    expect((await call(t.app, 'GET', '/api/panels/todo/summary')).status).toBe(401);
    const noTodo = cookieFor(t.db, t.clock, noTodoId);
    expect((await call(t.app, 'GET', '/api/panels/todo/items', { cookie: noTodo })).status).toBe(403);
  });

  it("forbids members from another person's list, even by item id", async () => {
    const theirs = await add(otherKid, { title: 'Theirs' });
    const asList = await call(t.app, 'GET', `/api/panels/todo/items?userId=${otherKidId}`, { cookie: kid });
    expect(asList.status).toBe(403);
    expect(await json(asList)).toEqual({ error: { code: 'forbidden', message: 'You can only see your own to-do list.' } });
    const asCreate = await call(t.app, 'POST', `/api/panels/todo/items?userId=${otherKidId}`, { cookie: kid, body: { title: 'x' } });
    expect(asCreate.status).toBe(403);
    // Without userId the request targets the member's own list, where that id doesn't exist.
    const byId = await call(t.app, 'POST', `/api/panels/todo/items/${theirs.id}/complete`, { cookie: kid });
    expect(byId.status).toBe(404);
    const del = await call(t.app, 'DELETE', `/api/panels/todo/items/${theirs.id}`, { cookie: kid });
    expect(del.status).toBe(404);
    const patch = await call(t.app, 'PATCH', `/api/panels/todo/items/${theirs.id}`, { cookie: kid, body: { title: 'Mine now' } });
    expect(patch.status).toBe(404);
    const after = await json<TodoListResponse>(call(t.app, 'GET', '/api/panels/todo/items', { cookie: otherKid }));
    expect(after.groups.none.map((i) => [i.title, i.completedAt])).toEqual([['Theirs', null]]);
  });

  it("refuses a member's delete of a chore to-do, and allows an admin's", async () => {
    const chore = await t.todos.create({ type: 'system' }, kidId, { title: 'Feed the cat' }, { choreOccurrenceId: 1 });
    const res = await call(t.app, 'DELETE', `/api/panels/todo/items/${chore.id}`, { cookie: kid });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({
      error: { code: 'forbidden', message: "Chore to-dos can't be deleted. Complete it, or ask an admin to skip the chore." },
    });
    expect((await call(t.app, 'POST', `/api/panels/todo/items/${chore.id}/complete`, { cookie: kid })).status).toBe(200);
    const byAdmin = await call(t.app, 'DELETE', `/api/panels/todo/items/${chore.id}?userId=${kidId}`, { cookie: admin });
    expect(byAdmin.status).toBe(204);
  });

  it('lets a member pass their own userId', async () => {
    const res = await call(t.app, 'GET', `/api/panels/todo/items?userId=${kidId}`, { cookie: kid });
    expect(res.status).toBe(200);
  });

  it("lets admins view and change anyone's list", async () => {
    const theirs = await add(kid, { title: 'Homework' });
    const list = await json<TodoListResponse>(call(t.app, 'GET', `/api/panels/todo/items?userId=${kidId}`, { cookie: admin }));
    expect(list.owner).toEqual({ id: kidId, displayName: 'Kid' });
    expect(list.groups.none.map((i) => i.title)).toEqual(['Homework']);

    const added = await add(admin, { title: 'Practice piano' }, `?userId=${kidId}`);
    expect(added).toMatchObject({ ownerUserId: kidId, createdByUserId: adminId });

    const q = `?userId=${kidId}`;
    expect((await call(t.app, 'PATCH', `/api/panels/todo/items/${theirs.id}${q}`, { cookie: admin, body: { notes: 'Page 4' } })).status).toBe(200);
    expect((await call(t.app, 'POST', `/api/panels/todo/items/${theirs.id}/complete${q}`, { cookie: admin })).status).toBe(200);
    expect((await call(t.app, 'POST', `/api/panels/todo/items/${theirs.id}/uncomplete${q}`, { cookie: admin })).status).toBe(200);
    expect((await call(t.app, 'DELETE', `/api/panels/todo/items/${theirs.id}${q}`, { cookie: admin })).status).toBe(204);

    // The item id must belong to the chosen list.
    const wrongList = await call(t.app, 'POST', `/api/panels/todo/items/${added.id}/complete?userId=${otherKidId}`, { cookie: admin });
    expect(wrongList.status).toBe(404);
  });

  it('returns 404 to admins for people without a list', async () => {
    for (const id of [noTodoId, 9999]) {
      const res = await call(t.app, 'GET', `/api/panels/todo/items?userId=${id}`, { cookie: admin });
      expect(res.status).toBe(404);
      expect(await json(res)).toEqual({ error: { code: 'not_found', message: "That person doesn't have a to-do list." } });
    }
    updateUser(t.db, kidId, { active: false });
    expect((await call(t.app, 'GET', `/api/panels/todo/items?userId=${kidId}`, { cookie: admin })).status).toBe(404);
  });

  it('lists active people with the To-do panel for admins only', async () => {
    updateUser(t.db, otherKidId, { active: false });
    const people = await json<TodoPerson[]>(call(t.app, 'GET', '/api/panels/todo/people', { cookie: admin }));
    expect(people).toEqual([
      { id: adminId, displayName: 'Admin', color: '#378ADD' },
      { id: kidId, displayName: 'Kid', color: '#378ADD' },
    ]);
    expect((await call(t.app, 'GET', '/api/panels/todo/people', { cookie: kid })).status).toBe(403);
  });

  it('keeps the summary and prefs on the signed-in user even for admins', async () => {
    await add(admin, { title: 'For kid' }, `?userId=${kidId}`);
    const s = await json<TodoSummaryResponse>(call(t.app, 'GET', `/api/panels/todo/summary?userId=${kidId}`, { cookie: admin }));
    expect(s.items).toEqual([]);
  });
});
