import { useRef, useState } from 'react';
import {
  canImport, CSV_MAX_BYTES, mostlyPossibleDuplicates, POSSIBLE_DUPLICATE, SPEND_MESSAGES, startsTicked, type ImportPreview, type ImportResult, type PreviewRow,
} from '../../../shared/spend.js';
import { ApiError } from '../../api.js';
import { useFocusRegistry } from '../chores/useFocus.js';
import { cardName, longDate, money, previewNote, shortDate } from './format.js';
import { useCsvUpload, useSpendCards, useSpendWrite } from './queries.js';

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

/**
 * Spend settings: CSV import (spec §12.13). Pick a card and a Bank of America credit-card activity
 * file; the server reads it and answers with a preview: how many rows, their dates, likely
 * duplicates (left out unless ticked), possible duplicates with a different reference number
 * (ticked, with a warning, or unticked when they're most of the new rows), and rows that can't be
 * imported, with why. Import saves the
 * ticked rows. Nothing is saved until then, and the preview is forgotten after an hour.
 */
export function CsvImport() {
  const cards = useSpendCards();
  const focus = useFocusRegistry();
  const fileInput = useRef<HTMLInputElement>(null);
  const [cardId, setCardId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [include, setInclude] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const upload = useCsvUpload({
    onError: (err) => setError(err.message),
    onSuccess: (p, from) => {
      setPreview(p);
      setInclude(new Set(startsTicked(p.rows)));
      // From the Preview button: if focus has moved on while the file was read, it stays there.
      focus.focusLater(() => focus.get('preview'), from);
    },
  });
  const write = useSpendWrite<ImportResult | undefined>({
    onError: (v, err) => {
      if (err instanceof ApiError && err.status === 404) {
        // The preview expired (an hour) or was replaced: back to the upload form, which can start
        // again. Its file field comes back empty, so the file it held is forgotten too.
        setPreview(null);
        setFile(null);
        setError(SPEND_MESSAGES.importNotFound);
        focus.focusLater(() => focus.get('heading'), v.from);
        return;
      }
      setError(`Couldn't ${v.method === 'DELETE' ? 'cancel' : 'save'} the import. ${err.message}`);
    },
    onSuccess: (v, res) => {
      setPreview(null);
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      if (res) setStatus(`Imported ${res.imported} ${res.imported === 1 ? 'row' : 'rows'}. ${res.skipped} skipped.`);
      else setStatus('Import cancelled. Nothing was saved.');
      focus.focusLater(() => focus.get('heading'), v.from);
    },
  });

  const usable = (cards.data ?? []).filter((c) => !c.archived);
  const choosable = preview?.rows.filter((r) => canImport(r.status)) ?? [];
  const blocked = preview?.rows.filter((r) => !canImport(r.status)) ?? [];
  const chosen = choosable.filter((r) => include.has(r.line)).length;
  const duplicates = choosable.filter((r) => r.status === 'duplicate').length;
  const possible = choosable.filter((r) => r.status === 'new' && r.reason === POSSIBLE_DUPLICATE).length;

  return (
    <section aria-labelledby="spend-import-heading" className="admin-section">
      <h3 id="spend-import-heading" ref={focus.reg('heading')} tabIndex={-1}>Import a CSV</h3>
      {error && <p className="error" role="alert">{error}</p>}
      {!preview ? (
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
            Bank of America CSV
            <input ref={fileInput} type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button type="submit" className="primary" aria-disabled={upload.isPending}>{upload.isPending ? 'Reading…' : 'Preview'}</button>
          <p className="muted spend-form-note">
            In Bank of America's website, open the card's activity, choose Download, pick the dates, and pick Microsoft Excel Format. Up to 5 MB.
          </p>
        </form>
      ) : (
        <div className="spend-preview">
          <h4 ref={focus.reg('preview')} tabIndex={-1} className="spend-file-name">
            {preview.fileName ?? 'Your file'} for {cardName(preview.card)}
          </h4>
          <p>
            {preview.rows.length} {preview.rows.length === 1 ? 'row' : 'rows'}
            {preview.dateRange && `, ${longDate(preview.dateRange.from)} to ${longDate(preview.dateRange.to)}`}.{' '}
            {duplicates > 0 && `${duplicates} look like transactions already here, so they're left out unless you tick them. `}
            {possible > 0 &&
              (mostlyPossibleDuplicates(preview.rows)
                ? `${possible} look like transactions already here but have a different reference number, so they're left out unless you tick them. `
                : `${possible} look like transactions already here but have a different reference number, so they're ticked. Check them before importing. `)}
            {blocked.length > 0 && `${blocked.length} can't be imported.`}
          </p>
          {preview.warnings.map((w) => <p key={w.id} className="notice">{w.message}</p>)}
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
                write.mutate({ method: 'POST', path: `/imports/${preview.id}/commit`, body: { include: [...include] }, label: 'the import' });
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
                write.mutate({ method: 'DELETE', path: `/imports/${preview.id}`, label: 'the import' });
              }}
            >
              Cancel
            </button>
          </span>
        </div>
      )}
      <p role="status" className="muted todo-status">{status}</p>
    </section>
  );
}
