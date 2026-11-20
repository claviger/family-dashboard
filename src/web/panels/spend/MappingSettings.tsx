import { useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MAPPING_BATCH_MAX, type MappingBatchProblem, type MappingView } from '../../../shared/plaid.js';
import type { Category, CategoryRef } from '../../../shared/spend.js';
import { ApiError, isOutcomeUnknown } from '../../api.js';
import { useMe } from '../../shell/useMe.js';
import { readStored, registerUnsaved, writeStored } from '../../unsavedChanges.js';
import { useFocusRegistry } from '../chores/useFocus.js';
import { conflictNote, discardChangesQuestion, discardQuestion, matchedMessage, saveLabel, savingLine, STILL_SAVING_QUESTION, unsavedLine } from './drafts.js';
import {
  dropCodes, fallbackOptionLabel, goneLine, keepsMappingDrafts, mappingChanges, mappingDraftsKey, markMappingConflicts, markMappingProblem, NO_MAPPING_DRAFTS,
  parseMappingDrafts, savedMappingsLine, serializeMappingDrafts, setMappingDraft, settleMappingDrafts, settleSentMappingDrafts, shownMappingCodes, storedValue,
  unknownMappingLine, type MappingDraft, type MappingDrafts,
} from './mappingDrafts.js';
import { fetchMappings, useMappings, useMappingSave, type MappingSave } from './plaidQueries.js';
import { categoryOptionLabel, codeDetails, pfcLabel } from './plaidText.js';
import { spendKeys, useSpendCategories, useSpendWrite } from './queries.js';
import { useSaveBarHeight } from './SaveBar.js';

const EDITED_NOTE = 'Changed, not saved';

/** The categories a code can go to: the usable ones, plus its current one and its pick when archived, so the select shows what's set. */
function optionsFor(categories: readonly Category[], current: CategoryRef | null, picked: number | null): CategoryRef[] {
  const usable: CategoryRef[] = categories.filter((c) => !c.archived);
  const extra = [current, ...categories.filter((c) => c.id === picked)].filter((c): c is CategoryRef => c !== null && c.archived && !usable.some((u) => u.id === c.id));
  return [...new Map([...extra, ...usable].map((c) => [c.id, c])).values()];
}

/** The select's id, so a refused Save can focus the row it's about. */
const selectId = (code: string) => `spend-mapping-${code}`;

/**
 * One code's category select (review G4-I3: no Save of its own; the bar below saves every edited
 * code). A detailed code with a row of its own also offers its main category's, which deletes its
 * row when saved. What's under the select, most pressing first: the server refused the pick, someone
 * else changed it, or it's changed and not saved.
 */
