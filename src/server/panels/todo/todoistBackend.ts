import { and, desc, eq, gte, isNotNull, isNull } from 'drizzle-orm';
import type { TodoItem } from '../../../shared/todo.js';
import type { Db } from '../../db/index.js';
import { todos } from '../../db/schema.js';
import type { Todoist } from '../../integrations/todoist/todoist.js';
import type { NewTodo, TodoBackend, TodoChanges } from './backend.js';
import { toTodoItem } from './internalBackend.js';

/**
 * Spec §10.6: the to-do list of someone linked to Todoist.
 *
 * Every read is local: the mirror rows in `todos`, so the Chores panel's handlers and lookups
 * (`get`, `findByChoreOccurrence`, `TodoService.findAnyByChoreOccurrence`) never wait on Todoist.
 * Reads cover every live row the person owns, including rows still `internal`: open to-dos from
 * before linking that haven't moved into Todoist yet (they move on the next write or sync), and
 * completed ones, which stay as history.
 *
 * Every write goes to Todoist first, through `Todoist` (integrations/todoist/todoist.ts), and the
 * mirror is updated from Todoist's response. A failed write throws and changes nothing locally.
 */
export class TodoistBackend implements TodoBackend {
  readonly kind = 'todoist' as const;

  constructor(
    private readonly deps: { db: Db },
    private readonly todoist: Todoist,
  ) {}

  private mine(ownerId: number) {
    return and(eq(todos.ownerUserId, ownerId), isNull(todos.deletedAt));
  }

  async listOpen(ownerId: number): Promise<TodoItem[]> {
    return this.deps.db.select().from(todos).where(and(this.mine(ownerId), isNull(todos.completedAt))).all().map(toTodoItem);
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
    const row = this.deps.db.select().from(todos).where(and(this.mine(ownerId), eq(todos.choreOccurrenceId, choreOccurrenceId))).get();
    return row ? toTodoItem(row) : null;
  }

  create(ownerId: number, todo: NewTodo): Promise<TodoItem> {
    return this.todoist.createTask(ownerId, todo);
  }

  update(ownerId: number, id: number, changes: TodoChanges): Promise<TodoItem> {
    return this.todoist.updateTask(ownerId, id, changes);
  }

  /** Decided from the mirror: Todoist answers "ok" to closing a closed task (verified live). */
  complete(ownerId: number, id: number, completedAt: Date): Promise<TodoItem | null> {
    return this.todoist.closeTask(ownerId, id, completedAt);
  }

  reopen(ownerId: number, id: number): Promise<TodoItem | null> {
    return this.todoist.reopenTask(ownerId, id);
  }

  remove(ownerId: number, id: number): Promise<TodoItem> {
    return this.todoist.deleteTask(ownerId, id);
  }
}
