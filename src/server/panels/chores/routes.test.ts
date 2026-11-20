import { beforeEach, describe, expect, it } from 'vitest';
import {
  TODO_REMOVAL_WARNING, type BoardResponse, type BoardRowResponse, type Chore, type ChoreListResponse, type ChorePeopleEntry, type ChoreSummaryResponse,
  type HistoryResponse, type Occurrence, type OccurrenceResponse,
} from '../../../shared/chores.js';
import type { TodoListResponse } from '../../../shared/todo.js';
import { panelJobs } from '../registry.js';
import { addUser, call, cookieFor, makeTestApp, useFlakyTodos, type TestApp } from '../../test/helpers.js';

let t: TestApp;
let adminId: number;
let admin: string;
let kidId: number;
let kid: string;
let sibId: number;
let sib: string;

const BASE = '/api/panels/chores';

beforeEach(() => {
  t = makeTestApp();
  adminId = addUser(t.db, t.clock, { email: 'admin@example.com', displayName: 'Admin', role: 'admin', panels: ['todo', 'chores'] });
  admin = cookieFor(t.db, t.clock, adminId);
  kidId = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo', 'chores'] });
  kid = cookieFor(t.db, t.clock, kidId);
  sibId = addUser(t.db, t.clock, { email: 'sib@example.com', displayName: 'Sib', panels: ['todo', 'chores'] });
  sib = cookieFor(t.db, t.clock, sibId);
});

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

const DAILY = { title: 'Feed the cat', notes: 'Half a can', schedule: { kind: 'daily' }, startDate: '2026-11-15' };

async function addChore(body: Record<string, unknown> = {}): Promise<Chore> {
  const res = await call(t.app, 'POST', `${BASE}/chores`, { cookie: admin, body: { ...DAILY, assigneeUserId: kidId, ...body } });
  expect(res.status).toBe(201);
  return json<Chore>(res);
}

async function boardOf(cookie: string): Promise<BoardResponse> {
  return json<BoardResponse>(call(t.app, 'GET', `${BASE}/board`, { cookie }));
}

async function firstOpenId(): Promise<number> {
  return (await boardOf(admin)).rows.find((r) => r.occurrenceId !== null)!.occurrenceId!;
}

