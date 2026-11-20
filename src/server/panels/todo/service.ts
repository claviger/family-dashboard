import { and, eq, isNull } from 'drizzle-orm';
import type {
  CreateTodoInput, TodoItem, TodoListResponse, TodoSummaryResponse, UpdateTodoInput,
} from '../../../shared/todo.js';
import { localDate, type Clock } from '../../core/clock.js';
import { AppError } from '../../core/errors.js';
import type { Actor, EventBus, EventName } from '../../core/events.js';
import type { Db } from '../../db/index.js';
import { todos } from '../../db/schema.js';
import { TODOIST_MESSAGES, type Todoist } from '../../integrations/todoist/todoist.js';
import { getFamilySettings } from '../../settings.js';
import type { TodoBackend, TodoChanges } from './backend.js';
import { compareTodos, groupTodos, inSummaryView } from './buckets.js';
import { InternalTodoBackend, toTodoItem } from './internalBackend.js';
import { getSummaryView } from './prefs.js';
import { TodoistBackend } from './todoistBackend.js';

export const SUMMARY_LIMIT = 8;
/** Spec §10.5: completed items stay visible for 7 days. */
export const COMPLETED_VISIBLE_MS = 7 * 24 * 60 * 60 * 1000;

export interface TodoServiceDeps {
  db: Db;
  clock: Clock;
  events: EventBus;
  /** Null when Todoist isn't configured: everyone uses the internal backend. */
  todoist?: Todoist | null;
}

/** Empty or whitespace-only notes are stored as null. */
function cleanNotes(notes: string | null | undefined): string | null {
  return notes && notes.trim() !== '' ? notes : null;
}

/**
 * The only way panels touch to-do items (spec §3.3). Picks each owner's backend, applies the
 * cross-field rules, computes groups in the family time zone, and emits events for to-dos that
 * are linked to a chore occurrence (spec §10.7), carrying the actor that made the change.
 *
 * Whose list a request may touch is checked in the routes. The one rule that depends on the item
 * is here: members can't delete chore to-dos (spec §10.4), so `delete` checks the actor's role.
 *
 * One instance lives on AppDeps (`deps.todos`), so every panel shares it and its event bus.
 */
export class TodoService {
  private readonly internal: InternalTodoBackend;
  private readonly todoistBackend: TodoistBackend | null;

  constructor(private readonly deps: TodoServiceDeps) {
    this.internal = new InternalTodoBackend(deps);
    const todoist = deps.todoist ?? null;
    this.todoistBackend = todoist ? new TodoistBackend(deps, todoist) : null;
    // Changes that arrive through Todoist sync become to-do events with the `todoist` actor (spec §10.7).
    todoist?.onRemoteChanges(async (changes) => {
      for (const c of changes) await this.applyRemoteChange(c.before, c.after, { type: 'todoist' });
    });
  }

  /** The Todoist backend for someone linked to Todoist (whatever the link's status), else the internal one. */
  backendFor(ownerId: number): TodoBackend {
    return this.todoistBackend && this.deps.todoist?.isLinked(ownerId) ? this.todoistBackend : this.internal;
  }

  /** True when the owner's Todoist link needs reconnecting, so writes to their list can't succeed yet. */
  needsReconnect(ownerId: number): boolean {
    return this.deps.todoist?.needsReconnect(ownerId) ?? false;
  }

  /**
   * True when writes to the owner's list can't succeed until someone acts: their Todoist link needs
   * reconnecting, or they're linked and TOKEN_ENCRYPTION_KEY doesn't match (an admin has to fix
   * the key). Retries skip these without counting an attempt.
   */
  writesBlocked(ownerId: number): boolean {
    const todoist = this.deps.todoist;
    if (!todoist) return false;
    return todoist.needsReconnect(ownerId) || (todoist.keyMismatch && todoist.isLinked(ownerId));
  }

  /**
   * Spec §10.6: opening the drill-down starts a sync. Waits a bounded time for it (see
   * LIST_SYNC_WAIT_MS), then the list is served from the mirror either way. A no-op for internal lists.
   */
  async syncBeforeList(ownerId: number): Promise<void> {
    if (this.backendFor(ownerId).kind === 'todoist') await this.deps.todoist!.syncBeforeRead(ownerId);
  }

  /** Today's date in the family time zone. */
  today(): string {
    return localDate(this.deps.clock.now(), getFamilySettings(this.deps.db).timeZone);
  }