function CodeRow(props: {
  code: string;
  primary: string | null;
  details: string;
  warning: string | null;
  current: CategoryRef | null;
  /** For a detailed code with its own row: what deleting it falls back to. Undefined when it can't be deleted. */
  fallback?: CategoryRef | null;
  categories: readonly Category[];
  draft: MappingDraft | undefined;
  focus: ReturnType<typeof useFocusRegistry>;
  onPick: (value: number | null) => void;
}) {
  const { code, current, draft } = props;
  // Controls are named by the code as people read it ("Food and drink: coffee"), like the row's title.
  const label = pfcLabel(code, props.primary);
  const stored = current ? current.id : null;
  const value = draft ? draft.value : stored;
  const picked = draft && draft.value !== null ? props.categories.find((c) => c.id === draft.value) : undefined;
  const nameOf = (id: number | null) =>
    id === null ? 'no mapping of its own' : (props.categories.find((c) => c.id === id)?.name ?? 'another category');
  const note = !draft
    ? null
    : draft.problem
      ? { text: draft.problem, flagged: true }
      : picked?.archived
        ? { text: `${picked.name} is archived now. Pick another category.`, flagged: true }
        : draft.changedTo !== undefined
          ? { text: conflictNote(nameOf(draft.changedTo)), flagged: true }
          : { text: EDITED_NOTE, flagged: false };
  const noteId = `${selectId(code)}-note`;
  const className = ['spend-picker', note && 'spend-edited', note?.flagged && 'spend-flagged'].filter(Boolean).join(' ');
  const primaryLabel = props.primary === null ? null : pfcLabel(props.primary, null);
  return (
    <li className="todo-row chore-row spend-settings-row">
      <span className="todo-main">
        <span className="todo-title spend-code">{label}</span>
        <span className="todo-due spend-code">{props.details}</span>
        {props.warning && <span className="todo-due warning">{props.warning}</span>}
      </span>
      <span className="todo-actions chore-actions">
        <span className={className}>
          <label className="spend-picker">
            Category
            {/* Named here, not by the wrapping label, so the name doesn't take in the picked option's text. */}
            <select
              ref={props.focus.reg(`select-${code}`)}
              id={selectId(code)}
              aria-label={`Category for ${label}`}
              aria-describedby={note ? noteId : undefined}
              value={value === null ? '' : String(value)}
              onChange={(e) => props.onPick(e.target.value === '' ? null : Number(e.target.value))}
            >
              {props.fallback !== undefined ? (
                <option value="">{fallbackOptionLabel(primaryLabel, props.fallback)}</option>
              ) : (
                stored === null && <option value="">Choose a category</option>
              )}
              {optionsFor(props.categories, current, draft?.value ?? null).map((c) => (
                <option key={c.id} value={c.id}>{categoryOptionLabel(c)}</option>
              ))}
            </select>
          </label>
          {note && <span id={noteId} className="spend-edited-note">{note.text}</span>}
        </span>
      </span>
    </li>
  );
}

/**
 * Spend settings: the Plaid category mapping (spec §12.7, admins). Each Plaid category code goes to
 * a family category; a detailed code without a choice of its own uses its primary's. Codes the bank
 * has sent without a mapping are listed with what they use now. A change applies to new
 * transactions; "Apply to past transactions" (the rules' POST /rules/apply, which uses the mapping
 * too) decides the past ones again, never touching what was set by hand. Shown when Plaid is
 * configured, or once any transaction has a Plaid code (a bank removed, or the keys taken out),
 * since the codes are worth seeing either way.
 *
 * One Save (review G4-I3, the owner's rule from 6a), like the drill-down's SaveBar: changing a
 * select makes a draft, and the bar at the end of the section offers "Save N changes" (with how
 * many are folded away in the closed list) and "Discard changes". Save sends every draft in one
 * request that saves all or none, with what each code was last seen holding, so a code someone
 * else changed meanwhile is refused (409) and flagged. A refusal is named beside its row (M7), and
 * focus goes to that row's select when it's shown, else to the message in the bar. While there are
 * drafts, leaving Spend settings asks first: another page (the router's blocker), signing out, and
 * the full page loads of Connect bank and Reconnect (`confirmDiscardUnsaved`), and closing or
 * reloading the tab gets the browser's own prompt.
 */
