import { TRANSACTION_BATCH_MAX, type SpendTransaction, type TransactionBatchChange } from '../../../shared/spend.js';
import { spendViewFromSearch } from './spendSearch.js';

/**
 * The transaction table's unsaved picks (spec §12.12). Changing a category or person picker only
 * changes a draft for that row, so arrowing through a select never saves; one Save sends every
 * draft at once. Drafts are kept by transaction id, so a row hidden by a filter, a search, or
 * another cycle keeps its drafts, and they're still saved. Pure, so it's unit-tested.
 */
export type DraftField = 'category' | 'person';
const FIELDS = ['category', 'person'] as const;

/** Picker values: a category id, a person id, or '' for Household. */
export interface FieldDraft {
  /** What was picked. */
  value: string;
  /** What was saved when it was picked. */
  base: string;
  /** What someone else has saved since (seen in fresh rows, or in the server's refusal): flagged. */
  changedTo?: string;
}

export interface RowDraft {
  /** The start of the cycle the row was picked in, so a fresh fetch of that cycle can tell it's gone. */
  cycle: string | null;
  /** How the row was named when picked (merchant, date, amount), for messages once it's hidden. Never stored. */
  label?: string;
  category?: FieldDraft;
  person?: FieldDraft;
}

export type Drafts = ReadonlyMap<number, RowDraft>;

export const NO_DRAFTS: Drafts = new Map();

/** Where a pick was made: the cycle shown, and the row's name. */
export interface DraftPlace {
  cycle: string | null;
  label: string;
}

/** A field's saved value as its picker holds it: the category id, or the person's id ('' for Household). */
export function pickerValue(t: SpendTransaction, field: DraftField): string {
  return field === 'category' ? String(t.category.id) : String(t.person?.id ?? '');
}

export function fieldDraft(drafts: Drafts, id: number, field: DraftField): FieldDraft | undefined {
  return drafts.get(id)?.[field];
}

/** What a row's picker shows: its draft, or else the saved value. */
export function draftValue(drafts: Drafts, t: SpendTransaction, field: DraftField): string {
  return fieldDraft(drafts, t.id, field)?.value ?? pickerValue(t, field);
}

export function isEdited(drafts: Drafts, id: number, field: DraftField): boolean {
  return fieldDraft(drafts, id, field) !== undefined;
}

/** A copy of `drafts` with `id`'s row replaced; the row goes once it has no field left. */
function withRow(drafts: Drafts, id: number, row: RowDraft): Map<number, RowDraft> {
  const next = new Map(drafts);
  if (row.category === undefined && row.person === undefined) next.delete(id);
  else next.set(id, row);
  return next;
}

function withField(row: RowDraft, field: DraftField, value: FieldDraft | undefined): RowDraft {
  const next: RowDraft = { ...row };
  if (value === undefined) delete next[field];
  else next[field] = value;
  return next;
}

/** Applies `update` to every row; the same map comes back when no row changes. */
function mapRows(drafts: Drafts, update: (id: number, row: RowDraft) => RowDraft | null): Drafts {
  let next: Map<number, RowDraft> | null = null;
  for (const [id, row] of drafts) {
    const changed = update(id, row);
    if (changed === row) continue;
    next ??= new Map(drafts);
    if (changed === null || (changed.category === undefined && changed.person === undefined)) next.delete(id);
    else next.set(id, changed);
  }
  return next ?? drafts;
}

/**
 * A pick in `t`'s picker. Picking the saved value again clears that field's draft. A new pick is
 * made against what's saved now, so picking again on a flagged field clears the flag. The same
 * map comes back when nothing changes, so a render isn't wasted.
 */
export function setDraft(drafts: Drafts, t: SpendTransaction, field: DraftField, value: string, place: DraftPlace): Drafts {
  const row = drafts.get(t.id);
  const saved = pickerValue(t, field);
  if (value === saved) return row?.[field] === undefined ? drafts : withRow(drafts, t.id, withField(row, field, undefined));
  if (row?.[field]?.value === value) return drafts;
  return withRow(drafts, t.id, withField({ ...row, cycle: place.cycle, label: place.label }, field, { value, base: saved }));
}