describe('chores API: definitions', () => {
  it('lets admins create, edit, pause, resume, and archive', async () => {
    const chore = await addChore();
    expect(chore).toMatchObject({ title: 'Feed the cat', status: 'active', assignee: { id: kidId, displayName: 'Kid' } });

    const put = await call(t.app, 'PUT', `${BASE}/chores/${chore.id}`, {
      cookie: admin, body: { ...DAILY, title: 'Feed the dog', assigneeUserId: null, schedule: { kind: 'after', every: 2, unit: 'days' } },
    });
    expect(put.status).toBe(200);
    expect(await json(put)).toMatchObject({ title: 'Feed the dog', assignee: { id: kidId }, schedule: { kind: 'after', every: 2, unit: 'days' } });

    for (const [action, status] of [['pause', 'paused'], ['resume', 'active'], ['archive', 'archived']] as const) {
      const res = await call(t.app, 'POST', `${BASE}/chores/${chore.id}/${action}`, { cookie: admin });
      expect(res.status, action).toBe(200);
      expect((await json<Chore>(res)).status).toBe(status);
    }
    const again = await call(t.app, 'POST', `${BASE}/chores/${chore.id}/resume`, { cookie: admin });
    expect(again.status).toBe(409);
    expect(await json(again)).toEqual({ error: { code: 'conflict', message: "Archived chores can't be changed." } });
  });

  it('lists chores and people for everyone with the panel', async () => {
    await addChore();
    const list = await json<ChoreListResponse>(call(t.app, 'GET', `${BASE}/chores`, { cookie: kid }));
    expect(list.today).toBe('2026-11-15');
    expect(list.chores.map((c) => c.title)).toEqual(['Feed the cat']);
    const people = await json<ChorePeopleEntry[]>(call(t.app, 'GET', `${BASE}/people`, { cookie: kid }));
    expect(people.map((p) => p.displayName)).toEqual(['Admin', 'Kid', 'Sib']);
  });

  it('lets everyone add chores, members only for themselves or nobody, and keeps edits to admins', async () => {
    const mine = await call(t.app, 'POST', `${BASE}/chores`, { cookie: kid, body: { ...DAILY, title: 'Mine', assigneeUserId: kidId } });
    expect(mine.status).toBe(201);
    expect(await json(mine)).toMatchObject({ title: 'Mine', assignee: { id: kidId } });
    expect((await call(t.app, 'POST', `${BASE}/chores`, { cookie: kid, body: { ...DAILY, assigneeUserId: null } })).status).toBe(201);
    const theirs = await call(t.app, 'POST', `${BASE}/chores`, { cookie: kid, body: { ...DAILY, assigneeUserId: sibId } });
    expect(theirs.status).toBe(403);
    expect(await json(theirs)).toEqual({ error: { code: 'forbidden', message: 'You can add a chore for yourself or leave it unassigned.' } });

    const chore = await addChore();
    const attempts = [
      call(t.app, 'PUT', `${BASE}/chores/${chore.id}`, { cookie: kid, body: DAILY }),
      call(t.app, 'POST', `${BASE}/chores/${chore.id}/pause`, { cookie: kid }),
      call(t.app, 'POST', `${BASE}/chores/${chore.id}/archive`, { cookie: kid }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({ error: { code: 'forbidden', message: 'Only admins can do that.' } });
    }
  });

  it('validates definitions with readable messages', async () => {
    const cases: [unknown, string][] = [
      [{ ...DAILY, title: ' ', assigneeUserId: null }, 'Enter a title'],
      [{ ...DAILY, assigneeUserId: null, schedule: { kind: 'weekly', interval: 1, weekdays: [] } }, 'Pick at least one weekday'],
      [{ ...DAILY, assigneeUserId: null, startDate: '2026-02-30' }, 'Enter a real date written as YYYY-MM-DD'],
      [{ ...DAILY, assigneeUserId: 999 }, 'Pick an active person, or Unassigned.'],
      [{ ...DAILY, assigneeUserId: 'kid' }, 'Pick a person from the list'],
    ];
    for (const [body, message] of cases) {
      const res = await call(t.app, 'POST', `${BASE}/chores`, { cookie: admin, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await json(res), JSON.stringify(body)).toEqual({ error: { code: 'validation', message } });
    }
    for (const id of ['abc', '0x1', '1e1', '0']) {
      const res = await call(t.app, 'POST', `${BASE}/chores/${id}/pause`, { cookie: admin });
      expect(res.status, id).toBe(404);
    }
  });
});

describe('chores API: occurrences', () => {
  it("puts a new chore on the assignee's to-do list, and completing it there shows in history", async () => {
    await addChore();
    const todos = await json<TodoListResponse>(call(t.app, 'GET', '/api/panels/todo/items', { cookie: kid }));
    const [item] = todos.groups.today;
    expect(item).toMatchObject({ title: 'Feed the cat', notes: 'Half a can', dueDate: '2026-11-15' });
    expect(item!.choreOccurrenceId).not.toBeNull();

    expect((await call(t.app, 'POST', `/api/panels/todo/items/${item!.id}/complete`, { cookie: kid })).status).toBe(200);
    const h = await json<HistoryResponse>(call(t.app, 'GET', `${BASE}/history?person=${kidId}`, { cookie: kid }));
    expect(h.entries.map((e) => [e.title, e.state, e.credited?.displayName, e.closedBy?.displayName])).toEqual([['Feed the cat', 'done', 'Kid', 'Kid']]);
    expect(t.eventErrors).toEqual([]);
  });

  it('keeps skip, credit, and reopen to admins', async () => {
    await addChore();
    const id = await firstOpenId();
    const memberCalls: [string, unknown][] = [['skip', undefined], ['credit', { userId: kidId }], ['reopen', undefined]];
    for (const [action, body] of memberCalls) {
      const res = await call(t.app, 'POST', `${BASE}/occurrences/${id}/${action}`, { cookie: kid, body });
      expect(res.status, action).toBe(403);
    }
    expect((await call(t.app, 'POST', `${BASE}/occurrences/${id}/complete`, { cookie: sib, body: {} })).status).toBe(403);

    const choreId = (await boardOf(admin)).rows[0]!.choreId;
    const assigned = await json<BoardRowResponse>(call(t.app, 'POST', `${BASE}/chores/${choreId}/assign`, { cookie: admin, body: { userId: sibId } }));
    expect(assigned).toMatchObject({ assignee: { id: sibId }, occurrenceId: id });
    const done = await json<Occurrence>(call(t.app, 'POST', `${BASE}/occurrences/${id}/complete`, { cookie: admin, body: {} }));
    expect(done).toMatchObject({ credited: { id: sibId }, closedBy: { id: adminId } });
    const credit = await json<Occurrence>(call(t.app, 'POST', `${BASE}/occurrences/${id}/credit`, { cookie: admin, body: { userId: kidId } }));
    expect(credit.credited?.id).toBe(kidId);
    const reopened = await json<Occurrence>(call(t.app, 'POST', `${BASE}/occurrences/${id}/reopen`, { cookie: admin }));
    expect(reopened.state).toBe('open');
    const skipped = await json<Occurrence>(call(t.app, 'POST', `${BASE}/occurrences/${id}/skip`, { cookie: admin }));
    expect(skipped.state).toBe('skipped');
  });

  it('no longer has the Open tab or occurrence-level claim, hand back, and assign', async () => {
    await addChore();
    const id = await firstOpenId();
    expect((await call(t.app, 'GET', `${BASE}/open`, { cookie: kid })).status).toBe(404);
    for (const action of ['claim', 'hand-back', 'assign']) {
      expect((await call(t.app, 'POST', `${BASE}/occurrences/${id}/${action}`, { cookie: admin, body: { userId: kidId } })).status, action).toBe(404);
    }
  });

  it('validates bodies and ids', async () => {
    const chore = await addChore();
    const id = await firstOpenId();
    const bad = await call(t.app, 'POST', `${BASE}/chores/${chore.id}/assign`, { cookie: admin, body: { userId: 'x' } });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toEqual({ error: { code: 'validation', message: 'Pick a person from the list' } });
    const missing = await call(t.app, 'POST', `${BASE}/chores/9999/claim`, { cookie: kid });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ error: { code: 'not_found', message: 'Chore not found.' } });
    expect((await call(t.app, 'POST', `${BASE}/chores/1.0/claim`, { cookie: kid })).status).toBe(404);
    expect((await call(t.app, 'POST', `${BASE}/occurrences/${id}/complete`, { cookie: kid, body: {}, csrf: false })).status).toBe(403);
  });

  it('lets members claim, take over, and release, and keeps assign to admins', async () => {
    const chore = await addChore({ assigneeUserId: null });
    const claimed = await json<BoardRowResponse>(call(t.app, 'POST', `${BASE}/chores/${chore.id}/claim`, { cookie: kid }));
    expect(claimed).toMatchObject({ assignee: { id: kidId }, state: 'due' });
    const taken = await json<BoardRowResponse>(call(t.app, 'POST', `${BASE}/chores/${chore.id}/claim`, { cookie: sib }));
    expect(taken).toMatchObject({ assignee: { id: sibId }, occurrenceId: claimed.occurrenceId });
    expect((await call(t.app, 'POST', `${BASE}/chores/${chore.id}/release`, { cookie: kid })).status).toBe(403);
    expect(await json(call(t.app, 'POST', `${BASE}/chores/${chore.id}/release`, { cookie: sib }))).toMatchObject({ state: 'unassigned' });
    const assign = await call(t.app, 'POST', `${BASE}/chores/${chore.id}/assign`, { cookie: kid, body: { userId: kidId } });
    expect(assign.status).toBe(403);
    expect(await json(assign)).toEqual({ error: { code: 'forbidden', message: 'Only admins can do that.' } });
  });
});

