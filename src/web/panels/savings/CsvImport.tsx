import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  SAVINGS_CSV_MAX_BYTES, SAVINGS_DATE_FORMAT_LABELS, SAVINGS_GROUP_CHOICES, SAVINGS_MESSAGES, type SavingsAccountKind, type SavingsDateFormat, type SavingsGroupChoice,
  type SavingsImportDraft, type SavingsMapping,
} from '../../../shared/savings.js';
import { ApiError } from '../../api.js';
import { CHOICE_LABELS, columnName, dayLabel, groupLine, groupName, importAddsLine, importSkippedLine, importStep, prefilledLine } from './format.js';
import { formFromDraft, groupChoicesFrom, mappingFromForm, stepAfterUpdate, type MapForm } from './importForm.js';
import { cancelSavingsDraft, useSavingsCsvUpload, useUpdateSavingsImport } from './queries.js';

type Step = 'upload' | 'map' | 'groups' | 'results';

/**
 * Import a CSV into one account (the CSV import spec, "Importing" and "Reading any bank's CSV"):
 * upload; the columns (the file's first 8 rows, and a column for each role); what each group of
 * rows counts as; the results; Import. The server answers every step with the draft. A saved or
 * built-in format can skip straight to the results (plan decision 14), and the admin can go back
 * from there; any change to the columns goes through the groups again before the results show.
 * Import goes through the parent's account action, so the settings view refreshes. Nothing is
 * saved before Import. Closing the steps any way but Import (Cancel, the parent's toggle, another
 * of its forms, leaving the page) cancels the draft, so the server forgets the parsed rows at once;
 * one missed is pruned within the hour. Nothing from the file is kept here beyond what's on screen.
 * The account's kind is the server's, from the draft.
 */