/**
 * After Remove rule (reset to automatic) on `id`: clears the fields it reset, but only those whose draft still
 * holds what it did when the reset was sent (`sent`). A pick made since is newer, so it stays.
 */
export function clearSent(drafts: Drafts, id: number, fields: readonly DraftField[], sent: RowDraft | undefined): Drafts {
  const row = drafts.get(id);
  if (!row || !sent) return drafts;
  let next = row;
  for (const f of fields) {
    if (sent[f] !== undefined && row[f]?.value === sent[f]!.value) next = withField(next, f, undefined);
  }
  return next === row ? drafts : withRow(drafts, id, next);
}

/** How many fields are edited, across every row, shown or not. */
export function draftCount(drafts: Drafts): number {
  let n = 0;
  for (const d of drafts.values()) n += (d.category !== undefined ? 1 : 0) + (d.person !== undefined ? 1 : 0);
  return n;
}

/** How many edited fields are on rows the table doesn't show. */
export function hiddenCount(drafts: Drafts, shownIds: ReadonlySet<number>): number {
  return draftCount(new Map([...drafts].filter(([id]) => !shownIds.has(id))));
}

/**
 * Against fresh rows from the server (after a save, a refetch, or a rule): a draft that holds the
 * saved value goes. One picked while a save was out differs, so it stays (review S3-M1). A field
 * someone else has changed to a third value keeps its draft and is flagged (`changedTo`), until
 * it's picked again, saved, or changed back.
 *
 * `ownSave`: the rows the person's own Save returned. A pick made while it was out differs from
 * what was saved, but the person saved that value themselves, so the pick is now made against it
 * (its new base), not flagged.
 */
export function settleDrafts(drafts: Drafts, rows: readonly SpendTransaction[], ownSave = false): Drafts {
  const byId = new Map(rows.map((t) => [t.id, t]));
  return mapRows(drafts, (id, row) => {
    const t = byId.get(id);
    if (!t) return row;
    let next = row;
    for (const f of FIELDS) {
      const d = next[f];
      if (!d) continue;
      const saved = pickerValue(t, f);
      if (saved === d.value) next = withField(next, f, undefined);
      else if (ownSave) {
        if (saved !== d.base || d.changedTo !== undefined) next = withField(next, f, { value: d.value, base: saved });
      } else {
        const changedTo = saved === d.base ? undefined : saved;
        if (changedTo !== d.changedTo) next = withField(next, f, changedTo === undefined ? { value: d.value, base: d.base } : { ...d, changedTo });
      }
    }
    return next;
  });
}

/** A fresh fetch of `cycle`: drafts picked in it whose row isn't in it any more are for rows that are gone. */
export function pruneMissing(drafts: Drafts, cycle: string, rows: readonly SpendTransaction[]): Drafts {
  const ids = new Set(rows.map((t) => t.id));
  return mapRows(drafts, (id, row) => (row.cycle === cycle && !ids.has(id) ? null : row));
}

/** Drops the rows the server says no longer exist. */
export function dropIds(drafts: Drafts, ids: readonly number[]): Drafts {
  const gone = new Set(ids);
  return mapRows(drafts, (id, row) => (gone.has(id) ? null : row));
}

/**
 * After a save the server refused because rows are gone (the batch PATCH's 404: `missingIds`, and
 * `replacedBy`, old id to new id, for the ones a bank sync replaced: a Plaid row that took a CSV
 * row's place, or the posted version of a pending one). Each replaced row's drafts move to the row
 * that took its place, keeping `base` and `changedTo`, so the next Save sends the same `expected`
 * and the server refuses with its usual 409 if the new row holds something else. A field the new
 * row has its own draft for keeps that one (it was picked on the new row). A moved row's cycle is
 * cleared, since the new row may be dated into another cycle and a fresh fetch of the old one
 * mustn't drop it. The other missing rows' drafts are dropped. `moved` counts the fields moved,
 * and `removed` the ones lost.
 */
