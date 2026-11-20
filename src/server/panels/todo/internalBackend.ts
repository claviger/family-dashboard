import { and, desc, eq, gte, isNotNull, isNull } from 'drizzle-orm';
import type { TodoItem } from '../../../shared/todo.js';
import type { Clock } from '../../core/clock.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import { todos, type TodoRow } from '../../db/schema.js';
import type { NewTodo, TodoBackend, TodoChanges } from './backend.js';

export function toTodoItem(row: TodoRow): TodoItem {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    title: row.title,
    notes: row.notes,
    dueDate: row.dueDate,
    dueTime: row.dueTime,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    createdByUserId: row.createdByUserId,
    choreOccurrenceId: row.choreOccurrenceId,
    todoistProjectId: row.backend === 'todoist' ? row.todoistProjectId : null,
    recurring: row.backend === 'todoist' && row.todoistRecurring,
  };
}

function notFound(): AppError {
  return new AppError('not_found', 'To-do not found.');
}

/** better-sqlite3's unique-constraint error, possibly wrapped by Drizzle as `cause`. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if ((e as Error & { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  }
  return false;
}

/** Spec §10.5: items for people not linked to Todoist, stored in the `todos` table. */
export class InternalTodoBackend implements TodoBackend {
  readonly kind = 'internal' as const;

  constructor(private readonly deps: { db: Db; clock: Clock }) {}

  /** Live internal rows for one owner. */
  private mine(ownerId: number) {
    return and(eq(todos.ownerUserId, ownerId), eq(todos.backend, 'internal'), isNull(todos.deletedAt));
  }

  async listOpen(ownerId: number): Promise<TodoItem[]> {
    return this.deps.db
      .select()
      .from(todos)
      .where(and(this.mine(ownerId), isNull(todos.completedAt)))
      .all()
      .map(toTodoItem);
  }

  async listCompletedSince(ownerId: number, since: Date): Promise<TodoItem[]> {
    return this.deps.db
      .select()
      .from(todos)
      .where(and(this.mine(ownerId), isNotNull(todos.completedAt), gte(todos.completedAt, since)))
      .orderBy(desc(todos.completedAt), desc(todos.id))
      .all()
      .map(toTodoItem);
  }

  async get(ownerId: number, id: number): Promise<TodoItem | null> {
    const row = this.deps.db.select().from(todos).where(and(this.mine(ownerId), eq(todos.id, id))).get();
    return row ? toTodoItem(row) : null;
  }

  async findByChoreOccurrence(ownerId: number, choreOccurrenceId: number): Promise<TodoItem | null> {
    const row = this.deps.db
      .select()
      .from(todos)
      .where(and(this.mine(ownerId), eq(todos.choreOccurrenceId, choreOccurrenceId)))
      .get();
    return row ? toTodoItem(row) : null;
  }

  async create(ownerId: number, todo: NewTodo): Promise<TodoItem> {
    const now = this.deps.clock.now();
    try {
      const row = this.deps.db
        .insert(todos)
        .values({ ...todo, ownerUserId: ownerId, backend: 'internal', createdAt: now, updatedAt: now })
        .returning()
        .get();
      return toTodoItem(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('conflict', 'That chore already has a to-do.');
      throw err;
    }
  }

  async update(ownerId: number, id: number, changes: TodoChanges): Promise<TodoItem> {
    const row = this.deps.db
      .update(todos)
      .set({ ...changes, updatedAt: this.deps.clock.now() })
      .where(and(this.mine(ownerId), eq(todos.id, id)))
      .returning()
      .get();
    if (!row) throw notFound();
    return toTodoItem(row);
  }

  async complete(ownerId: number, id: number, completedAt: Date): Promise<TodoItem | null> {
    const row = this.deps.db
      .update(todos)
      .set({ completedAt, updatedAt: this.deps.clock.now() })
      .where(and(this.mine(ownerId), eq(todos.id, id), isNull(todos.completedAt)))
      .returning()
      .get();
    return row ? toTodoItem(row) : null;
  }

  async reopen(ownerId: number, id: number): Promise<TodoItem | null> {
    const row = this.deps.db
      .update(todos)
      .set({ completedAt: null, updatedAt: this.deps.clock.now() })
      .where(and(this.mine(ownerId), eq(todos.id, id), isNotNull(todos.completedAt)))
      .returning()
      .get();
    return row ? toTodoItem(row) : null;
  }

  async remove(ownerId: number, id: number): Promise<TodoItem> {
    const now = this.deps.clock.now();
    const row = this.deps.db
      .update(todos)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(this.mine(ownerId), eq(todos.id, id)))
      .returning()
      .get();
    if (!row) throw notFound();
    return toTodoItem(row);
  }
}
