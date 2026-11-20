import { describe, expect, it } from 'vitest';
import type { TodoItem } from '../../../shared/todo.js';
import { compareTodos, groupOf, groupTodos, inSummaryView } from './buckets.js';

const TODAY = '2026-11-15';

let nextId = 1;
function item(over: Partial<TodoItem> = {}): TodoItem {
  const id = nextId++;
  return {
    id,
    ownerUserId: 1,
    title: `Item ${id}`,
    notes: null,
    dueDate: null,
    dueTime: null,
    completedAt: null,
    createdAt: '2026-11-10T12:00:00.000Z',
    createdByUserId: 1,
    choreOccurrenceId: null,
    todoistProjectId: null,
    recurring: false,
    ...over,
  };
}

describe('groupOf', () => {
  it('puts items in overdue, today, upcoming, or none by local date', () => {
    expect(groupOf({ dueDate: '2026-11-14' }, TODAY)).toBe('overdue');
    expect(groupOf({ dueDate: '2025-12-31' }, TODAY)).toBe('overdue');
    expect(groupOf({ dueDate: TODAY }, TODAY)).toBe('today');
    expect(groupOf({ dueDate: '2026-11-16' }, TODAY)).toBe('upcoming');
    expect(groupOf({ dueDate: null }, TODAY)).toBe('none');
  });
});

describe('compareTodos', () => {
  it('sorts by date, then timed before untimed, then creation, with undated last', () => {
    const undatedOld = item({ title: 'undated old', createdAt: '2026-11-01T00:00:00.000Z' });
    const undatedNew = item({ title: 'undated new', createdAt: '2026-11-12T00:00:00.000Z' });
    const overdue = item({ title: 'overdue', dueDate: '2026-11-13' });
    const todayUntimed = item({ title: 'today untimed', dueDate: TODAY });
    const todayLate = item({ title: 'today 18:00', dueDate: TODAY, dueTime: '18:00' });
    const todayEarly = item({ title: 'today 07:30', dueDate: TODAY, dueTime: '07:30' });
    const tomorrow = item({ title: 'tomorrow', dueDate: '2026-11-16' });
    const sorted = [undatedNew, tomorrow, todayUntimed, undatedOld, todayLate, overdue, todayEarly].sort(compareTodos);
    expect(sorted.map((i) => i.title)).toEqual([
      'overdue', 'today 07:30', 'today 18:00', 'today untimed', 'tomorrow', 'undated old', 'undated new',
    ]);
  });

  it('breaks exact ties by id', () => {
    const a = item({ dueDate: TODAY });
    const b = item({ dueDate: TODAY });
    expect([b, a].sort(compareTodos)).toEqual([a, b]);
  });
});

describe('inSummaryView', () => {
  const cases: [string | null, Record<string, boolean>][] = [
    ['2026-11-01', { overdue_today_undated: true, overdue_today: true, next_7_days: true, everything: true }],
    [TODAY, { overdue_today_undated: true, overdue_today: true, next_7_days: true, everything: true }],
    ['2026-11-21', { overdue_today_undated: false, overdue_today: false, next_7_days: true, everything: true }],
    ['2026-11-22', { overdue_today_undated: false, overdue_today: false, next_7_days: false, everything: true }],
    [null, { overdue_today_undated: true, overdue_today: false, next_7_days: false, everything: true }],
  ];
  it.each(cases)('due %s', (dueDate, expected) => {
    for (const [view, want] of Object.entries(expected)) {
      expect(inSummaryView({ dueDate }, view as never, TODAY), view).toBe(want);
    }
  });
});

describe('groupTodos', () => {
  it('fills every group in sorted order', () => {
    const later = item({ dueDate: '2026-11-20' });
    const sooner = item({ dueDate: '2026-11-17' });
    const overdue = item({ dueDate: '2026-11-14' });
    const today = item({ dueDate: TODAY });
    const none = item();
    const groups = groupTodos([later, none, today, sooner, overdue], TODAY);
    expect(groups).toEqual({ overdue: [overdue], today: [today], upcoming: [sooner, later], none: [none] });
  });
});
