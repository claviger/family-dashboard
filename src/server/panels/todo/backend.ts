import type { TodoItem } from '../../../shared/todo.js';

/** A new item, already validated and normalized by TodoService. */
export interface NewTodo {
  title: string;
  notes: string | null;
  dueDate: string | null;
  dueTime: string | null;
  /** Null when the system actor creates it. */
  createdByUserId: number | null;
  choreOccurrenceId: number | null;
}

/** Field changes, already merged and checked by TodoService. Omitted fields stay as they are. */
export type TodoChanges = Partial<Pick<NewTodo, 'title' | 'notes' | 'dueDate' | 'dueTime'>>;

/**
 * Where one person's to-do items live (spec §3.3). Phase 2 has only the internal SQLite backend;
 * phase 4 adds Todoist. Every method is scoped to `ownerId`: an id that belongs to someone else
 * behaves as missing.
 *
 * `complete` and `reopen` are conditional: they change the item only if it's in the other state,
 * and return null when nothing changed (already in that state, or missing). That lets TodoService
 * emit exactly one event even when two requests race.
 *
 * One Todoist exception: when the write's own response showed the task outside the mirror's scope
 * (moved out of the Inbox meanwhile), the row is dropped, and the write returns it as it was just
 * before, in whatever state it's in (a repeating task stays open). There's no row left to read
 * back. Such a row is never chore-linked, and TodoService only emits when the returned item is
 * in the new state.
 */
export interface TodoBackend {
  readonly kind: 'internal' | 'todoist';
  listOpen(ownerId: number): Promise<TodoItem[]>;
  /** Items completed at or after `since`, most recent first. */
  listCompletedSince(ownerId: number, since: Date): Promise<TodoItem[]>;
  get(ownerId: number, id: number): Promise<TodoItem | null>;
  /** The live item linked to a chore occurrence, if any. */
  findByChoreOccurrence(ownerId: number, choreOccurrenceId: number): Promise<TodoItem | null>;
  /** Throws AppError('conflict') if a live item already has the same choreOccurrenceId. */
  create(ownerId: number, todo: NewTodo): Promise<TodoItem>;
  /** Throws AppError('not_found') when the item is missing. */
  update(ownerId: number, id: number, changes: TodoChanges): Promise<TodoItem>;
  /** Marks an open item complete. Returns the changed item, or null if nothing changed. */
  complete(ownerId: number, id: number, completedAt: Date): Promise<TodoItem | null>;
  /** Reopens a completed item. Returns the changed item, or null if nothing changed. */
  reopen(ownerId: number, id: number): Promise<TodoItem | null>;
  /** Deletes the item and returns it as it was. Throws AppError('not_found') when it's missing. */
  remove(ownerId: number, id: number): Promise<TodoItem>;
}
