import type { Role } from '../../shared/api.js';
import type { TodoItem } from '../../shared/todo.js';

/**
 * Who made a change:
 * - `user`: a dashboard user acting through the API, with their role (some rules differ for admins)
 * - `system`: the app itself, e.g. the Chores panel creating or removing a chore's to-do (phase 3)
 * - `todoist`: a change that arrived through Todoist sync (phase 4)
 *
 * Subscribers can ignore events they caused themselves by checking the actor.
 */
export type Actor = { type: 'user'; userId: number; role: Role } | { type: 'system' } | { type: 'todoist' };

export interface TodoEvent {
  item: TodoItem;
  actor: Actor;
}

/** Every in-process event and its payload. Spec §3.3 and §10.7. */
export interface DomainEvents {
  'todo.completed': TodoEvent;
  'todo.uncompleted': TodoEvent;
  'todo.deleted': TodoEvent;
  /**
   * An admin deactivated a user (spec §2), e.g. so the Chores panel can release their chores.
   * Handlers add a plain message to `warnings` for anything the admin should know about, such as
   * chore to-dos that couldn't be removed; the admin route returns them.
   */
  'user.deactivated': { userId: number; warnings: string[] };
}

export type EventName = keyof DomainEvents;
export type EventHandler<K extends EventName> = (payload: DomainEvents[K]) => void | Promise<void>;

/**
 * A small typed in-process event bus.
 *
 * `emit` runs handlers one at a time, in subscription order, and waits for each.
 * A handler that throws is reported to `onError` and does not stop the others or
 * fail the emitter: by the time an event is emitted, the change it describes has
 * already been saved.
 */
export class EventBus {
  private readonly handlers = new Map<EventName, Set<(payload: never) => void | Promise<void>>>();

  constructor(private readonly onError: (event: EventName, err: unknown) => void) {}

  /** Subscribes `handler` to `event`. Returns a function that unsubscribes it. */
  on<K extends EventName>(event: K, handler: EventHandler<K>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    this.handlers.set(event, set);
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  async emit<K extends EventName>(event: K, payload: DomainEvents[K]): Promise<void> {
    const handlers = [...(this.handlers.get(event) ?? [])] as EventHandler<K>[];
    for (const handler of handlers) {
      try {
        await handler(payload);
      } catch (err) {
        this.onError(event, err);
      }
    }
  }
}