export function MappingSettings({ plaidConfigured }: { plaidConfigured: boolean }) {
  const qc = useQueryClient();
  const mappings = useMappings();
  const categories = useSpendCategories();
  const focus = useFocusRegistry();
  const userId = useMe().data!.user.id;
  const storeKey = mappingDraftsKey(userId);
  // Kept under the drafts prefix like the drill-down's, so a reload keeps them and signing out clears them (review C-M7).
  const [drafts, setDrafts] = useState<MappingDrafts>(() => parseMappingDrafts(readStored(storeKey)));
  /** The drafts as last rendered, for an unanswered Save's message (its own update is functional). */
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** A refused Save: focused itself, or announced (an alert) when focus went to the row's select. */
  const [saveError, setSaveError] = useState<{ message: string; focused: boolean } | null>(null);
  const [offerApply, setOfferApply] = useState(false);
  const [open, setOpen] = useState(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  /** The last view the drafts were settled against (the person's own Save settles against its answer itself). */
  const settledView = useRef<MappingView | undefined>(undefined);

  const data: MappingView | undefined = mappings.data;
  const count = drafts.size;

  // A fresh view: drafts that now match go, codes that are gone go, and codes someone else changed are flagged.
  useEffect(() => {
    if (!data || data === settledView.current) return;
    settledView.current = data;
    const out = settleMappingDrafts(drafts, data);
    if (out.drafts === drafts) return;
    setDrafts(out.drafts);
    const why = [out.matched > 0 ? matchedMessage(out.matched) : '', out.gone > 0 ? goneLine(out.gone) : ''].filter(Boolean).join(' ');
    if (why) setStatus(why);
  }, [data, drafts]);

  // A failed Save's message goes once there's nothing left to save.
  useEffect(() => {
    if (count === 0) setSaveError(null);
  }, [count]);

  // Mirrored to sessionStorage (an empty set removes the key).
  useEffect(() => {
    writeStored(storeKey, drafts.size === 0 ? null : serializeMappingDrafts(drafts));
  }, [drafts, storeKey]);

  useSaveBarHeight(count > 0, bar);

  /**
   * Focus a row's select if it's shown, opening the folded list first when the code is in it
   * (review C-M6); otherwise the message in the bar.
   */
  function show(message: string, code: string | null, from: Element | null) {
    const select = code ? () => focus.get(`select-${code}`) : null;
    const folded = code !== null && !open && (data?.rows.some((r) => r.code === code) ?? false) && !(data?.unmapped.some((u) => u.code === code) ?? false);
    if (folded) setOpen(true);
    const onSelect = select !== null && (folded || (select()?.offsetParent ?? null) !== null);
    setSaveError({ message, focused: !onSelect });
    focus.focusLater(onSelect ? select : () => focus.get('save-error'), from);
  }

  /**
   * An answer that never came: fetch the view again and say what it shows (review G4-I1). The drafts
   * are settled against what was sent (review C-M5), as they are now (a functional update, so a pick
   * made meanwhile isn't lost), and not as the person's own save, so a code someone else changed is
   * still flagged. The message says what's left.
   */
  async function settleUnknown(v: MappingSave) {
    let fresh: MappingView | null = null;
    try {
      fresh = await qc.fetchQuery({ queryKey: spendKeys.mappings, queryFn: fetchMappings, staleTime: 0 });
    } catch {
      fresh = null;
    }
    if (!fresh) {
      show("The server didn't answer in time, and the categories couldn't be loaded to check what changed. Reload the page.", null, v.from);
      return;
    }
    const view = fresh;
    settledView.current = view;
    const out = settleSentMappingDrafts(draftsRef.current, v.changes, view);
    setDrafts((d) => settleSentMappingDrafts(d, v.changes, view).drafts);
    const message = unknownMappingLine(out);
    if (out.saved > 0) setOfferApply(true);
    if (out.remaining === 0) {
      setStatus(message);
      focus.focusLater(() => focus.get('heading'), v.from);
    } else {
      show(message, null, v.from);
    }
  }

  const save = useMappingSave({
    onError: (v, err) => {
      if (isOutcomeUnknown(err)) return settleUnknown(v);
      const problem = (err instanceof ApiError ? err.details : undefined) as Partial<MappingBatchProblem> | undefined;
      if (problem && 'missingCodes' in problem && Array.isArray(problem.missingCodes)) {
        const out = dropCodes(drafts, problem.missingCodes);
        setDrafts((d) => dropCodes(d, problem.missingCodes!).drafts);
        if (out.drafts.size > 0) show(`Nothing was saved. ${goneLine(out.removed)} Save again to save the rest.`, null, v.from);
        else {
          setStatus(goneLine(out.removed));
          focus.focusLater(() => focus.get('heading'), v.from);
        }
        return;
      }
      if (problem && 'conflicts' in problem && Array.isArray(problem.conflicts)) {
        setDrafts((d) => markMappingConflicts(d, problem.conflicts!));
        show(err.message, problem.conflicts[0]?.code ?? null, v.from);
        return;
      }
      if (problem && 'code' in problem && typeof problem.code === 'string' && typeof problem.problem === 'string') {
        setDrafts((d) => markMappingProblem(d, problem.code!, problem.problem!));
        show(`Nothing was saved. ${err.message}`, problem.code, v.from);
        return;
      }
      show(`Nothing was saved. ${err.message}`, null, v.from);
    },
    onSuccess: (v, view) => {
      // Settled now, in the same render as the focus below: a pick made while the Save was out
      // stays, made against what was saved, and the rest go, so the bar goes before focus is placed.
      settledView.current = view;
      setDrafts((d) => settleMappingDrafts(d, view, true).drafts);
      setStatus(savedMappingsLine(v.count));
      setOfferApply(true);
      // The bar goes away (or stays, for a pick made while saving): focus goes to Save, else the heading.
      focus.focusLater(() => saveButton.current ?? focus.get('heading'), v.from);
    },
  });
  const apply = useSpendWrite<{ applied: number }>({
    onError: (_v, err) => setError(`Couldn't apply the mapping and rules to past transactions. ${err.message}`),
    onSuccess: (_v, res) => {
      setOfferApply(false);
      setStatus(`Applied the mapping and rules to past transactions. ${res.applied} ${res.applied === 1 ? 'transaction' : 'transactions'} changed.`);
      focus.focusLater(() => focus.get('heading'));
    },
  });
  const saving = save.isPending;
  const busy = saving || apply.isPending;
  const tooMany = count > MAPPING_BATCH_MAX;

  // Leaving with drafts asks first: another page, signing out, a full page load (Connect bank, Reconnect), or the tab.
  const unsaved = useRef({ count, saving });
  unsaved.current = { count, saving };
  const question = useCallback((): string | null => {
    const u = unsaved.current;
    if (u.count === 0) return null;
    return u.saving ? STILL_SAVING_QUESTION : discardQuestion(u.count);
  }, []);
  const discardAll = useCallback(() => {
    unsaved.current.count = 0;
    writeStored(storeKey, null);
    setDrafts(NO_MAPPING_DRAFTS);
  }, [storeKey]);
  const shouldBlockFn = useCallback(
    ({ next }: { next: { pathname: string; search: Record<string, unknown> } }) => {
      if (unsaved.current.count === 0 || keepsMappingDrafts(next)) return false;
      if (!window.confirm(question()!)) return true;
      discardAll();
      return false;
    },
    [question, discardAll],
  );
  const enableBeforeUnload = useCallback(() => unsaved.current.count > 0, []);
  useBlocker({ shouldBlockFn, enableBeforeUnload });
  useEffect(() => registerUnsaved({ question, discard: discardAll }), [question, discardAll]);

  const seen = data ? data.rows.some((r) => r.transactionCount > 0) || data.unmapped.length > 0 : false;
  if (!plaidConfigured && !seen) return null;

  const cats = categories.data ?? [];
  const pick = (code: string, label: string) => (value: number | null) => {
    if (!data) return;
    const stored = storedValue(data, code);
    if (stored === undefined) return;
    setStatus('');
    setDrafts((d) => setMappingDraft(d, code, value, stored, label));
  };
  const rowsByCode = new Map((data?.rows ?? []).map((r) => [r.code, r]));
  const shown = data ? shownMappingCodes(data, open) : new Set<string>();
  const hidden = [...drafts.keys()].filter((code) => !shown.has(code)).length;

  function saveAll() {
    if (saving || count === 0 || tooMany) return;
    setError(null);
    setStatus('');
    setSaveError(null);
    save.mutate({ changes: mappingChanges(drafts), count });
  }

  function discard() {
    if (saving) return;
    if (count > 1 && !window.confirm(discardChangesQuestion(count))) return;
    setDrafts(NO_MAPPING_DRAFTS);
    setSaveError(null);
    setStatus(`Discarded ${count === 1 ? '1 change' : `${count} changes`}.`);
    focus.focusLater(() => focus.get('heading'));
  }

  return (
    <section aria-labelledby="spend-mapping-heading" className="admin-section">
      <h3 id="spend-mapping-heading" ref={focus.reg('heading')} tabIndex={-1}>Bank categories</h3>
      <p className="muted">
        Plaid sends a category with each bank transaction. Choose which of your categories each one goes to, then save. A detailed category without
        a choice of its own uses its main category's. Rules and anything set by hand still win.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {mappings.isPending ? (
        <p className="muted">Loading…</p>
      ) : !data ? (
        <p className="error">{mappings.error?.message}</p>
      ) : (
        <>
          {data.unmapped.length > 0 && (
            <>
              <h4 className="spend-bank-subhead">Sent by the bank, not mapped yet</h4>
              <ul className="todo-list" aria-label="Bank categories not mapped yet">
                {data.unmapped.map((u) => (
                  <CodeRow
                    key={u.code}
                    code={u.code}
                    primary={u.primary}
                    details={`${codeDetails(u)} · uses ${u.fallsBackTo ? categoryOptionLabel(u.fallsBackTo) : 'Uncategorized'} now`}
                    warning={null}
                    current={null}
                    categories={cats}
                    draft={drafts.get(u.code)}
                    focus={focus}
                    onPick={pick(u.code, pfcLabel(u.code, u.primary))}
                  />
                ))}
              </ul>
            </>
          )}
          {/* Every Plaid category has a row, about 100 with the detailed ones: folded away until wanted. */}
          <details className="todo-completed" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
            <summary ref={focus.reg('summary')}>All bank categories ({data.rows.length})</summary>
            <ul className="todo-list" aria-label="Bank category mappings">
              {data.rows.map((r) => (
                <CodeRow
                  key={r.code}
                  code={r.code}
                  primary={r.primary}
                  details={codeDetails(r)}
                  warning={r.category.archived ? `${r.category.name} is archived, so this mapping is skipped. Pick another category.` : null}
                  current={r.category}
                  fallback={r.kind === 'detailed' ? (r.primary !== null ? (rowsByCode.get(r.primary)?.category ?? null) : null) : undefined}
                  categories={cats}
                  draft={drafts.get(r.code)}
                  focus={focus}
                  onPick={pick(r.code, pfcLabel(r.code, r.primary))}
                />
              ))}
            </ul>
          </details>
        </>
      )}
      {offerApply && count === 0 && (
        <p className="notice">
          Past transactions keep their categories until they're decided again.{' '}
          <button
            ref={focus.reg('apply')}
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (busy) return;
              if (!window.confirm('Apply the bank categories and every rule to past transactions? Categories and people set by hand stay as they are.')) return;
              setError(null);
              setStatus('');
              apply.mutate({ method: 'POST', path: '/rules/apply', label: 'the mapping and rules' });
            }}
          >
            Apply to past transactions
          </button>
        </p>
      )}
      <p role="status" className="muted todo-status">{status}</p>
      {/* Always in the page, so a screen reader hears the count change, and "Saving…". */}
      <p className="visually-hidden" aria-live="polite">{count === 0 ? '' : saving ? savingLine(count) : unsavedLine(count)}</p>
      {count > 0 && (
        <div ref={bar} className="spend-save-bar" role="region" aria-label="Unsaved bank category changes">
          {saveError &&
            (saveError.focused ? (
              <p ref={focus.reg('save-error')} tabIndex={-1} className="error">{saveError.message}</p>
            ) : (
              <p className="error" role="alert">{saveError.message}</p>
            ))}
          {tooMany && <p className="error">{`One save can take up to ${MAPPING_BATCH_MAX} changes. Discard some first.`}</p>}
          <span className="spend-save-actions">
            <button ref={saveButton} type="button" className="primary" aria-disabled={saving || tooMany} onClick={saveAll}>
              {saveLabel(count, hidden)}
            </button>
            <button type="button" aria-disabled={saving} onClick={discard}>Discard changes</button>
            {saving && <span className="muted" aria-hidden="true">Saving…</span>}
          </span>
        </div>
      )}
    </section>
  );
}
