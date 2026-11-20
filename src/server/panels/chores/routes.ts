import { Hono, type Context } from 'hono';
import {
  AssignInputSchema, ChoreInputSchema, CreditInputSchema, HistoryQuerySchema, NewChoreInputSchema, StuckTodoSchema, type ChoreListResponse,
} from '../../../shared/chores.js';
import type { AppDeps, AppEnv } from '../../app.js';
import { requireAdmin } from '../../auth/middleware.js';
import { AppError, parseJson } from '../../core/errors.js';
import { completeOccurrence, reopenOccurrence, setCredit, skipOccurrence, type ChoreUser } from './actions.js';
import { assignChore, claimChore, releaseChore } from './assignment.js';
import { createChore, listChores, setChoreStatus, updateChore } from './definitions.js';
import { familyToday } from './store.js';
import { dismissStuckTodo, listStuckTodos, retryStuckTodo } from './todoLink.js';
import { choreBoard, choresSummary, history, listChorePeople } from './views.js';

/** Plain decimal digits only, like the To-do routes. */
function idParam(raw: string, message: string): number {
  const id = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError('not_found', message);
  return id;
}

/**
 * /api/panels/chores/* (requirePanel has already checked the Chores grant).
 *
 *   GET  /board                                    the board              → BoardResponse
 *   GET  /summary                                  own home tile          → ChoreSummaryResponse
 *   GET  /history?person=&range=&from=&to=&choreId=&skipped=             → HistoryResponse
 *   GET  /people                                   everyone, with panels  → ChorePeopleEntry[]
 *   GET  /chores                                   definitions            → ChoreListResponse
 *   POST /chores                       anyone      NewChoreInput (members: themselves or null) → 201 Chore
 *   PUT  /chores/:id                   admin       ChoreInput             → Chore
 *   POST /chores/:id/pause|resume|archive  admin                          → ChoreResponse
 *   POST /chores/:id/claim                         claim or take over     → BoardRowResponse
 *   POST /chores/:id/release                       whoever has it         → BoardRowResponse
 *   POST /chores/:id/assign            admin       { userId | null }      → BoardRowResponse
 *   POST /occurrences/:id/complete                 its assignee, or admin → Occurrence
 *   POST /occurrences/:id/skip         admin                              → Occurrence
 *   POST /occurrences/:id/credit       admin       { userId }             → Occurrence
 *   POST /occurrences/:id/reopen       admin                              → Occurrence
 */
export function choreRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  function me(c: Context<AppEnv>): ChoreUser {
    const user = c.get('user')!;
    return { id: user.id, role: user.role };
  }
  const choreId = (c: Context<AppEnv>) => idParam(c.req.param('id') ?? '', 'Chore not found.');
  const occurrenceId = (c: Context<AppEnv>) => idParam(c.req.param('id') ?? '', 'Chore not found.');

  r.get('/summary', (c) => c.json(choresSummary(deps, me(c).id)));
  r.get('/board', (c) => c.json(choreBoard(deps)));

  r.get('/history', (c) => {
    const parsed = HistoryQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new AppError('validation', [...new Set(parsed.error.issues.map((i) => i.message))].join('; '));
    }
    return c.json(history(deps, parsed.data));
  });

  r.get('/people', (c) => c.json(listChorePeople(deps.db)));

  r.get('/chores', (c) => {
    const body: ChoreListResponse = { today: familyToday(deps), chores: listChores(deps.db) };
    return c.json(body);
  });

  r.post('/chores', async (c) => c.json(await createChore(deps, await parseJson(c, NewChoreInputSchema), me(c)), 201));
  r.put('/chores/:id', requireAdmin, async (c) => {
    const id = choreId(c);
    return c.json(await updateChore(deps, id, await parseJson(c, ChoreInputSchema)));
  });
  r.post('/chores/:id/pause', requireAdmin, async (c) => c.json(await setChoreStatus(deps, choreId(c), 'paused')));
  r.post('/chores/:id/resume', requireAdmin, async (c) => c.json(await setChoreStatus(deps, choreId(c), 'active')));
  r.post('/chores/:id/archive', requireAdmin, async (c) => c.json(await setChoreStatus(deps, choreId(c), 'archived')));
  r.post('/chores/:id/claim', async (c) => c.json(await claimChore(deps, me(c), choreId(c))));
  r.post('/chores/:id/release', async (c) => c.json(await releaseChore(deps, me(c), choreId(c))));
  r.post('/chores/:id/assign', requireAdmin, async (c) => {
    const id = choreId(c);
    const { userId } = await parseJson(c, AssignInputSchema);
    return c.json(await assignChore(deps, me(c), id, userId));
  });

  r.post('/occurrences/:id/complete', async (c) => c.json(await completeOccurrence(deps, me(c), occurrenceId(c))));
  r.post('/occurrences/:id/skip', requireAdmin, async (c) => c.json(await skipOccurrence(deps, me(c), occurrenceId(c))));
  r.post('/occurrences/:id/credit', requireAdmin, async (c) => {
    const id = occurrenceId(c);
    const { userId } = await parseJson(c, CreditInputSchema);
    return c.json(await setCredit(deps, me(c), id, userId));
  });
  r.post('/occurrences/:id/reopen', requireAdmin, async (c) => c.json(await reopenOccurrence(deps, me(c), occurrenceId(c))));

  return r;
}

/**
 * /api/admin/panels/chores/* (the admin routes check the role). The System page's stuck chore
 * to-dos (spec §11.5, §14), with Retry and Dismiss.
 *
 *   GET  /stuck                         → StuckTodo[]
 *   POST /stuck/:kind/:id/retry         → { ok: boolean }  (false: it failed again and is waiting)
 *   POST /stuck/:kind/:id/dismiss       → 204
 */
export function choreAdminRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const target = (c: Context<AppEnv>) => {
    const kind = StuckTodoSchema.shape.kind.safeParse(c.req.param('kind'));
    const raw = c.req.param('id') ?? '';
    const id = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!kind.success || !Number.isSafeInteger(id) || id <= 0) throw new AppError('not_found', 'That item is no longer stuck.');
    return { kind: kind.data, id };
  };
  r.get('/stuck', async (c) => c.json(await listStuckTodos(deps)));
  r.post('/stuck/:kind/:id/retry', async (c) => {
    const { kind, id } = target(c);
    return c.json({ ok: await retryStuckTodo(deps, kind, id) });
  });
  r.post('/stuck/:kind/:id/dismiss', (c) => {
    const { kind, id } = target(c);
    dismissStuckTodo(deps, kind, id);
    return c.body(null, 204);
  });
  return r;
}
