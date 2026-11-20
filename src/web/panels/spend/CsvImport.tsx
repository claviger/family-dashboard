import { useRef, useState, type FormEvent } from 'react';
import { CSV_DATE_FORMAT_LABELS, type CsvDateFormat } from '../../../shared/csvImport.js';
import {
  canImport, CSV_MAX_BYTES, mostlyPossibleDuplicates, POSSIBLE_DUPLICATE, SPEND_MESSAGES, startsTicked, type CardMapping, type ImportPreview, type ImportResult, type PreviewRow,
} from '../../../shared/spend.js';
import { ApiError } from '../../api.js';
import { useFocusRegistry } from '../chores/useFocus.js';
import { columnName } from '../savings/format.js';
import { cardName, longDate, money, prefilledNote, previewNote, shortDate, skippedNote } from './format.js';
import { formFromPreview, mappingFromForm, type CardMapForm } from './importForm.js';
import { useCsvUpload, useSpendCards, useSpendWrite, useUpdateCsvImport } from './queries.js';

const STATUS_NOTES: Record<PreviewRow['status'], string> = {
  new: '',
  duplicate: 'Looks like one already here',
  already_imported: 'Already imported',
  repeated: 'Repeats an earlier row',
  pending_credit: 'Not posted yet',
  unreadable: "Couldn't be read",
};

function rowText(r: PreviewRow): string {
  return [r.date ? shortDate(r.date) : null, r.payee, r.amountCents !== null ? money(r.amountCents) : null].filter(Boolean).join(', ');
}

type Step = 'upload' | 'columns' | 'preview';

/**
 * Spend settings: CSV import (spec §12.13, the generic import design). Pick a card and its issuer's
 * activity file. A file the card's saved columns or a built-in format (Bank of America's) can read
 * goes straight to the preview; any other opens the columns step first (the first 8 rows, and a
 * column for each role), and its Preview reads the rows. The preview is as before: how many rows,
 * their dates, likely and possible duplicates, and rows that can't be imported, with why, and
 * Change the columns. Import saves the ticked rows and the card's columns. Nothing is saved until
 * then, and the draft is forgotten after an hour. A row's reference number, or the key the server
 * makes for a file without one, is never shown.
 */