  async list(ownerId: number): Promise<Omit<TodoListResponse, 'owner'>> {
    const backend = this.backendFor(ownerId);
    const today = this.today();
    const since = new Date(this.deps.clock.now().getTime() - COMPLETED_VISIBLE_MS);
    const [open, completed] = await Promise.all([backend.listOpen(ownerId), backend.listCompletedSince(ownerId, since)]);
    return { today, groups: groupTodos(open, today), completed, todoist: this.deps.todoist?.freshness(ownerId) ?? null };
  }

  async summary(ownerId: number): Promise<TodoSummaryResponse> {
    const view = getSummaryView(this.deps.db, ownerId);
    const today = this.today();
    const matching = (await this.backendFor(ownerId).listOpen(ownerId))
      .filter((item) => inSummaryView(item, view, today))
      .sort(compareTodos);
    return {
      view,
      today,
      items: matching.slice(0, SUMMARY_LIMIT),
      more: Math.max(0, matching.length - SUMMARY_LIMIT),
      todoist: this.deps.todoist?.freshness(ownerId) ?? null,
    };
  }

  /** One live item on `ownerId`'s list, or null. */
  async get(ownerId: number, id: number): Promise<TodoItem | null> {
    return this.backendFor(ownerId).get(ownerId, id);
  }

  /** The live to-do linked to a chore occurrence on `ownerId`'s list, or null. For the Chores panel. */
  async findByChoreOccurrence(ownerId: number, choreOccurrenceId: number): Promise<TodoItem | null> {
    return this.backendFor(ownerId).findByChoreOccurrence(ownerId, choreOccurrenceId);
  }

  /**
   * The live to-do linked to a chore occurrence on anyone's list, or null. The Chores panel uses it
   * when a create hits the one-live-to-do-per-occurrence rule, to find a to-do left on a previous
   * assignee's list. It reads the `todos` table, where every backend keeps its rows (phase 4's
   * Todoist backend as a mirror), so it never calls an external service.
   */
  async findAnyByChoreOccurrence(choreOccurrenceId: number): Promise<TodoItem | null> {
    const row = this.deps.db
      .select()
      .from(todos)
      .where(and(eq(todos.choreOccurrenceId, choreOccurrenceId), isNull(todos.deletedAt)))
      .get();
    return row ? toTodoItem(row) : null;
  }

  /**
   * Where a to-do stands, deleted or not: for the Chores panel's reconcile, which catches up an
   * occurrence whose to-do event was never handled. Reads the `todos` table, like
   * `findAnyByChoreOccurrence`, so it never calls an external service. Null if there's no such row.
   */
  todoFate(id: number): { ownerUserId: number; completedAt: Date | null; deleted: boolean } | null {
    const row = this.deps.db.select().from(todos).where(eq(todos.id, id)).get();
    return row ? { ownerUserId: row.ownerUserId, completedAt: row.completedAt, deleted: row.deletedAt !== null } : null;
  }

  /**
   * `choreOccurrenceId` is for the Chores panel; the API never sets it. A second live
   * to-do for the same occurrence is rejected with AppError('conflict').
   */
  async create(
    actor: Actor,
    ownerId: number,
    input: CreateTodoInput,
    opts: { choreOccurrenceId?: number } = {},
  ): Promise<TodoItem> {
    return this.write(ownerId, (backend) => backend.create(ownerId, {
      title: input.title,
      notes: cleanNotes(input.notes),
      dueDate: input.dueDate ?? null,
      dueTime: input.dueDate ? (input.dueTime ?? null) : null,
      createdByUserId: actor.type === 'user' ? actor.userId : null,
      choreOccurrenceId: opts.choreOccurrenceId ?? null,
    }));
  }

  /**
   * Clearing the due date also clears the due time. Setting a due time on an item that
   * ends up with no due date is a validation error.
   */
  update(_actor: Actor, ownerId: number, id: number, patch: UpdateTodoInput): Promise<TodoItem> {
    return this.write(ownerId, (backend) => this.updateWith(backend, ownerId, id, patch));
  }

  private async updateWith(backend: TodoBackend, ownerId: number, id: number, patch: UpdateTodoInput): Promise<TodoItem> {
    const current = await this.require(backend, ownerId, id);
    const changes: TodoChanges = {};
    if (patch.title !== undefined) changes.title = patch.title;
    if (patch.notes !== undefined) changes.notes = cleanNotes(patch.notes);
    if (patch.dueDate !== undefined) changes.dueDate = patch.dueDate;
    if (patch.dueTime !== undefined) changes.dueTime = patch.dueTime;
    const dueDate = changes.dueDate !== undefined ? changes.dueDate : current.dueDate;
    if (dueDate === null) {
      if (patch.dueTime) throw new AppError('validation', 'Pick a date before setting a time');
      if (current.dueTime !== null) changes.dueTime = null;
    }
    return backend.update(ownerId, id, changes);
  }