export function SavingsCsvImport(props: { accountId: number; label: string; busy: boolean; onImport: (draftId: string) => void; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<SavingsImportDraft | null>(null);
  const [step, setStep] = useState<Step>('upload');
  const [error, setError] = useState<string | null>(null);
  // Where the upload's answer filled things in from: said only until the admin changes something.
  const [prefilled, setPrefilled] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [focusFile, setFocusFile] = useState(false);
  // The draft the server holds, and whether Import was sent for it: closing without Import cancels it.
  const live = useRef<{ id: string; imported: boolean } | null>(null);
  useEffect(() => {
    live.current = draft ? { id: draft.id, imported: live.current?.id === draft.id && live.current.imported } : null;
  }, [draft]);
  useEffect(() => () => {
    const d = live.current;
    if (d && !d.imported) cancelSavingsDraft(d.id);
  }, []);
  useEffect(() => {
    if (focusFile && step === 'upload') {
      fileInput.current?.focus();
      setFocusFile(false);
    }
  }, [focusFile, step]);
  const expired = () => {
    // The draft expired (an hour) or a newer upload replaced it: back to the upload, which starts again.
    setDraft(null);
    setFile(null);
    setPrefilled(null);
    setStep('upload');
    setError(SAVINGS_MESSAGES.importNotFound);
    // The heading goes away with the steps: focus the file field, where it starts again.
    setFocusFile(true);
  };
  const upload = useSavingsCsvUpload({
    onError: (err) => setError(err.message),
    onSuccess: (d) => {
      setError(null);
      setDraft(d);
      setPrefilled(prefilledLine(d));
      setStep(importStep(d));
    },
  });
  const update = useUpdateSavingsImport({
    onError: (err) => (err instanceof ApiError && err.status === 404 ? expired() : setError(err.message)),
    onSuccess: (d, sent) => {
      setError(null);
      setPrefilled(null);
      setDraft(d);
      setStep(stepAfterUpdate(d, sent.choices !== undefined));
    },
  });
  useEffect(() => {
    if (step !== 'upload') heading.current?.focus();
  }, [step]);
  // The unmount cancels the draft.
  const close = props.onClose;
  const go = (to: Step) => {
    setError(null);
    setStep(to);
  };
  const importDraft = (id: string) => {
    if (live.current?.id === id) live.current.imported = true;
    props.onImport(id);
  };

  if (step === 'upload' || !draft) {
    return (
      <form
        className="form-row savings-import-form"
        aria-label={`Import a CSV into ${props.label}`}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (upload.isPending) return;
          setError(null);
          if (!file) return setError(SAVINGS_MESSAGES.importNoFile);
          // Checked here too, so a big file isn't sent only to be refused.
          if (file.size > SAVINGS_CSV_MAX_BYTES) return setError(SAVINGS_MESSAGES.importTooBig);
          upload.mutate({ accountId: props.accountId, file });
        }}
      >
        <label>
          CSV file for {props.label}
          <input ref={fileInput} type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <button type="submit" className="primary" aria-disabled={upload.isPending}>{upload.isPending ? 'Reading…' : 'Next'}</button>
        <button type="button" onClick={props.onClose}>Cancel</button>
        <p className="muted spend-form-note">Your bank's activity download, up to 5 MB. Only dates, amounts, and balances are kept, never what each row says.</p>
        {error && <p className="error spend-form-note" role="alert">{error}</p>}
      </form>
    );
  }

  return (
    <section className="spend-preview savings-import" aria-label={`Import into ${props.label}`}>
      <h5 ref={heading} tabIndex={-1} className="spend-file-name savings-import-title">
        {draft.fileName ?? 'Your file'} into {props.label}: {step === 'map' ? 'the columns' : step === 'groups' ? 'what rows mean' : 'the results'}
      </h5>
      {prefilled && <p className="muted">{prefilled}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {step === 'map' && (
        <MapStep draft={draft} busy={update.isPending} onSave={(mapping) => update.mutate({ draftId: draft.id, body: { mapping } })} onCancel={close} />
      )}
      {step === 'groups' && draft.groups && draft.mapping && (
        <GroupsStep
          draft={draft}
          label={props.label}
          busy={update.isPending}
          onBack={() => go('map')}
          onSave={(choices) => update.mutate({ draftId: draft.id, body: { mapping: draft.mapping!, choices } })}
          onCancel={close}
        />
      )}
      {step === 'results' && draft.results && draft.groups && (
        <ResultsStep draft={draft} label={props.label} busy={props.busy} onImport={() => importDraft(draft.id)} onColumns={() => go('map')} onGroups={() => go('groups')} onCancel={close} />
      )}
    </section>
  );
}

