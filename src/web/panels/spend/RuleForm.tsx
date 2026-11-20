import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { RULE_TEXT_MAX, type CardOption, type Category, type RuleInput, type SpendPerson } from '../../../shared/spend.js';
import { cardName, personName } from './format.js';
import { toRuleInput, type RuleField, type RuleFormValues } from './ruleFormValues.js';

/**
 * Create and edit form for a rule (spec §12.8). Checked here before submitting (the server checks
 * again): a problem keeps it from submitting, moves focus to the field, marks it `aria-invalid`,
 * and points it at the message (`aria-describedby`). `error` is the server's answer, shown in the form.
 *
 * Archived categories, archived cards, and deactivated people aren't offered, except the one the
 * rule already names, so editing a flagged rule doesn't silently change it.
 */
export function RuleForm(props: {
  name: string;
  initial: RuleFormValues;
  categories: Category[];
  people: SpendPerson[];
  cards: CardOption[];
  submitLabel: string;
  busy: boolean;
  error?: string | null;
  placeFirst?: boolean;
  /** Extra controls just above the buttons. */
  children?: ReactNode;
  onSubmit: (input: RuleInput) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(props.initial);
  const [problem, setProblem] = useState<{ error: string; field: RuleField } | null>(null);
  const fields = useRef(new Map<RuleField, HTMLElement>());
  const id = props.name.replace(/\W+/g, '-').toLowerCase();
  const set = (patch: Partial<RuleFormValues>) => {
    setV((cur) => ({ ...cur, ...patch }));
    setProblem(null);
  };
  const reg = (field: RuleField) => (el: HTMLElement | null) => {
    if (el) fields.current.set(field, el);
  };
  const invalid = (field: RuleField) =>
    problem?.field === field ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-problem` } : {};

  const categories = props.categories.filter((c) => !c.archived || String(c.id) === props.initial.categoryId);
  const people = props.people.filter((p) => p.active || String(p.id) === props.initial.person);
  const cards = props.cards.filter((c) => !c.archived || String(c.id) === props.initial.cardId);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // While a save is out the button is aria-disabled, not disabled, so focus stays on it if the save fails.
    if (props.busy) return;
    const result = toRuleInput(v, props.placeFirst);
    if (!result.ok) {
      setProblem(result);
      fields.current.get(result.field)?.focus();
      return;
    }
    props.onSubmit(result.input);
  }

  return (
    <form className="todo-form form-row spend-rule-form" aria-label={props.name} onSubmit={submit} noValidate>
      <label>
        Text to match
        <input
          ref={reg('matchText')}
          autoFocus
          maxLength={RULE_TEXT_MAX}
          value={v.matchText}
          onChange={(e) => set({ matchText: e.target.value })}
          aria-describedby={problem?.field === 'matchText' ? `${id}-problem` : `${id}-text-hint`}
          aria-invalid={problem?.field === 'matchText' || undefined}
        />
      </label>
      <label>
        Match
        <select value={v.matchType} onChange={(e) => set({ matchType: e.target.value as RuleFormValues['matchType'] })}>
          <option value="contains">Contains the text</option>
          <option value="exact">Is exactly the text</option>
        </select>
      </label>
      <p id={`${id}-text-hint`} className="muted spend-form-note">
        Compared with the merchant name, or the description when there isn't one, ignoring capitals.
      </p>
      <label>
        Card
        <select value={v.cardId} onChange={(e) => set({ cardId: e.target.value })}>
          <option value="">Any card</option>
          {cards.map((c) => (
            <option key={c.id} value={c.id}>{cardName(c)}{c.archived ? ' (archived)' : ''}</option>
          ))}
        </select>
      </label>
      <label>
        Smallest amount
        <input ref={reg('min')} inputMode="text" autoComplete="off" value={v.min} placeholder="Any" onChange={(e) => set({ min: e.target.value })} {...invalid('min')} />
      </label>
      <label>
        Largest amount
        <input ref={reg('max')} inputMode="text" autoComplete="off" value={v.max} placeholder="Any" onChange={(e) => set({ max: e.target.value })} {...invalid('max')} />
      </label>
      {/* Not inputMode="decimal": an iPhone's decimal keypad has no minus sign, and credits need one. */}
      <p className="muted spend-form-note">Amounts are in dollars. Spending is positive; refunds and payments are negative, like -25.00.</p>
      <label>
        Set the category
        <select ref={reg('action')} value={v.categoryId} onChange={(e) => set({ categoryId: e.target.value })} {...invalid('action')}>
          <option value="">Don't change it</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}{c.archived ? ' (archived)' : ''}</option>
          ))}
        </select>
      </label>
      <label>
        Set the person
        <select value={v.person} onChange={(e) => set({ person: e.target.value })} {...invalid('action')}>
          <option value="">Don't change it</option>
          <option value="household">Household</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>{personName(p)}</option>
          ))}
        </select>
      </label>
      <label className="inline-check spend-form-note">
        <input type="checkbox" checked={v.applyToPast} onChange={(e) => set({ applyToPast: e.target.checked })} />
        Apply to past transactions too (anything set by hand stays as it is)
      </label>
      {props.children}
      {problem && <p id={`${id}-problem`} className="error spend-form-note" role="alert">{problem.error}</p>}
      {props.error && <p className="error spend-form-note" role="alert">{props.error}</p>}
      <span className="todo-actions spend-form-note">
        <button type="submit" className="primary" aria-disabled={props.busy}>{props.submitLabel}</button>
        <button type="button" onClick={props.onCancel}>Cancel</button>
      </span>
    </form>
  );
}
