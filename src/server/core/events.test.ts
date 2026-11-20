import { describe, expect, it } from 'vitest';
import type { TodoItem } from '../../shared/todo.js';
import { EventBus, type EventName, type TodoEvent } from './events.js';

const item: TodoItem = {
  id: 1,
  ownerUserId: 2,
  title: 'Empty the dishwasher',
  notes: null,
  dueDate: '2026-11-15',
  dueTime: null,
  completedAt: null,
  createdAt: '2026-11-15T12:00:00.000Z',
  createdByUserId: 2,
  choreOccurrenceId: 9,
  todoistProjectId: null,
  recurring: false,
};
const event: TodoEvent = { item, actor: { type: 'user', userId: 2, role: 'member' } };

describe('EventBus', () => {
  it('delivers payloads to subscribers of that event only, in order', async () => {
    const bus = new EventBus(() => {});
    const seen: string[] = [];
    bus.on('todo.completed', (e) => { seen.push(`a:${e.item.id}`); });
    bus.on('todo.completed', async (e) => { await Promise.resolve(); seen.push(`b:${e.item.id}`); });
    bus.on('todo.deleted', () => { seen.push('deleted'); });
    await bus.emit('todo.completed', event);
    expect(seen).toEqual(['a:1', 'b:1']);
  });

  it('unsubscribes', async () => {
    const bus = new EventBus(() => {});
    let calls = 0;
    const off = bus.on('todo.uncompleted', () => { calls++; });
    await bus.emit('todo.uncompleted', event);
    off();
    await bus.emit('todo.uncompleted', event);
    expect(calls).toBe(1);
  });

  it('reports a failing handler and still runs the rest', async () => {
    const errors: [EventName, unknown][] = [];
    const bus = new EventBus((name, err) => errors.push([name, err]));
    let ran = false;
    bus.on('todo.deleted', () => { throw new Error('boom'); });
    bus.on('todo.deleted', () => { ran = true; });
    await expect(bus.emit('todo.deleted', event)).resolves.toBeUndefined();
    expect(ran).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]![0]).toBe('todo.deleted');
    expect((errors[0]![1] as Error).message).toBe('boom');
  });

  it('does nothing when there are no subscribers', async () => {
    await expect(new EventBus(() => {}).emit('todo.completed', event)).resolves.toBeUndefined();
  });
});