export function CsvImport() {
  const cards = useSpendCards();
  const focus = useFocusRegistry();
  const fileInput = useRef<HTMLInputElement>(null);
  const [cardId, setCardId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<ImportPreview | null>(null);
  const [step, setStep] = useState<Step>('upload');
  // Where the upload's answer filled the columns in from: said only with that answer.
  const [note, setNote] = useState<string | null>(null);
  const [include, setInclude] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  /** Shows an answer at its step, with focus on that step's heading, unless focus moved on while it was out. */
  const show = (d: ImportPreview, from: Element | null) => {
    setError(null);
    setDraft(d);
    setStep(d.step);
    if (d.step === 'preview') setInclude(new Set(startsTicked(d.rows)));
    focus.focusLater(() => focus.get(d.step), from);
  };
  /** The draft expired (an hour) or was replaced: back to the upload form, whose file field comes back empty. */
  const expired = (from?: Element | null) => {
    setDraft(null);
    setStep('upload');
    setFile(null);
    setNote(null);
    setError(SPEND_MESSAGES.importNotFound);
    focus.focusLater(() => focus.get('heading'), from);
  };
  const upload = useCsvUpload({
    onError: (err) => setError(err.message),
    onSuccess: (d, from) => {
      setNote(prefilledNote(d));
      show(d, from);
    },
  });
  const update = useUpdateCsvImport({
    onError: (err, from) => (err instanceof ApiError && err.status === 404 ? expired(from) : setError(err.message)),
    onSuccess: (d, from) => {
      setNote(null);
      show(d, from);
    },
  });
  const write = useSpendWrite<ImportResult | undefined>({
    onError: (v, err) => {
      if (err instanceof ApiError && err.status === 404) return expired(v.from);
      setError(`Couldn't ${v.method === 'DELETE' ? 'cancel' : 'save'} the import. ${err.message}`);
    },
    onSuccess: (v, res) => {
      setDraft(null);
      setStep('upload');
      setNote(null);
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      if (res) setStatus(`Imported ${res.imported} ${res.imported === 1 ? 'row' : 'rows'}. ${res.skipped} skipped.`);
      else setStatus('Import cancelled. Nothing was saved.');
      focus.focusLater(() => focus.get('heading'), v.from);
    },
  });
  const cancel = () => {
    if (!draft || write.isPending) return;
    setError(null);
    write.mutate({ method: 'DELETE', path: `/imports/${draft.id}`, label: 'the import' });
  };

  const usable = (cards.data ?? []).filter((c) => !c.archived);
  const choosable = draft?.rows.filter((r) => canImport(r.status)) ?? [];
  const blocked = draft?.rows.filter((r) => !canImport(r.status)) ?? [];
  const chosen = choosable.filter((r) => include.has(r.line)).length;
  const duplicates = choosable.filter((r) => r.status === 'duplicate').length;
  const possible = choosable.filter((r) => r.status === 'new' && r.reason === POSSIBLE_DUPLICATE).length;
  const skipped = draft ? skippedNote(draft.columns) : null;

  return (
    <section aria-labelledby="spend-import-heading" className="admin-section">
      <h3 id="spend-import-heading" ref={focus.reg('heading')} tabIndex={-1}>Import a CSV</h3>
      {error && <p className="error" role="alert">{error}</p>}
      {step === 'upload' || !draft ? (
        <form
          className="form-row"
          aria-label="Upload a CSV"
          onSubmit={(e) => {
            e.preventDefault();
            // Preview is aria-disabled, not disabled, while it reads, so focus stays on it if that fails.
            if (upload.isPending) return;
            setError(null);
            setStatus('');
            if (cardId === '' || !file) {
              setError('Pick a card and a file first.');
              return;
            }
            // Checked here too, so a big file isn't sent only to be refused.
            if (file.size > CSV_MAX_BYTES) {
              setError(SPEND_MESSAGES.importTooBig);
              return;
            }
            upload.mutate({ cardId: Number(cardId), file });
          }}
        >
          <label>
            Card
            <select value={cardId} onChange={(e) => setCardId(e.target.value)}>
              <option value="">Pick a card</option>
              {usable.map((c) => <option key={c.id} value={c.id}>{cardName(c)}</option>)}
            </select>
          </label>
          <label>
            CSV file
            <input ref={fileInput} type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button type="submit" className="primary" aria-disabled={upload.isPending}>{upload.isPending ? 'Reading…' : 'Preview'}</button>
          <p className="muted spend-form-note">
            Your card's activity download, up to 5 MB. Bank of America files are read as they are. For another card, you choose the columns first, and they're saved for the card. In
            Bank of America's website: the card's activity, Download, the dates, Microsoft Excel Format.
          </p>
        </form>
      ) : step === 'columns' ? (
        <div className="spend-preview">
          <h4 ref={focus.reg('columns')} tabIndex={-1} className="spend-file-name">
            {draft.fileName ?? 'Your file'} for {cardName(draft.card)}: the columns
          </h4>
          {note && <p className="muted">{note}</p>}
          {skipped && <p className="muted">{skipped}</p>}
          <ColumnsStep
            draft={draft}
            busy={update.isPending}
            onSave={(mapping) => {
              setError(null);
              update.mutate({ id: draft.id, mapping });
            }}
            onCancel={cancel}
          />
        </div>
      ) : (
        <div className="spend-preview">
          <h4 ref={focus.reg('preview')} tabIndex={-1} className="spend-file-name">
            {draft.fileName ?? 'Your file'} for {cardName(draft.card)}
          </h4>
          {note && <p className="muted">{note}</p>}
          {draft.columns.problem && <p className="notice">{draft.columns.problem}</p>}
          <p>
            {draft.rows.length} {draft.rows.length === 1 ? 'row' : 'rows'}
            {draft.dateRange && `, ${longDate(draft.dateRange.from)} to ${longDate(draft.dateRange.to)}`}.{' '}
            {duplicates > 0 && `${duplicates} look like transactions already here, so they're left out unless you tick them. `}
            {possible > 0 &&
              (mostlyPossibleDuplicates(draft.rows)
                ? `${possible} look like transactions already here but have a different reference number, so they're left out unless you tick them. `
                : `${possible} look like transactions already here but have a different reference number, so they're ticked. Check them before importing. `)}
            {blocked.length > 0 && `${blocked.length} can't be imported.`}
          </p>
          {skipped && <p className="muted">{skipped}</p>}
          {draft.warnings.map((w) => <p key={w.id} className="notice">{w.message}</p>)}
          {choosable.length > 0 && (
            <fieldset className="spend-preview-rows">
              <legend>Rows to import</legend>
              <span className="todo-actions">
                <button type="button" onClick={() => setInclude(new Set(choosable.map((r) => r.line)))}>Tick all</button>
                <button type="button" onClick={() => setInclude(new Set())}>Untick all</button>
              </span>
              <ul className="todo-list">
                {choosable.map((r) => (
                  <li key={r.line} className="todo-row">
                    <label className="inline-check spend-preview-row">
                      <input
                        type="checkbox"
                        checked={include.has(r.line)}
                        onChange={(e) => {
                          const next = new Set(include);
                          if (e.target.checked) next.add(r.line);
                          else next.delete(r.line);
                          setInclude(next);
                        }}
                      />
                      <span className="todo-main">
                        <span>Line {r.line}: {rowText(r)}</span>
                        {previewNote(r) && <span className="todo-due warning">{previewNote(r)}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          {blocked.length > 0 && (
            <section aria-label="Rows that can't be imported" className="spend-preview-blocked">
              <h4>Rows that can't be imported</h4>
              <ul className="todo-list">
                {blocked.map((r) => (
                  <li key={r.line} className="todo-row">
                    <span className="todo-main">
                      <span>Line {r.line}{rowText(r) ? `: ${rowText(r)}` : ''}</span>
                      <span className="todo-due">{r.reason ?? STATUS_NOTES[r.status]}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <span className="todo-actions">
            {/* aria-disabled while a write is out, so focus stays on the button if it fails. */}
            <button
              type="button"
              className="primary"
              disabled={chosen === 0}
              aria-disabled={write.isPending}
              onClick={() => {
                if (write.isPending) return;
                setError(null);
                write.mutate({ method: 'POST', path: `/imports/${draft.id}/commit`, body: { include: [...include] }, label: 'the import' });
              }}
            >
              Import {chosen} {chosen === 1 ? 'row' : 'rows'}
            </button>
            <button
              type="button"
              aria-disabled={write.isPending}
              onClick={() => {
                if (write.isPending) return;
                setError(null);
                setNote(null);
                setStep('columns');
                focus.focusLater(() => focus.get('columns'));
              }}
            >
              Change the columns
            </button>
            <button type="button" aria-disabled={write.isPending} onClick={cancel}>
              Cancel
            </button>
          </span>
        </div>
      )}
      <p role="status" className="muted todo-status">{status}</p>
    </section>
  );
}

/** The columns step: the sample, and a column for each role (the generic import design, "Map columns"). The server checks every row. */
function ColumnsStep(props: { draft: ImportPreview; busy: boolean; onSave: (m: CardMapping) => void; onCancel: () => void }) {
  const { header, sample, dateFormats, rowCount, problem, hint } = props.draft.columns;
  const [v, setV] = useState<CardMapForm>(() => formFromPreview(props.draft));
  const [mistake, setMistake] = useState<string | null>(null);
  const set = (patch: Partial<CardMapForm>) => setV((x) => ({ ...x, ...patch }));
  const formats = v.date === '' ? [] : dateFormats[v.date] ?? [];
  const columns = header.map((_, c) => <option key={c} value={c}>{columnName(header, c)}</option>);
  const num = (s: string): number | '' => (s === '' ? '' : Number(s));
  const id = `spend-columns-${props.draft.id}`;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (props.busy) return;
    const made = mappingFromForm(v);
    if (!made.ok) return setMistake(made.problem);
    setMistake(null);
    props.onSave(made.mapping);
  }

  return (
    <form className="event-form spend-columns" aria-label="Columns of the file" onSubmit={submit} noValidate>
      {hint && <p className="notice">{hint}</p>}
      {problem && <p className="notice">{problem}</p>}
      {/* Scrolls inside its own box, so the page never scrolls sideways on a phone; focusable so a keyboard can scroll it. */}
      <div className="csv-sample" role="region" aria-label={`The file's first ${sample.length} rows`} tabIndex={0}>
        <table>
          <thead><tr>{header.map((_, c) => <th key={c} scope="col">{columnName(header, c)}</th>)}</tr></thead>
          <tbody>{sample.map((cells, i) => <tr key={i}>{cells.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <p className="muted">{rowCount} {rowCount === 1 ? 'row' : 'rows'} in all. The first {sample.length} are above.</p>
      <div className="form-row">
        <label>
          Date column
          <select
            value={v.date}
            onChange={(e) => {
              const date = num(e.target.value);
              const fits = date === '' ? [] : dateFormats[date] ?? [];
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
          <select value={v.format} aria-describedby={formats.length > 1 ? `${id}-dates` : undefined} onChange={(e) => set({ format: e.target.value as CsvDateFormat | '' })}>
            <option value="">{v.date === '' ? 'Choose the column first' : formats.length === 0 ? 'Not a date column' : 'Choose a format'}</option>
            {formats.map((f) => <option key={f} value={f}>{CSV_DATE_FORMAT_LABELS[f]}</option>)}
          </select>
        </label>
        {formats.length > 1 && (
          <p id={`${id}-dates`} className="notice spend-form-note">Every day in this column is 12 or under, so its dates could be month first or day first. Choose which.</p>
        )}
      </div>
      <p className="muted spend-form-note">A row with no date hasn't posted yet: it's skipped and counted.</p>
      <fieldset className="calendar-picks">
        <legend>Amount</legend>
        <label className="inline-check"><input type="radio" name={id} checked={v.kind === 'signed'} onChange={() => set({ kind: 'signed' })} /> One amount column</label>
        <label className="inline-check"><input type="radio" name={id} checked={v.kind === 'split'} onChange={() => set({ kind: 'split' })} /> Separate columns for charges and for payments and credits</label>
      </fieldset>
      {v.kind === 'signed' ? (
        <>
          <div className="form-row">
            <label>Amount column<select value={v.amount} onChange={(e) => set({ amount: num(e.target.value) })}><option value="">Choose a column</option>{columns}</select></label>
          </div>
          <label className="inline-check"><input type="checkbox" checked={v.purchasesNegative} onChange={(e) => set({ purchasesNegative: e.target.checked })} /> Purchases are negative in this file</label>
        </>
      ) : (
        <div className="form-row">
          <label>Charges column<select value={v.charges} onChange={(e) => set({ charges: num(e.target.value) })}><option value="">Choose a column</option>{columns}</select></label>
          <label>Payments and credits column<select value={v.credits} onChange={(e) => set({ credits: num(e.target.value) })}><option value="">Choose a column</option>{columns}</select></label>
          <p className="muted spend-form-note">Both are read as positive, whatever sign the file uses. A row with both a charge and a credit can't be imported.</p>
        </div>
      )}
      <div className="form-row">
        <label>Description or payee column<select value={v.description} onChange={(e) => set({ description: num(e.target.value) })}><option value="">Choose a column</option>{columns}</select></label>
        <label>Reference number column<select value={v.reference} onChange={(e) => set({ reference: num(e.target.value) })}><option value="">None</option>{columns}</select></label>
        <label>Address or location column<select value={v.address} onChange={(e) => set({ address: num(e.target.value) })}><option value="">None</option>{columns}</select></label>
        <p className="muted spend-form-note">
          Without a reference number, each row gets a key from its date, amount, and description, so importing an overlapping file adds only the rows that aren't here yet.
        </p>
      </div>
      {mistake && <p className="error" role="alert">{mistake}</p>}
      <span className="todo-actions">
        <button type="submit" className="primary" aria-disabled={props.busy}>{props.busy ? 'Reading…' : 'Preview'}</button>
        <button type="button" onClick={props.onCancel}>Cancel</button>
      </span>
    </form>
  );
}