  /**
   * The write is conditional, so only the request that actually completes the item emits an
   * event. Completing an item that is already complete returns it unchanged. So does completing a
   * Todoist task that repeats: Todoist moves it to its next date and it stays open (spec §10.6),
   * so it comes back open with the new date, and no event is emitted.
   */
  async complete(actor: Actor, ownerId: number, id: number): Promise<TodoItem> {
    const result = await this.write(ownerId, async (backend) => {
      const changed = await backend.complete(ownerId, id, this.deps.clock.now());
      return { changed, item: changed ?? (await this.require(backend, ownerId, id)) };
    });
    // Only an item that really is completed now (see TodoBackend: a dropped Todoist row comes back as it was).
    if (result.changed && result.changed.completedAt !== null) await this.emit('todo.completed', result.changed, actor);
    return result.item;
  }

  /** Conditional like `complete`. Reopening an item that is already open returns it unchanged. */
  async uncomplete(actor: Actor, ownerId: number, id: number): Promise<TodoItem> {
    const result = await this.write(ownerId, async (backend) => {
      const changed = await backend.reopen(ownerId, id);
      return { changed, item: changed ?? (await this.require(backend, ownerId, id)) };
    });
    if (result.changed && result.changed.completedAt === null) await this.emit('todo.uncompleted', result.changed, actor);
    return result.item;
  }

  /**
   * Members can't delete chore to-dos (spec §10.4); admins can, and the Chores panel treats that as
   * a skip. The system actor (the Chores panel itself) can always delete them.
   */
  async delete(actor: Actor, ownerId: number, id: number): Promise<void> {
    const removed = await this.write(ownerId, async (backend) => {
      const item = await this.require(backend, ownerId, id);
      if (item.choreOccurrenceId !== null && actor.type === 'user' && actor.role !== 'admin') {
        throw new AppError('forbidden', "Chore to-dos can't be deleted. Complete it, or ask an admin to skip the chore.");
      }
      return backend.remove(ownerId, id);
    });
    await this.emit('todo.deleted', removed, actor);
  }

  /**
   * For changes that happened somewhere else and have already been saved locally. Todoist sync
   * applies each incoming change to the mirror, then (once its per-user lock is released) calls
   * this with the item as it was (`before`, null if it's new) and as it is now (`after`, null if
   * it was deleted), and `{ type: 'todoist' }`. Both come from the mirror, never from a deleted
   * item's blanked fields. The diff decides which event, if any, to emit for chore-linked items.
   */
  async applyRemoteChange(before: TodoItem | null, after: TodoItem | null, actor: Actor): Promise<void> {
    if (before && !after) {
      await this.emit('todo.deleted', before, actor);
    } else if (before && after) {
      if (before.completedAt === null && after.completedAt !== null) await this.emit('todo.completed', after, actor);
      else if (before.completedAt !== null && after.completedAt === null) await this.emit('todo.uncompleted', after, actor);
    }
  }

  /**
   * Runs a write on the owner's backend. If it was the Todoist one and the link was gone by the
   * time the write got the person's lock (an unlink ran while it waited), the rows are internal
   * now, so the backend is picked again, once, and the write runs there instead of failing.
   */
  private async write<T>(ownerId: number, fn: (backend: TodoBackend) => Promise<T>): Promise<T> {
    const backend = this.backendFor(ownerId);
    try {
      return await fn(backend);
    } catch (err) {
      const unlinked = backend.kind === 'todoist' && err instanceof AppError && err.code === 'integration_unavailable' && err.message === TODOIST_MESSAGES.notLinked;
      const now = this.backendFor(ownerId);
      if (!unlinked || now.kind !== 'internal') throw err;
      return fn(now);
    }
  }

  private async require(backend: TodoBackend, ownerId: number, id: number): Promise<TodoItem> {
    const item = await backend.get(ownerId, id);
    if (!item) throw new AppError('not_found', 'To-do not found.');
    return item;
  }

  private async emit(event: EventName, item: TodoItem, actor: Actor): Promise<void> {
    if (item.choreOccurrenceId === null) return;
    await this.deps.events.emit(event, { item, actor });
  }
}
