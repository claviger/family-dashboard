import { Hono, type Context } from 'hono';
import {
  CreateTodoInputSchema, TodoOwnerQuerySchema, TodoPrefsSchema, UpdateTodoInputSchema, type TodoListResponse,
  type TodoOwner, type TodoPrefs,
} from '../../../shared/todo.js';
import type { AppDeps, AppEnv } from '../../app.js';
import { requireAdmin } from '../../auth/middleware.js';
import { AppError, parseJson } from '../../core/errors.js';
import type { Actor } from '../../core/events.js';
import { listTodoPeople, resolveOwner } from './access.js';
import { getSummaryView, setSummaryView } from './prefs.js';

/** Plain decimal digits only: Number() would also accept '0x10', '1e1', ' 1', and '1.0'. */
function itemId(raw: string): number {
  const id = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError('not_found', 'To-do not found.');
  return id;
}

/**
 * /api/panels/todo/* (requirePanel has already checked the To-do grant).
 *
 *   GET    /summary                  own home card               → TodoSummaryResponse
 *   GET    /items?userId=            list, grouped               → TodoListResponse
 *   POST   /items?userId=            CreateTodoInput             → 201 TodoItem
 *   PATCH  /items/:id?userId=        UpdateTodoInput             → TodoItem
 *   POST   /items/:id/complete?userId=                           → TodoItem
 *   POST   /items/:id/uncomplete?userId=                         → TodoItem
 *   DELETE /items/:id?userId=                                    → 204
 *   GET    /people                   admins only                 → TodoPerson[]
 *   GET    /prefs                    own prefs                   → TodoPrefs
 *   PUT    /prefs                    TodoPrefs                   → 204
 *
 * The signed-in person's own Todoist link is under /api/todoist (`todoistLinkRoutes`), since it
 * must work without this panel: someone whose panel was turned off can still disconnect.
 */
export function todoRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const { todos } = deps;

  function owner(c: Context<AppEnv>): TodoOwner {
    const query = TodoOwnerQuerySchema.safeParse({ userId: c.req.query('userId') });
    if (!query.success) throw new AppError('validation', "That isn't a valid person.");
    return resolveOwner(deps.db, c.get('user')!, query.data.userId);
  }

  function actor(c: Context<AppEnv>): Actor {
    const user = c.get('user')!;
    return { type: 'user', userId: user.id, role: user.role };
  }

  r.get('/summary', async (c) => c.json(await todos.summary(c.get('user')!.id)));

  r.get('/items', async (c) => {
    const o = owner(c);
    await todos.syncBeforeList(o.id);
    const body: TodoListResponse = { owner: o, ...(await todos.list(o.id)) };
    return c.json(body);
  });

  r.post('/items', async (c) => {
    const o = owner(c);
    const input = await parseJson(c, CreateTodoInputSchema);
    return c.json(await todos.create(actor(c), o.id, input), 201);
  });

  r.patch('/items/:id', async (c) => {
    const o = owner(c);
    const patch = await parseJson(c, UpdateTodoInputSchema);
    return c.json(await todos.update(actor(c), o.id, itemId(c.req.param('id')), patch));
  });

  r.post('/items/:id/complete', async (c) => {
    const o = owner(c);
    return c.json(await todos.complete(actor(c), o.id, itemId(c.req.param('id'))));
  });

  r.post('/items/:id/uncomplete', async (c) => {
    const o = owner(c);
    return c.json(await todos.uncomplete(actor(c), o.id, itemId(c.req.param('id'))));
  });

  r.delete('/items/:id', async (c) => {
    const o = owner(c);
    await todos.delete(actor(c), o.id, itemId(c.req.param('id')));
    return c.body(null, 204);
  });

  r.get('/people', requireAdmin, (c) => c.json(listTodoPeople(deps.db)));

  r.get('/prefs', (c) => {
    const body: TodoPrefs = { summaryView: getSummaryView(deps.db, c.get('user')!.id) };
    return c.json(body);
  });

  r.put('/prefs', async (c) => {
    const { summaryView } = await parseJson(c, TodoPrefsSchema);
    setSummaryView(deps.db, c.get('user')!.id, summaryView);
    return c.body(null, 204);
  });

  return r;
}