export function settleMissing(
  drafts: Drafts,
  missingIds: readonly number[],
  replacedBy: Readonly<Record<string, unknown>> | undefined,
): { drafts: Drafts; moved: number; removed: number; first: { id: number; field: DraftField } | null } {
  const next = new Map(drafts);
  let moved = 0;
  let first: { id: number; field: DraftField } | null = null;
  for (const id of new Set(missingIds)) {
    const row = next.get(id);
    if (!row) continue;
    next.delete(id);
    const to = replacedBy?.[String(id)];
    if (typeof to !== 'number' || !Number.isSafeInteger(to) || to <= 0 || to === id) continue;
    const target = next.get(to);
    const label = target?.label ?? row.label;
    let merged: RowDraft = { ...target, cycle: null, ...(label !== undefined && { label }) };
    for (const f of FIELDS) {
      if (row[f] === undefined || target?.[f] !== undefined) continue;
      merged = withField(merged, f, row[f]);
      moved += 1;
      first ??= { id: to, field: f };
    }
    if (merged.category !== undefined || merged.person !== undefined) next.set(to, merged);
  }
  const out: Drafts = next.size === drafts.size && [...next].every(([id, row]) => drafts.get(id) === row) ? drafts : next;
  return { drafts: out, moved, removed: draftCount(drafts) - draftCount(out), first };
}

/** Flags the fields the server refused because someone else changed them, with what's saved now. */
export function markConflicts(drafts: Drafts, conflicts: readonly { transactionId: number; field: DraftField; current: number | null }[]): Drafts {
  let next = drafts;
  for (const c of conflicts) {
    const row = next.get(c.transactionId);
    const d = row?.[c.field];
    if (!row || !d) continue;
    next = withRow(next, c.transactionId, withField(row, c.field, { ...d, changedTo: c.current === null ? '' : String(c.current) }));
  }
  return next;
}

const asId = (v: string) => (v === '' ? null : Number(v));

/**
 * The body of the one Save: a change per row, with what each field was last seen holding. A
 * flagged field has been seen changed, so Save means "use my pick anyway".
 */
export function draftChanges(drafts: Drafts): TransactionBatchChange[] {
  return [...drafts].map(([id, d]) => ({
    id,
    ...(d.category && { categoryId: Number(d.category.value) }),
    ...(d.person && { personUserId: asId(d.person.value) }),
    expected: {
      ...(d.category && { categoryId: Number(d.category.changedTo ?? d.category.base) }),
      ...(d.person && { personUserId: asId(d.person.changedTo ?? d.person.base) }),
    },
  }));
}

/*
 * Storage (sessionStorage, so drafts survive a reload): ids and picks only. Labels hold merchant
 * names, so they're never written; a restored row gets its name back when it's shown.
 */

export function serializeDrafts(drafts: Drafts): string {
  return JSON.stringify({ v: 1, rows: [...drafts].map(([id, { label: _label, ...rest }]) => [id, rest]) });
}

const isPick = (v: unknown) => typeof v === 'string' && (v === '' || /^\d+$/.test(v));

function fieldFrom(raw: unknown): FieldDraft | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const f = raw as Record<string, unknown>;
  if (!isPick(f.value) || !isPick(f.base)) return undefined;
  if (f.changedTo !== undefined && !isPick(f.changedTo)) return undefined;
  return { value: f.value as string, base: f.base as string, ...(f.changedTo !== undefined && { changedTo: f.changedTo as string }) };
}

/** Reads what `serializeDrafts` wrote. Anything broken, foreign, or from another version reads as no drafts. */
export function parseDrafts(text: string | null): Drafts {
  let data: unknown;
  try {
    data = JSON.parse(text ?? '');
  } catch {
    return NO_DRAFTS;
  }
  const rows = (data as { v?: unknown; rows?: unknown } | null)?.rows;
  if ((data as { v?: unknown } | null)?.v !== 1 || !Array.isArray(rows)) return NO_DRAFTS;
  const out = new Map<number, RowDraft>();
  for (const entry of rows) {
    if (!Array.isArray(entry) || !Number.isSafeInteger(entry[0]) || entry[0] <= 0 || !entry[1] || typeof entry[1] !== 'object') continue;
    const raw = entry[1] as Record<string, unknown>;
    if (raw.cycle !== null && typeof raw.cycle !== 'string') continue;
    const row: RowDraft = { cycle: raw.cycle as string | null };
    const category = fieldFrom(raw.category);
    const person = fieldFrom(raw.person);
    if (category) row.category = category;
    if (person) row.person = person;
    if (category || person) out.set(entry[0] as number, row);
  }
  return out;
}

