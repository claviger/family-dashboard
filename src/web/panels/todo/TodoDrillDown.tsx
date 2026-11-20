import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { TodoistFreshness } from '../../../shared/integrations.js';
import type { TodoGroupKey, TodoGroups, TodoItem } from '../../../shared/todo.js';
import { useMe } from '../../shell/useMe.js';
import { ChoreTag } from './ChoreTag.js';
import { formatDue, isOverdue } from './format.js';
import { groupByProject, spansProjects, type TodoSection } from './projectGroups.js';
import {
  todoMutationKeys, usePendingTodoIds, useTodoList, useTodoMutations, useTodoPeople, type TodoMutationAction,
} from './queries.js';
import { SummaryViewPicker } from './SummaryViewPicker.js';
import { ProjectTag, TodoistStatus } from './TodoistStatus.js';
import { EMPTY_TODO_FORM, TodoForm, toFormValues, toTodoInput, toTodoPatch } from './TodoForm.js';
import { Avatar } from '../../shell/Avatar.js';

const GROUPS: { key: TodoGroupKey; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'none', label: 'No date' },
];

const ERROR_PREFIX: Record<TodoMutationAction, string> = {
  create: '',
  update: '',
  complete: "Couldn't complete that to-do. ",
  uncomplete: "Couldn't reopen that to-do. ",
  remove: "Couldn't delete that to-do. ",
};

/** A repeating Todoist task's date can only change in Todoist (the server refuses it too). */
const REPEATS_NOTE = 'This repeats in Todoist. Change its date in Todoist.';

/**
 * Drill-down (spec §10.4). Admins pick whose list to see; the choice is `?userId=` in the URL.
 * For a list in Todoist that spans more than one project, `?group=project` groups by Todoist
 * project instead of by date.
 */
