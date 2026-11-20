import { describe, expect, it } from 'vitest';
import type { TodoItem } from '../../../shared/todo.js';
import { groupByProject, spansProjects } from './projectGroups.js';

function item(id: number, todoistProjectId: string | null): TodoItem {
  return {
    id, ownerUserId: 1, title: `Item ${id}`, notes: null, dueDate: null, dueTime: null, completedAt: null,
    createdAt: '2026-11-15T12:00:00.000Z', createdByUserId: 1, choreOccurrenceId: null, todoistProjectId, recurring: false,
  };
}

describe('groupByProject', () => {
  it('groups by project in the list order, keeping date order, with unknown projects and unmoved items last', () => {
    const todoist = {
      status: 'ok' as const, lastSyncAt: null, serverNow: '2026-11-15T12:00:00.000Z',
      projects: [{ id: 'in', name: 'Inbox' }, { id: 'ch', name: 'Chores' }, { id: 'em', name: 'Empty' }],
    };
    const groups = { overdue: [item(1, 'ch')], today: [item(2, 'in'), item(3, 'new')], upcoming: [item(4, 'ch')], none: [item(5, null)] };
    expect(groupByProject(groups, todoist).map((s) => [s.key, s.label, s.items.map((i) => i.id)])).toEqual([
      ['project-in', 'Inbox', [2]],
      ['project-ch', 'Chores', [1, 4]],
      ['project-new', 'Other project', [3]],
      ['project-none', 'Not in Todoist yet', [5]],
    ]);
  });
});

describe('spansProjects', () => {
  const empty = { overdue: [], today: [], upcoming: [], none: [] };

  it('is false for an empty list, or one whose open items are all in one project', () => {
    expect(spansProjects(empty)).toBe(false);
    expect(spansProjects({ ...empty, today: [item(1, 'in')], none: [item(2, 'in')] })).toBe(false);
  });

  it("doesn't count items that aren't in Todoist yet as a project", () => {
    expect(spansProjects({ ...empty, today: [item(1, 'in')], none: [item(2, null)] })).toBe(false);
  });

  it('is true once open items are in two projects, in any group', () => {
    expect(spansProjects({ ...empty, overdue: [item(1, 'in')], upcoming: [item(2, 'ch')] })).toBe(true);
  });
});
