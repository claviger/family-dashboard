import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { TRANSACTION_BATCH_MAX, type SpendTransaction, type TransactionBatchProblem } from '../../../shared/spend.js';
import { ApiError } from '../../api.js';
import { useFocusRegistry } from '../chores/useFocus.js';
import {
  discardChangesQuestion, draftChanges, draftCount, hiddenCount, markConflicts, movedMessage, NO_DRAFTS, removedMessage, saveLabel, savedMessage, savingLine,
  settleMissing, tooManyLine, unsavedLine, type DraftField, type Drafts,
} from './drafts.js';
import { useTransactionSave } from './queries.js';

/** The picker for a row's field, when the table shows it (TransactionList gives each one this id). */
export const pickerId = (field: DraftField, id: number) => `spend-${field}-${id}`;

/** The CSS variable the bar's height goes to, for `scroll-padding-bottom` on the page. */
const HEIGHT_VAR = '--spend-save-bar-height';

/**
 * While a Save bar shows, the page's `scroll-padding-bottom` is its height, so a control that gets
 * focus is scrolled clear of it. Shared by the drill-down's bar and the mapping editor's.
 */
export function useSaveBarHeight(showing: boolean, bar: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = bar.current;
    if (!showing || !el) return;
    const root = document.documentElement;
    const set = () => root.style.setProperty(HEIGHT_VAR, `${Math.ceil(el.getBoundingClientRect().height) + 8}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty(HEIGHT_VAR);
    };
  }, [showing, bar]);
}

/**
 * The drill-down's one Save (spec §12.12). While there are drafts, it offers "Save N changes" (N
 * counts edited fields, with how many are on rows not shown) and "Discard changes". It's the last
 * thing in the overview, held to the bottom of the screen (`position: sticky`) wherever the page
 * is scrolled, and in the flow at the end, so it never covers the last row once that's scrolled
 * to. While it shows, the page's `scroll-padding-bottom` is its height, so a control that gets
 * focus is scrolled clear of it.
 *
 * Save sends every draft, hidden rows' too, in one request that saves all or none. After it, the
 * status line says how many changes were saved and how many transactions that were showing the
 * filter now hides, and focus goes to the Transactions heading, since the bar goes away (or stays
 * on Save, if a pick made while saving keeps it).
 *
 * When the server refuses, nothing was saved. Drafts for rows a bank sync replaced move to the
 * rows that took their place (focus goes to the first one's picker when it's shown), drafts for
 * rows that no longer exist are dropped, and Save stays for the rest; fields someone else changed
 * meanwhile are flagged; a value that can't be assigned is named with its row. Focus goes to the row's picker when it's shown (the
 * message is then an alert), or else to the message.
 */
export function SaveBar(props: {
  drafts: Drafts;
  setDrafts: (update: (d: Drafts) => Drafts) => void;
  /** The rows the table shows now. */
  shown: readonly SpendTransaction[];
  /** How the table names a shown row (merchant, date, amount). */
  labels: ReadonlyMap<number, string>;
  /** Whether a transaction still matches the table's filters. */
  matches: (t: SpendTransaction) => boolean;
  heading: () => HTMLElement | null | undefined;
  saveButton: RefObject<HTMLButtonElement | null>;
  onSaved: (saved: SpendTransaction[]) => void;
  onStatus: (message: string) => void;
  onError: (message: string | null) => void;
}) {
  const { drafts, setDrafts } = props;
  const focus = useFocusRegistry();
  const count = draftCount(drafts);
  const shownIds = new Set(props.shown.map((t) => t.id));
  const hidden = hiddenCount(drafts, shownIds);
  const tooMany = drafts.size > TRANSACTION_BATCH_MAX;
  /** A refusal: focused itself, or announced (an alert) when focus went to the row's picker. */
  const [error, setError] = useState<{ message: string; focused: boolean } | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  // A failed save's message goes once there's nothing left to save.
  useEffect(() => {
    if (count === 0) setError(null);
  }, [count]);

  // The bar's height, for the page's scroll-padding-bottom while it shows.
  useSaveBarHeight(count > 0, bar);

  const labelFor = (id: number) => props.labels.get(id) ?? drafts.get(id)?.label ?? 'a transaction that isn’t shown';

  /** Focus a row's picker if the table shows it; otherwise the message. Says which it did. */
  function show(message: string, row: { id: number; field: DraftField } | null, from: Element | null) {
    const picker = row ? () => document.getElementById(pickerId(row.field, row.id)) : null;
    const onPicker = picker !== null && picker() !== null;
    setError({ message, focused: !onPicker });
    focus.focusLater(onPicker ? picker : () => focus.get('error'), from);
  }

  const save = useTransactionSave({
    onError: (v, err) => {
      const details = (err instanceof ApiError ? err.details : undefined) as Partial<Record<string, unknown>> | undefined;
      const problem = details as TransactionBatchProblem | undefined;
      if (problem && 'missingIds' in problem && Array.isArray(problem.missingIds)) {
        // A row a bank sync replaced takes its drafts to the new row; the rest of the missing ones go.
        const replacedBy = 'replacedBy' in problem && problem.replacedBy && typeof problem.replacedBy === 'object' ? problem.replacedBy : undefined;
        const out = settleMissing(drafts, problem.missingIds, replacedBy);
        setDrafts((d) => settleMissing(d, problem.missingIds, replacedBy).drafts);
        const said = [out.moved > 0 ? movedMessage(out.moved) : null, out.removed > 0 ? removedMessage(out.removed) : null].filter(Boolean).join(' ');
        if (draftCount(out.drafts) > 0) {
          show(`Nothing was saved. ${said} ${out.moved > 0 ? 'Check them, then save again.' : 'Save again to save the rest.'}`, out.first, v.from);
        } else {
          props.onStatus(said);
          focus.focusLater(props.heading, v.from);
        }
        return;
      }
      if (problem && 'conflicts' in problem && Array.isArray(problem.conflicts)) {
        setDrafts((d) => markConflicts(d, problem.conflicts));
        const rows = [...new Set(problem.conflicts.map((c) => c.transactionId))];
        const first = problem.conflicts[0]!;
        const message =
          rows.length === 1
            ? `Nothing was saved. Someone else changed ${labelFor(first.transactionId)} while you were editing. Check it, then save again.`
            : `Nothing was saved. Someone else changed ${rows.length} of the transactions you edited. Check the flagged ones, then save again.`;
        show(message, { id: first.transactionId, field: first.field }, v.from);
        return;
      }
      if (problem && 'transactionId' in problem && typeof problem.problem === 'string') {
        show(`Nothing was saved. ${labelFor(problem.transactionId)}: ${problem.problem}`, { id: problem.transactionId, field: problem.field }, v.from);
        return;
      }
      show(`Nothing was saved. ${err.message}`, null, v.from);
    },
    onSuccess: (v, saved) => {
      // A pick made while the save was out differs from what was saved, so it stays for the next Save.
      props.onSaved(saved);
      const wasShown = new Set(v.shownIds);
      props.onStatus(savedMessage(v.count, saved.filter((t) => wasShown.has(t.id) && !props.matches(t)).length));
      focus.focusLater(() => props.saveButton.current ?? props.heading(), v.from);
    },
  });

  function saveAll() {
    if (save.isPending || count === 0 || tooMany) return;
    props.onError(null);
    props.onStatus('');
    setError(null);
    save.mutate({ changes: draftChanges(drafts), count, shownIds: props.shown.filter((t) => drafts.has(t.id)).map((t) => t.id) });
  }

  function discard() {
    if (save.isPending) return;
    if (count > 1 && !window.confirm(discardChangesQuestion(count))) return;
    setDrafts(() => NO_DRAFTS);
    setError(null);
    props.onError(null);
    props.onStatus(`Discarded ${count === 1 ? '1 change' : `${count} changes`}.`);
    focus.focusLater(props.heading);
  }

  return (
    <>
      {/* Always in the page, so a screen reader hears the count change, and "Saving…". */}
      <p className="visually-hidden" aria-live="polite">{count === 0 ? '' : save.isPending ? savingLine(count) : unsavedLine(count)}</p>
      {count > 0 && (
        <div ref={bar} className="spend-save-bar" role="region" aria-label="Unsaved changes">
          {error &&
            (error.focused ? (
              <p ref={focus.reg('error')} tabIndex={-1} className="error">{error.message}</p>
            ) : (
              <p className="error" role="alert">{error.message}</p>
            ))}
          {tooMany && <p className="error">{tooManyLine(drafts.size)}</p>}
          <span className="spend-save-actions">
            <button ref={props.saveButton} type="button" className="primary" aria-disabled={save.isPending || tooMany} onClick={saveAll}>
              {saveLabel(count, hidden)}
            </button>
            <button type="button" aria-disabled={save.isPending} onClick={discard}>Discard changes</button>
            {save.isPending && <span className="muted" aria-hidden="true">Saving…</span>}
          </span>
        </div>
      )}
    </>
  );
}