export function TodoDrillDown() {
  const me = useMe().data!;
  const isAdmin = me.user.role === 'admin';
  const search = useSearch({ from: '/$panelId' });
  const navigate = useNavigate({ from: '/$panelId' });
  const userId = isAdmin && search.userId !== me.user.id ? search.userId : undefined;
  const viewingSelf = userId === undefined;

  const list = useTodoList(userId);
  const todoist = list.data?.todoist ?? null;
  // The toggle only shows when the list spans more than one project (only the Inbox and chore
  // to-dos sync); `?group=project` left in the URL does nothing otherwise.
  const canGroup = todoist !== null && list.data !== undefined && spansProjects(list.data.groups);
  const byProject = canGroup && search.group === 'project';
  const people = useTodoPeople(isAdmin);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [addKey, setAddKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  // Focus management. Elements register by key; a pending focus request is retried after
  // every render until it finds its target, then cleared.
  const els = useRef(new Map<string, HTMLElement>());
  const focusRequest = useRef<(() => HTMLElement | null | undefined) | null>(null);
  const deleteFocus = useRef<{ id: number } | null>(null);
  useEffect(() => {
    const target = focusRequest.current?.();
    if (target) {
      focusRequest.current = null;
      target.focus();
    }
  });
  function reg(key: string) {
    return (el: HTMLElement | null) => {
      if (!el) return;
      els.current.set(key, el);
      return () => {
        if (els.current.get(key) === el) els.current.delete(key);
      };
    };
  }

  const { create, update, setDone, remove } = useTodoMutations(userId, {
    onError: (action, err, id) => {
      if (action === 'update') {
        setEditError(err.message);
        return;
      }
      if (action === 'remove' && deleteFocus.current?.id === id) deleteFocus.current = null;
      setError(ERROR_PREFIX[action] + err.message);
    },
  });
  const pendingDone = usePendingTodoIds(todoMutationKeys.setDone);
  const pendingRemove = usePendingTodoIds(todoMutationKeys.remove);

  const ownerName = viewingSelf
    ? me.user.displayName
    : (people.data?.find((p) => p.id === userId)?.displayName ?? list.data?.owner.displayName);
  const owner = viewingSelf ? undefined : people.data?.find((p) => p.id === userId);
  const ownerInPeople = viewingSelf || people.data?.some((p) => p.id === userId);

  function stopEditing(id: number) {
    setEditingId(null);
    setEditError(null);
    focusRequest.current = () => els.current.get(`edit-${id}`);
  }

  function confirmDelete(item: TodoItem, group: string, after: number[]) {
    // Deleting an open chore to-do skips its occurrence; a completed one's occurrence is already
    // closed, so deleting it only removes the to-do.
    const question = item.choreOccurrenceId === null
      ? `Delete "${item.title}"? This can't be undone.`
      : item.completedAt === null
        ? `Delete "${item.title}"? This skips the chore.`
        : `Delete "${item.title}"? This only removes the to-do; the chore isn't changed.`;
    if (!window.confirm(question)) return;
    setError(null);
    const request = { id: item.id };
    deleteFocus.current = request;
    // Once the row is gone, focus the next row in its group, else that group's heading, else
    // the first remaining group's heading, else the list heading or the add form's title.
    focusRequest.current = () => {
      if (deleteFocus.current !== request) return null;
      if (els.current.has(`row-${item.id}`)) return null;
      deleteFocus.current = null;
      for (const id of after) {
        const next = els.current.get(`check-${id}`);
        if (next) return next;
      }
      return els.current.get(`heading-${group}`)
        ?? [...els.current.entries()].find(([key]) => key.startsWith('heading-'))?.[1]
        ?? els.current.get('owner-heading')
        ?? els.current.get('add-title');
    };
    remove.mutate({ id: item.id });
  }

  function row(item: TodoItem, today: string, group: string, after: number[]) {
    if (editingId === item.id) {
      return (
        <li key={item.id} ref={reg(`row-${item.id}`)} className="todo-row editing">
          <TodoForm
            name={`Edit ${item.title}`}
            initial={toFormValues(item)}
            submitLabel="Save"
            busy={update.isPending}
            error={editError}
            dateLocked={item.recurring ? REPEATS_NOTE : undefined}
            autoFocus
            onCancel={() => stopEditing(item.id)}
            onSubmit={(v) => {
              setEditError(null);
              // Save is disabled while an update is in flight, so this is always the latest call.
              update.mutate({ id: item.id, patch: toTodoPatch(v, item.recurring) }, { onSuccess: () => stopEditing(item.id) });
            }}
          />
        </li>
      );
    }
    const due = formatDue(item, today);
    const deleting = pendingRemove.has(item.id);
    // Spec §10.4: members can complete chore to-dos but not delete them.
    const canDelete = item.choreOccurrenceId === null || isAdmin;
    return (
      <li key={item.id} ref={reg(`row-${item.id}`)} className="todo-row">
        <input
          ref={reg(`check-${item.id}`)}
          type="checkbox"
          aria-label={`Complete ${item.title}`}
          checked={false}
          disabled={pendingDone.has(item.id) || deleting}
          onChange={() => { setError(null); setDone.mutate({ id: item.id, done: true }); }}
        />
        <span className="todo-main">
          <span className="todo-title">{item.title}</span>
          <span className="todo-meta">
            {due && <span className={isOverdue(item, today) ? 'todo-due overdue' : 'todo-due'}>{due}</span>}
            {item.recurring && <span className="project-tag">Repeats</span>}
            {item.choreOccurrenceId !== null && <ChoreTag title={item.title} />}
            {todoist && !byProject && <ProjectTag projectId={item.todoistProjectId} todoist={todoist} />}
          </span>
          {item.notes && <span className="todo-notes muted">{item.notes}</span>}
        </span>
        <span className="todo-actions">
          <button
            ref={reg(`edit-${item.id}`)}
            type="button"
            aria-label={`Edit ${item.title}`}
            disabled={deleting}
            onClick={() => { setError(null); setEditError(null); setEditingId(item.id); }}
          >
            Edit
          </button>
          {canDelete && (
            <button
              type="button"
              aria-label={`Delete ${item.title}`}
              disabled={deleting}
              onClick={() => confirmDelete(item, group, after)}
            >
              Delete
            </button>
          )}
        </span>
      </li>
    );
  }

  return (
    <div className="todo-drilldown">
      <div className="todo-toolbar form-row">
        {isAdmin && people.data && (
          <label>
            Person
            <select
              value={ownerInPeople ? String(userId ?? me.user.id) : ''}
              onChange={(e) => {
                const id = Number(e.target.value);
                setEditingId(null);
                setEditError(null);
                setError(null);
                setAddKey(0);
                void navigate({ search: id === me.user.id ? {} : { userId: id } });
              }}
            >
              {!ownerInPeople && <option value="" disabled>Choose a person</option>}
              {people.data.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
            </select>
          </label>
        )}
        {viewingSelf && <SummaryViewPicker />}
        {canGroup && (
          <button
            type="button"
            aria-pressed={byProject}
            onClick={() => void navigate({ search: { ...search, group: byProject ? undefined : 'project' } })}
          >
            Group by project
          </button>
        )}
      </div>
      {viewingSelf && <p className="muted">Admins can see and edit your to-do list.</p>}
      {todoist && <TodoistStatus todoist={todoist} receivedAt={list.dataUpdatedAt} ownerName={viewingSelf ? undefined : ownerName} />}
      {!viewingSelf && ownerName && (
        <div className="todo-group-head">
          {owner && <Avatar person={owner} />}
          <h3 ref={reg('owner-heading')} tabIndex={-1}>{ownerName}'s list</h3>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      {!list.error && (
        <TodoForm
          key={`${userId ?? 'me'}-${addKey}`}
          name="Add a to-do"
          initial={EMPTY_TODO_FORM}
          submitLabel={viewingSelf || !ownerName ? 'Add' : `Add to ${ownerName}'s list`}
          busy={create.isPending}
          // After an add the form remounts empty, with its title field focused.
          autoFocus={addKey > 0}
          titleRef={reg('add-title')}
          onSubmit={(v) => {
            setError(null);
            // Add is disabled while a create is in flight, so this is always the latest call.
            create.mutate(toTodoInput(v), { onSuccess: () => setAddKey((k) => k + 1) });
          }}
        />
      )}

      {list.isPending && <p className="muted">Loading…</p>}
      {list.error && <p className="error">{list.error.message}</p>}
      {list.data && (
        <>
          {GROUPS.every((g) => list.data.groups[g.key].length === 0) && <p className="muted">Nothing to do.</p>}
          {sectionsOf(list.data.groups, byProject ? todoist : null).map((g) => (
            <section key={g.key} className="todo-group" aria-label={g.label}>
              <h3 ref={reg(`heading-${g.key}`)} tabIndex={-1}>{g.label} <span className="muted">({g.items.length})</span></h3>
              <ul className="todo-list">
                {g.items.map((item, i) => row(item, list.data.today, g.key, g.items.slice(i + 1).map((n) => n.id)))}
              </ul>
            </section>
          ))}
          {list.data.completed.length > 0 && (
            <details className="todo-completed">
              <summary>Completed in the last 7 days ({list.data.completed.length})</summary>
              <ul className="todo-list">
                {list.data.completed.map((item) => (
                  <li key={item.id} className="todo-row done">
                    <span className="todo-main"><span className="todo-title">{item.title}</span></span>
                    <span className="todo-actions">
                      <button
                        type="button"
                        aria-label={`Reopen ${item.title}`}
                        disabled={pendingDone.has(item.id)}
                        onClick={() => { setError(null); setDone.mutate({ id: item.id, done: false }); }}
                      >
                        Reopen
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** The open items' sections: by date (spec §10.4's four groups), or by Todoist project. Empty sections are left out. */
function sectionsOf(groups: TodoGroups, todoist: TodoistFreshness | null): TodoSection[] {
  if (todoist) return groupByProject(groups, todoist);
  return GROUPS.map((g) => ({ key: g.key, label: g.label, items: groups[g.key] })).filter((s) => s.items.length > 0);
}