/** The columns step: the sample, and a column for each role (the spec's "Mapping columns"). The server checks every row. */
function MapStep(props: { draft: SavingsImportDraft; busy: boolean; onSave: (m: SavingsMapping) => void; onCancel: () => void }) {
  const { draft } = props;
  // The server's kind for the account, not one the page worked out.
  const kind: SavingsAccountKind = draft.account.kind;
  const [v, setV] = useState<MapForm>(() => formFromDraft(draft, kind));
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<MapForm>) => setV((x) => ({ ...x, ...patch }));
  const formats = v.date === '' ? [] : draft.dateFormats[v.date] ?? [];
  const columns = draft.header.map((_, c) => <option key={c} value={c}>{columnName(draft.header, c)}</option>);
  const num = (s: string): number | '' => (s === '' ? '' : Number(s));
  const radio = `savings-amount-kind-${draft.id}`;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (props.busy) return;
    const made = mappingFromForm(v, kind);
    if (!made.ok) return setProblem(made.problem);
    setProblem(null);
    props.onSave(made.mapping);
  }

  return (
    <form className="event-form savings-map" aria-label="Columns of the file" onSubmit={submit} noValidate>
      {draft.problem && <p className="notice">{draft.problem}</p>}
      {/* Scrolls inside its own box, so the page never scrolls sideways on a phone; focusable so a keyboard can scroll it. */}
      <div className="savings-sample" role="region" aria-label={`The file's first ${draft.sample.length} rows`} tabIndex={0}>
        <table>
          <thead><tr>{draft.header.map((_, c) => <th key={c} scope="col">{columnName(draft.header, c)}</th>)}</tr></thead>
          <tbody>{draft.sample.map((cells, i) => <tr key={i}>{cells.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <p className="muted">{draft.rows} {draft.rows === 1 ? 'row' : 'rows'} in all. The first {draft.sample.length} are above.</p>
      <div className="form-row">
        <label>
          Date column
          <select
            value={v.date}
            onChange={(e) => {
              const date = num(e.target.value);
              const fits = date === '' ? [] : draft.dateFormats[date] ?? [];
              // One format: that one. Both M/D and D/M: the admin chooses (plan decision 8).
              set({ date, format: fits.length === 1 ? fits[0]! : '' });
            }}
          >
            <option value="">Choose a column</option>
            {columns}
          </select>
        </label>
        <label>
          Date format
          <select value={v.format} aria-describedby={formats.length > 1 ? `${radio}-dates` : undefined} onChange={(e) => set({ format: e.target.value as SavingsDateFormat | '' })}>
            <option value="">{v.date === '' ? 'Choose the column first' : formats.length === 0 ? 'Not a date column' : 'Choose a format'}</option>
            {formats.map((f) => <option key={f} value={f}>{SAVINGS_DATE_FORMAT_LABELS[f]}</option>)}
          </select>
        </label>
        {formats.length > 1 && (
          <p id={`${radio}-dates`} className="notice spend-form-note">Every day in this column is 12 or under, so its dates could be month first or day first. Choose which.</p>
        )}
      </div>
      <fieldset className="calendar-picks">
        <legend>Amount</legend>
        <label className="inline-check"><input type="radio" name={radio} checked={v.kind === 'signed'} onChange={() => set({ kind: 'signed' })} /> One column, money out negative</label>
        <label className="inline-check"><input type="radio" name={radio} checked={v.kind === 'split'} onChange={() => set({ kind: 'split' })} /> Separate debit and credit columns</label>
      </fieldset>
      {v.kind === 'signed' ? (
        <>
          <div className="form-row">
            <label>
              Amount column
              <select value={v.amount} onChange={(e) => set({ amount: num(e.target.value) })}><option value="">Choose a column</option>{columns}</select>
            </label>
          </div>
          <label className="inline-check"><input type="checkbox" checked={v.inIsNegative} onChange={(e) => set({ inIsNegative: e.target.checked })} /> Money in is negative in this file</label>
        </>
      ) : (
        <div className="form-row">
          <label>Debit column (money out)<select value={v.debit} onChange={(e) => set({ debit: num(e.target.value) })}><option value="">Choose a column</option>{columns}</select></label>
          <label>Credit column (money in)<select value={v.credit} onChange={(e) => set({ credit: num(e.target.value) })}><option value="">Choose a column</option>{columns}</select></label>
        </div>
      )}
      <div className="form-row">
        <label>
          Balance column
          <select value={v.balance} onChange={(e) => set({ balance: num(e.target.value) })}><option value="">None</option>{columns}</select>
        </label>
        <p className="muted spend-form-note">
          {kind === 'cash' ? "A cash account's balance column becomes its daily balances." : "Most brokerage files' balance is only their cash, so it's ignored unless you tick the box."}
        </p>
      </div>
      {kind === 'investment' && v.balance !== '' && (
        <label className="inline-check"><input type="checkbox" checked={v.isValue} onChange={(e) => set({ isValue: e.target.checked })} /> It's the account's whole value</label>
      )}
      <div className="form-row">
        <label>
          Description column
          <select value={v.description} onChange={(e) => set({ description: num(e.target.value) })}><option value="">None</option>{columns}</select>
        </label>
        <p className="muted spend-form-note">The description tells real deposits and withdrawals from interest, trades, and dividends. Only its first two words are saved.</p>
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      <span className="todo-actions">
        <button type="submit" className="primary" aria-disabled={props.busy}>{props.busy ? 'Checking…' : 'Next'}</button>
        <button type="button" onClick={props.onCancel}>Cancel</button>
      </span>
    </form>
  );
}

/** The groups step: each description group's choice. A new group is preselected with its suggestion and marked New. */
function GroupsStep(props: { draft: SavingsImportDraft; label: string; busy: boolean; onBack: () => void; onSave: (choices: Record<string, SavingsGroupChoice>) => void; onCancel: () => void }) {
  const groups = props.draft.groups!;
  const [choices, setChoices] = useState<Record<string, SavingsGroupChoice>>(() => groupChoicesFrom(groups));
  const fresh = groups.filter((g) => g.choice === null).length;
  return (
    <form
      className="event-form"
      aria-label={`What rows mean for ${props.label}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!props.busy) props.onSave(choices);
      }}
    >
      <p className="muted">
        Rows are grouped by the first two words of their description. Choose what each group counts as. Not counted lands in {props.draft.account.kind === 'investment' ? 'Market change' : 'Other change'}, and a zero amount is never counted.
      </p>
      {fresh > 0 && <p className="notice">{fresh === 1 ? "1 group is new, so it's" : `${fresh} groups are new, so they're`} marked New with a suggestion picked. Check {fresh === 1 ? 'it' : 'them'}.</p>}
      <ul className="todo-list savings-groups" aria-label="Groups of rows">
        {groups.map((g) => (
          <li key={g.label} className="todo-row">
            <label className="savings-group">
              <span className="savings-group-name">
                {groupName(g.label)} ({g.count} {g.count === 1 ? 'row' : 'rows'})
                {g.choice === null && <span className="chore-badge">New</span>}
              </span>
              <select aria-label={`What ${groupName(g.label)} rows count as${g.choice === null ? ', new' : ''}`} value={choices[g.label]} onChange={(e) => setChoices((c) => ({ ...c, [g.label]: e.target.value as SavingsGroupChoice }))}>
                {SAVINGS_GROUP_CHOICES.map((c) => <option key={c} value={c}>{CHOICE_LABELS[c]}</option>)}
              </select>
            </label>
          </li>
        ))}
      </ul>
      <span className="todo-actions">
        <button type="submit" className="primary" aria-disabled={props.busy}>{props.busy ? 'Checking…' : 'Next'}</button>
        <button type="button" onClick={props.onBack}>Back to the columns</button>
        <button type="button" onClick={props.onCancel}>Cancel</button>
      </span>
    </form>
  );
}

/** The results: what Import adds and skips, each group and what it counts as, and warnings. */
function ResultsStep(props: { draft: SavingsImportDraft; label: string; busy: boolean; onImport: () => void; onColumns: () => void; onGroups: () => void; onCancel: () => void }) {
  const r = props.draft.results!;
  const skipped = importSkippedLine(r);
  const nothing = r.deposits.add + r.withdrawals.add + r.balances.add === 0;
  return (
    <section className="savings-results" aria-label={`Results of the import into ${props.label}`}>
      <p>{props.draft.rows} {props.draft.rows === 1 ? 'row' : 'rows'}, {dayLabel(r.dateRange.from)} to {dayLabel(r.dateRange.to)}. {importAddsLine(r)}</p>
      {skipped && <p className="muted">{skipped}</p>}
      {nothing && <p className="notice">{SAVINGS_MESSAGES.importNothingNew}</p>}
      {r.warnings.map((w) => <p key={w.id} className="notice">{w.message}</p>)}
      <ul className="savings-groups-result" aria-label="What each group counts as">
        {props.draft.groups!.map((g) => <li key={g.label}>{groupLine({ ...g, choice: g.choice ?? g.suggested })}</li>)}
      </ul>
      <span className="todo-actions">
        <button type="button" className="primary" disabled={nothing} aria-disabled={props.busy} onClick={() => !props.busy && props.onImport()}>{props.busy ? 'Importing…' : 'Import'}</button>
        <button type="button" onClick={props.onColumns}>Change the columns</button>
        <button type="button" onClick={props.onGroups}>Change what rows mean</button>
        <button type="button" onClick={props.onCancel}>Cancel</button>
      </span>
    </section>
  );
}
