import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ChoreTag } from './ChoreTag.js';
import { TodoistStatus } from './TodoistStatus.js';
import { formatDue, isOverdue } from './format.js';
import {
  todoMutationKeys, useCompleteFromSummary, usePendingTodoIds, useTodoMutations, useTodoSummary,
  type TodoMutationAction,
} from './queries.js';

/** Home card (spec §10.3): the signed-in person's own items, quick add, and checkboxes. */
export function TodoSummary() {
  const summary = useTodoSummary();
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState('');
  const onError = (action: TodoMutationAction, err: Error) =>
    setError(action === 'complete' ? `Couldn't complete that to-do. ${err.message}` : err.message);
  const { create } = useTodoMutations(undefined, { onError });
  const complete = useCompleteFromSummary({ onError });
  const pending = usePendingTodoIds(todoMutationKeys.setDone);

  function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    setError(null);
    setAdded('');
    // The Add button is disabled while a create is in flight, so this is always the latest call.
    create.mutate({ title: trimmed }, {
      onSuccess: (item) => {
        setTitle('');
        setAdded(`Added: ${item.title}`);
      },
    });
  }

  function onCheck(id: number) {
    setError(null);
    complete.mutate({ id });
  }

  return (
    <div className="todo-summary">
      {error && <p className="error" role="alert">{error}</p>}
      {summary.isPending && <p className="muted">Loading…</p>}
      {summary.error && <p className="error">{summary.error.message}</p>}
      {summary.data?.todoist && <TodoistStatus todoist={summary.data.todoist} receivedAt={summary.dataUpdatedAt} />}
      {summary.data && (
        <>
          {summary.data.items.length === 0 && <p className="muted">Nothing to do.</p>}
          <ul className="todo-list">
            {summary.data.items.map((item) => {
              const due = formatDue(item, summary.data.today);
              const done = item.completedAt !== null;
              return (
                <li key={item.id} className={done ? 'todo-row done' : 'todo-row'}>
                  <input
                    type="checkbox"
                    aria-label={`Complete ${item.title}`}
                    checked={done}
                    disabled={done || pending.has(item.id)}
                    onChange={() => onCheck(item.id)}
                  />
                  <span className="todo-main">
                    <span className="todo-title">{item.title}</span>
                    <span className="todo-meta">
                      {due && <span className={isOverdue(item, summary.data.today) ? 'todo-due overdue' : 'todo-due'}>{due}</span>}
                      {item.choreOccurrenceId !== null && <ChoreTag title={item.title} />}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
          {summary.data.more > 0 && (
            <Link to="/$panelId" params={{ panelId: 'todo' }} className="todo-more">
              +{summary.data.more} more
            </Link>
          )}
        </>
      )}
      <form className="todo-quick-add" onSubmit={onAdd}>
        <input
          aria-label="New to-do"
          placeholder="Add a to-do"
          maxLength={500}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setAdded('');
          }}
        />
        <button type="submit" disabled={create.isPending || title.trim() === ''}>Add</button>
      </form>
      <p role="status" className="muted todo-status">{added}</p>
    </div>
  );
}