/* Copy. N always counts changed fields; the limit of one save counts transactions, and says so. */

const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;

export const saveLabel = (n: number, hidden: number) => `Save ${changes(n)}${hidden > 0 ? ` (${hidden} not shown)` : ''}`;

export const unsavedLine = (n: number) => `${n} unsaved ${n === 1 ? 'change' : 'changes'}.`;

export const savingLine = (n: number) => `Saving ${changes(n)}…`;

/** Before leaving the card's overview (another card, settings, another page, signing out). */
export const discardQuestion = (n: number) => `Discard ${n} unsaved ${n === 1 ? 'change' : 'changes'}?`;

/** Before leaving while a Save is out: the drafts are being saved, not lost (review M4). */
export const STILL_SAVING_QUESTION = 'Your changes are still saving. Leave anyway?';

export const cardGoneMessage = (n: number) =>
  `${n} unsaved ${n === 1 ? 'change was' : 'changes were'} dropped because that card isn't shown any more.`;

/** Where a person's drafts for a card are kept (sessionStorage, under the drafts prefix). */
export const draftsKey = (userId: number, cardId: number) => `spend:${userId}:${cardId}`;

/** Before "Discard changes" throws away more than one. */
export const discardChangesQuestion = (n: number) => `Discard ${changes(n)}?`;

/** The status line after a save: how many changes, and how many saved transactions the filter now hides. */
export function savedMessage(saved: number, gone: number): string {
  const hidden =
    gone === 0 ? '' : gone === 1 ? " 1 transaction no longer matches the filter, so it's hidden." : ` ${gone} transactions no longer match the filter, so they're hidden.`;
  return `Saved ${changes(saved)}.${hidden}`;
}

export const removedMessage = (n: number) =>
  n === 1 ? '1 change was for a transaction that no longer exists and was removed.' : `${n} changes were for transactions that no longer exist and were removed.`;

export const movedMessage = (n: number) =>
  n === 1
    ? '1 change was for a transaction a bank sync replaced, so it was moved to the new one.'
    : `${n} changes were for transactions a bank sync replaced, so they were moved to the new ones.`;

export const matchedMessage = (n: number) =>
  n === 1 ? "1 unsaved change now matches what's saved, so it was cleared." : `${n} unsaved changes now match what's saved, so they were cleared.`;

export const conflictNote = (name: string) => `Someone else changed this to ${name}. Your pick isn't saved yet.`;

export const tooManyLine = (rows: number) =>
  `One save can take changes on up to ${TRANSACTION_BATCH_MAX} transactions. You have changes on ${rows}, so undo the changes on at least ${rows - TRANSACTION_BATCH_MAX} of them first.`;

/**
 * Whether a navigation keeps the drill-down's drafts: it stays on the same card's overview (another
 * cycle, filter, or search). Another card, Spend settings, or another page drops them, so it asks
 * first. No card in the address, or one that isn't shown, is the server's default, `defaultCardId`:
 * that's the card the server falls back to (review M3).
 */
export function keepsDrafts(
  next: { pathname: string; search: Record<string, unknown> },
  cardId: number,
  defaultCardId: number | null,
  shownCardIds: readonly number[],
): boolean {
  if (next.pathname.replace(/\/+$/, '') !== '/spend') return false;
  const view = spendViewFromSearch(next.search);
  const card = view.card !== null && shownCardIds.includes(view.card) ? view.card : defaultCardId;
  return view.tab === 'overview' && card === cardId;
}