describe('chores API: reads and access', () => {
  it('serves the board to everyone with the panel', async () => {
    await addChore();
    await addChore({ title: 'Dishes', assigneeUserId: null, schedule: { kind: 'weekly', interval: 1, weekdays: [5] } });
    const board = await boardOf(sib);
    expect(board.rows.map((r) => [r.title, r.state, r.assignee?.displayName ?? null])).toEqual([
      ['Feed the cat', 'due', 'Kid'],
      ['Dishes', 'unassigned', null],
    ]);
    const todoOnly = cookieFor(t.db, t.clock, addUser(t.db, t.clock, { email: 'todo@example.com', panels: ['todo'] }));
    expect((await call(t.app, 'GET', `${BASE}/board`, { cookie: todoOnly })).status).toBe(403);
  });

  it('returns the home tile for the signed-in user', async () => {
    await addChore();
    await addChore({ title: 'Dishes', assigneeUserId: null });
    await addChore({ title: 'Yard', assigneeUserId: sibId });
    const s = await json<ChoreSummaryResponse>(call(t.app, 'GET', `${BASE}/summary`, { cookie: kid }));
    expect(s.due.map((r) => r.title)).toEqual(['Feed the cat']);
    expect(s.waiting).toEqual([]);
    expect(s.upForGrabs.map((r) => [r.title, r.state])).toEqual([['Dishes', 'unassigned']]);
  });

  it('validates the history filter', async () => {
    const cases: [string, string][] = [
      ['range=custom&from=2026-11-01', 'Pick both dates for a custom range'],
      ['range=someday', 'Pick a date range'],
      ['person=-1', 'Pick a person from the list'],
      ['range=custom&from=2026-11-10&to=2026-11-01', 'The start date must be on or before the end date'],
    ];
    for (const [query, message] of cases) {
      const res = await call(t.app, 'GET', `${BASE}/history?${query}`, { cookie: kid });
      expect(res.status, query).toBe(400);
      expect(await json(res), query).toEqual({ error: { code: 'validation', message } });
    }
    const ok = await json<HistoryResponse>(call(t.app, 'GET', `${BASE}/history?range=this_week`, { cookie: kid }));
    expect(ok).toMatchObject({ from: '2026-11-15', to: '2026-11-15', entries: [] });
  });

  it('requires a session and the Chores panel', async () => {
    expect((await call(t.app, 'GET', `${BASE}/summary`)).status).toBe(401);
    const todoOnly = cookieFor(t.db, t.clock, addUser(t.db, t.clock, { email: 'todo@example.com', panels: ['todo'] }));
    expect((await call(t.app, 'GET', `${BASE}/board`, { cookie: todoOnly })).status).toBe(403);
  });

  it("puts a deactivated member's chores back on the board", async () => {
    await addChore();
    const res = await call(t.app, 'PATCH', `/api/admin/users/${kidId}`, { cookie: admin, body: { active: false } });
    expect(res.status).toBe(204);
    const board = await boardOf(admin);
    expect(board.rows.map((r) => [r.title, r.state])).toEqual([['Feed the cat', 'unassigned']]);
    expect((await t.todos.list(kidId)).groups.today).toEqual([]);
  });

  it('records a job error while chore to-dos are still waiting', async () => {
    await addChore();
    useFlakyTodos(t, new Set(['remove']));
    const id = await firstOpenId();
    const skipped = await json<OccurrenceResponse>(call(t.app, 'POST', `${BASE}/occurrences/${id}/skip`, { cookie: admin }));
    expect(skipped.warning).toBe(TODO_REMOVAL_WARNING);
    t.clock.advance(5 * 60_000);
    const job = panelJobs(t).find((j) => j.name === 'todo.retryPending')!;
    await expect(Promise.resolve(job.run())).rejects.toThrow('Chore to-dos still waiting: 0 to create, 1 to remove or complete.');
  });

  it("keeps the job error between retries, while nothing is due, and doesn't count a first create in flight", async () => {
    const job = panelJobs(t).find((j) => j.name === 'todo.retryPending')!;
    const flaky = useFlakyTodos(t);
    await addChore(); // the create fails: attempts 1, retry at 12:05
    t.clock.advance(5 * 60_000);
    await expect(Promise.resolve(job.run())).rejects.toThrow('Chore to-dos still waiting: 1 to create, 0 to remove or complete.');
    t.clock.advance(5 * 60_000); // 12:10; the next retry is at 12:15
    await expect(Promise.resolve(job.run())).rejects.toThrow('Chore to-dos still waiting: 1 to create, 0 to remove or complete.');

    flaky.failing = false;
    t.clock.advance(5 * 60_000);
    await job.run();
    // A first create that hasn't failed yet (attempts 0, saved as pending before the call) isn't waiting on a retry.
    flaky.stalled = new Set(['create']);
    void addChore({ title: 'Dishes' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await job.run();
  });

  it('registers the generate and retry jobs', () => {
    expect(panelJobs(t).map((j) => [j.name, j.cron])).toEqual([
      ['calendar.refreshSummary', '*/5 * * * *'],
      ['calendar.revocations', '30 * * * *'],
      ['chores.generate', '*/15 * * * *'],
      ['todo.retryPending', '*/5 * * * *'],
      ['spend.pruneImports', '*/15 * * * *'],
      // Without Plaid, Spend's only Plaid job is the prune.
      ['spend.pruneRemoved', '15 4 * * *'],
      // Savings' import drafts are pruned with or without Plaid.
      ['savings.pruneImports', '*/15 * * * *'],
    ]);
  });
});
