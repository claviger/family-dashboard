import { useState } from 'react';
import { CATEGORY_NAME_MAX, type Category } from '../../../shared/spend.js';
import { useFocusRegistry } from '../chores/useFocus.js';
import { movedLine } from './format.js';
import { useSpendCategories, useSpendWrite, type SpendWrite } from './queries.js';

/** "add", "delete", or "save", for "Couldn't … X". */
function failedVerb(v: SpendWrite): string {
  if (v.method === 'DELETE') return 'delete';
  if (v.method === 'POST' && !/\/(archive|unarchive|move|apply)$/.test(v.path)) return 'add';
  return 'save';
}

const KIND_NOTES: Record<Category['kind'], string> = {
  normal: '',
  excluded: "Not counted in totals. Can't be archived or deleted.",
  uncategorized: "Where transactions go when nothing else decides. Can't be archived or deleted.",
};

/**
 * Spend settings: categories (spec §12.5). Move up and Move down reorder them from the keyboard;
 * focus stays on the moved category. A category in use can be archived, not deleted.
 */
export function CategoriesSettings() {
  const categories = useSpendCategories();
  const focus = useFocusRegistry();
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const write = useSpendWrite({
    onError: (v, err) => {
      // A move's buttons were disabled while it ran: focus still goes back to the one pressed.
      if (!v.path.endsWith('/move')) focus.cancel();
      setError(`Couldn't ${failedVerb(v)} ${v.label}. ${err.message}`);
    },
    onSuccess: (v) => {
      setStatus(v.done ?? `${v.method === 'DELETE' ? 'Deleted' : 'Saved'} ${v.label}.`);
      if (v.method === 'PUT') setRenaming(null);
      if (v.path === '/categories') {
        setAdding('');
        // Ready for the next one: the Add button is disabled once the field is empty.
        focus.focusLater(() => focus.get('add-name'), v.from);
      }
    },
  });
  const run = (v: SpendWrite) => {
    setError(null);
    setStatus('');
    write.mutate(v);
  };

  function move(c: Category, i: number, direction: 'up' | 'down') {
    // Keep focus on the button pressed; at an end it's disabled, so the other one takes it.
    focus.focusLater(() => {
      const same = focus.get(`${direction}-${c.id}`);
      return same && !same.matches(':disabled') ? same : focus.get(`${direction === 'up' ? 'down' : 'up'}-${c.id}`);
    });
    run({ method: 'POST', path: `/categories/${c.id}/move`, body: { direction }, label: c.name, done: movedLine(c.name, direction, i, list.length) });
  }

  const list = categories.data ?? [];
  return (
    <section aria-labelledby="spend-categories-heading" className="admin-section">
      <h3 id="spend-categories-heading" ref={focus.reg('heading')} tabIndex={-1}>Categories</h3>
      {error && <p className="error" role="alert">{error}</p>}
      {categories.isPending && <p className="muted">Loading…</p>}
      <ol className="todo-list">
        {list.map((c, i) =>
          renaming?.id === c.id ? (
            <li key={c.id} className="todo-row editing">
              <form
                className="form-row"
                aria-label={`Rename ${c.name}`}
                onSubmit={(e) => {
                  e.preventDefault();
                  // Save is aria-disabled, not disabled, while a write is out, so focus stays on it if this fails.
                  if (write.isPending) return;
                  focus.focusLater(() => focus.get(`rename-${c.id}`));
                  run({ method: 'PUT', path: `/categories/${c.id}`, body: { name: renaming.name }, label: c.name });
                }}
              >
                <label>
                  Name
                  <input autoFocus required maxLength={CATEGORY_NAME_MAX} value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
                </label>
                <button type="submit" className="primary" aria-disabled={write.isPending}>Save</button>
                <button
                  type="button"
                  onClick={() => {
                    setRenaming(null);
                    focus.focusLater(() => focus.get(`rename-${c.id}`));
                  }}
                >
                  Cancel
                </button>
              </form>
            </li>
          ) : (
            <li key={c.id} className="todo-row chore-row spend-settings-row">
              <span className="todo-main">
                <span className="todo-title">
                  {c.name}
                  {c.archived && <>{' '}<span className="chore-badge">Archived</span></>}
                </span>
                {KIND_NOTES[c.kind] && <span className="todo-due">{KIND_NOTES[c.kind]}</span>}
              </span>
              <span className="todo-actions chore-actions">
                <button ref={focus.reg(`up-${c.id}`)} type="button" aria-label={`Move ${c.name} up`} disabled={i === 0 || write.isPending} onClick={() => move(c, i, 'up')}>
                  Move up
                </button>
                <button
                  ref={focus.reg(`down-${c.id}`)}
                  type="button"
                  aria-label={`Move ${c.name} down`}
                  disabled={i === list.length - 1 || write.isPending}
                  onClick={() => move(c, i, 'down')}
                >
                  Move down
                </button>
                <button ref={focus.reg(`rename-${c.id}`)} type="button" aria-label={`Rename ${c.name}`} onClick={() => setRenaming({ id: c.id, name: c.name })}>
                  Rename
                </button>
                {c.kind === 'normal' && (
                  <button
                    ref={focus.reg(`archive-${c.id}`)}
                    type="button"
                    aria-label={`${c.archived ? 'Unarchive' : 'Archive'} ${c.name}`}
                    onClick={() => {
                      focus.focusLater(() => focus.get(`archive-${c.id}`));
                      run({
                        method: 'POST',
                        path: `/categories/${c.id}/${c.archived ? 'unarchive' : 'archive'}`,
                        label: c.name,
                        done: `${c.archived ? 'Unarchived' : 'Archived'} ${c.name}.`,
                      });
                    }}
                  >
                    {c.archived ? 'Unarchive' : 'Archive'}
                  </button>
                )}
                {c.kind === 'normal' && !c.inUse && (
                  <button
                    type="button"
                    aria-label={`Delete ${c.name}`}
                    onClick={() => {
                      if (!window.confirm(`Delete ${c.name}?`)) return;
                      focus.focusLater(() => focus.get('heading'));
                      run({ method: 'DELETE', path: `/categories/${c.id}`, label: c.name });
                    }}
                  >
                    Delete
                  </button>
                )}
              </span>
            </li>
          ),
        )}
      </ol>
      <form
        className="form-row"
        aria-label="New category"
        onSubmit={(e) => {
          e.preventDefault();
          if (adding.trim() === '' || write.isPending) return;
          run({ method: 'POST', path: '/categories', body: { name: adding }, label: adding.trim() });
        }}
      >
        <label>
          New category
          <input ref={focus.reg('add-name')} maxLength={CATEGORY_NAME_MAX} value={adding} onChange={(e) => setAdding(e.target.value)} />
        </label>
        {/* aria-disabled while a write is out, so focus stays on it if the add fails. */}
        <button type="submit" disabled={adding.trim() === ''} aria-disabled={write.isPending}>Add category</button>
      </form>
      <p className="muted spend-form-note">Archived categories stay on the transactions that have them, but can't be picked for new ones.</p>
      <p role="status" className="muted todo-status">{status}</p>
    </section>
  );
}
