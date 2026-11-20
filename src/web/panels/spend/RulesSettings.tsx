import { useState } from 'react';
import type { Rule, RuleSaveResponse } from '../../../shared/spend.js';
import { useFocusRegistry } from '../chores/useFocus.js';
import { money, movedLine, personName } from './format.js';
import { useSpendCards, useSpendCategories, useSpendPeople, useSpendRules, useSpendWrite, type SpendWrite } from './queries.js';
import { RuleForm } from './RuleForm.js';
import { describeMatch, EMPTY_RULE, ruleFormFromRule } from './ruleFormValues.js';

function describeActions(rule: Rule): string {
  const parts: string[] = [];
  if (rule.setCategory) parts.push(`category ${rule.setCategory.name}${rule.setCategory.archived ? ' (archived)' : ''}`);
  if (rule.setPerson) parts.push(`person ${rule.setPerson.kind === 'household' ? 'Household' : personName(rule.setPerson.person)}`);
  return `Sets the ${parts.join(' and the ')}`;
}

/**
 * Spend settings: rules (spec §12.8), in the order they're tried. Move up and Move down reorder
 * them from the keyboard. A rule naming an archived category, a deactivated person, or an archived
 * card is flagged with what's wrong.
 */
export function RulesSettings() {
  const rules = useSpendRules();
  const categories = useSpendCategories();
  const people = useSpendPeople();
  const cards = useSpendCards();
  const focus = useFocusRegistry();
  const [mode, setMode] = useState<'new' | number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const write = useSpendWrite<RuleSaveResponse | { applied: number }>({
    onError: (v, err) => {
      // A move's buttons were disabled while it ran: focus still goes back to the one pressed.
      if (!v.path.endsWith('/move')) focus.cancel();
      // A failed save shows in its form; anything else above the list.
      if (v.path === '/rules') setFormError(`Couldn't add the rule. ${err.message}`);
      else if (v.method === 'PUT') setFormError(`Couldn't save the rule. ${err.message}`);
      else setError(`Couldn't change ${v.label}. ${err.message}`);
    },
    onSuccess: (v, res) => {
      const applied = res && 'applied' in res ? res.applied : null;
      const changed = applied === null ? '' : ` ${applied} ${applied === 1 ? 'transaction' : 'transactions'} changed.`;
      if (v.path === '/rules/apply') {
        setStatus(`Rules applied to past transactions.${changed}`);
        // The button was locked while it ran; focus goes back to it.
        focus.focusLater(() => focus.get('apply'), v.from);
      }
      else setStatus(v.done ?? `${v.method === 'DELETE' ? 'Deleted' : 'Saved'} ${v.label}.${changed}`);
      if (v.method === 'POST' && v.path === '/rules') {
        setMode(null);
        focus.focusLater(() => focus.get('new'), v.from);
      }
      if (v.method === 'PUT') {
        const id = Number(v.path.split('/')[2]);
        setMode(null);
        focus.focusLater(() => focus.get(`edit-${id}`), v.from);
      }
    },
  });
  const run = (v: SpendWrite) => {
    setError(null);
    setFormError(null);
    setStatus('');
    write.mutate(v);
  };

  function move(r: Rule, i: number, direction: 'up' | 'down') {
    focus.focusLater(() => {
      const same = focus.get(`${direction}-${r.id}`);
      return same && !same.matches(':disabled') ? same : focus.get(`${direction === 'up' ? 'down' : 'up'}-${r.id}`);
    });
    const label = `the rule for "${r.matchText}"`;
    run({ method: 'POST', path: `/rules/${r.id}/move`, body: { direction }, label, done: movedLine(label, direction, i, list.length) });
  }

  const list = rules.data ?? [];
  const formProps = { categories: categories.data ?? [], people: people.data ?? [], cards: cards.data ?? [], busy: write.isPending, error: formError };
  return (
    <section aria-labelledby="spend-rules-heading" className="admin-section">
      <h3 id="spend-rules-heading" ref={focus.reg('heading')} tabIndex={-1}>Rules</h3>
      <p className="muted">
        Tried in order for each new or imported transaction. For the category and the person separately, the first rule that matches and sets it wins.
        Anything set by hand stays as it is.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {rules.isPending && <p className="muted">Loading…</p>}
      <ol className="todo-list">
        {list.map((r, i) =>
          mode === r.id ? (
            <li key={r.id} className="todo-row editing">
              <RuleForm
                name={`Edit the rule for ${r.matchText}`}
                initial={ruleFormFromRule(r)}
                submitLabel="Save rule"
                {...formProps}
                onSubmit={(input) => run({ method: 'PUT', path: `/rules/${r.id}`, body: input, label: `the rule for "${input.matchText}"` })}
                onCancel={() => {
                  setMode(null);
                  setFormError(null);
                  focus.focusLater(() => focus.get(`edit-${r.id}`));
                }}
              />
            </li>
          ) : (
            <li key={r.id} className="todo-row chore-row spend-settings-row">
              <span className="todo-main">
                <span className="todo-title">{describeMatch(r, (c) => money(c))}</span>
                <span className="todo-due">{describeActions(r)}</span>
                {r.problems.map((p) => (
                  <span key={p} className="todo-due warning">Needs attention: {p}</span>
                ))}
              </span>
              <span className="todo-actions chore-actions">
                <button ref={focus.reg(`up-${r.id}`)} type="button" aria-label={`Move the rule for ${r.matchText} up`} disabled={i === 0 || write.isPending} onClick={() => move(r, i, 'up')}>
                  Move up
                </button>
                <button
                  ref={focus.reg(`down-${r.id}`)}
                  type="button"
                  aria-label={`Move the rule for ${r.matchText} down`}
                  disabled={i === list.length - 1 || write.isPending}
                  onClick={() => move(r, i, 'down')}
                >
                  Move down
                </button>
                <button ref={focus.reg(`edit-${r.id}`)} type="button" aria-label={`Edit the rule for ${r.matchText}`} onClick={() => { setFormError(null); setMode(r.id); }}>
                  Edit
                </button>
                <button
                  type="button"
                  aria-label={`Delete the rule for ${r.matchText}`}
                  onClick={() => {
                    if (!window.confirm(`Delete the rule for "${r.matchText}"? Transactions it already changed keep their category and person until rules are applied again.`)) return;
                    focus.focusLater(() => focus.get('heading'));
                    run({ method: 'DELETE', path: `/rules/${r.id}`, label: `the rule for "${r.matchText}"` });
                  }}
                >
                  Delete
                </button>
              </span>
            </li>
          ),
        )}
      </ol>
      {mode === 'new' ? (
        <RuleForm
          name="New rule"
          initial={EMPTY_RULE}
          submitLabel="Add rule"
          {...formProps}
          onSubmit={(input) => run({ method: 'POST', path: '/rules', body: input, label: `the rule for "${input.matchText}"` })}
          onCancel={() => {
            setMode(null);
            setFormError(null);
            focus.focusLater(() => focus.get('new'));
          }}
        />
      ) : (
        <span className="todo-actions">
          <button ref={focus.reg('new')} type="button" onClick={() => { setFormError(null); setMode('new'); }}>New rule</button>
          <button
            ref={focus.reg('apply')}
            type="button"
            disabled={write.isPending}
            onClick={() => {
              if (!window.confirm('Apply every rule to past transactions? Categories and people set by hand stay as they are.')) return;
              run({ method: 'POST', path: '/rules/apply', label: 'rules' });
            }}
          >
            Apply rules to past transactions
          </button>
        </span>
      )}
      <p role="status" className="muted todo-status">{status}</p>
    </section>
  );
}
