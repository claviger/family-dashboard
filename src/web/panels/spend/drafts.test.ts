import { describe, expect, it } from 'vitest';
import type { SpendTransaction } from '../../../shared/spend.js';
import {
  cardGoneMessage, clearSent, conflictNote, discardChangesQuestion, discardQuestion, draftChanges, draftCount, draftValue, dropIds, fieldDraft, hiddenCount, isEdited,
  keepsDrafts, markConflicts, matchedMessage, movedMessage, NO_DRAFTS, parseDrafts, pruneMissing, removedMessage, saveLabel, savedMessage, serializeDrafts, setDraft,
  settleDrafts, settleMissing, tooManyLine, unsavedLine, type Drafts,
} from './drafts.js';

const cat = (id: number) => ({ id, name: `C${id}`, kind: 'normal' as const, archived: false });
const kid = { id: 7, displayName: 'K', color: '#000', active: true };
const t: SpendTransaction = {
  id: 9, cardId: 1, source: 'csv', date: '2026-11-01', merchant: 'M', rawName: 'M', amountCents: 100, currency: 'USD', pending: false,
  category: cat(3), categorySource: 'manual', person: null, personSource: 'default', note: null, twinIds: [],
};
const u: SpendTransaction = { ...t, id: 10, category: cat(4), person: kid, personSource: 'rule' };
const at = { cycle: '2026-10-27', label: 'M, Nov 1, 2026, $1.00' };
const pick = (d: Drafts, row: SpendTransaction, field: 'category' | 'person', value: string, where = at) => setDraft(d, row, field, value, where);

describe('setDraft', () => {
  it('keeps a pick that differs from the saved value, with the saved value it was made against', () => {
    const d = pick(NO_DRAFTS, t, 'category', '5');
    expect([...d]).toEqual([[9, { cycle: '2026-10-27', label: at.label, category: { value: '5', base: '3' } }]]);
    expect(draftValue(d, t, 'category')).toBe('5');
    expect(draftValue(d, t, 'person')).toBe('');
    expect(isEdited(d, 9, 'category')).toBe(true);
    expect(isEdited(d, 9, 'person')).toBe(false);
  });

  it("clears a field's draft when the saved value is picked again, and the row once nothing is left", () => {
    const both = pick(pick(NO_DRAFTS, t, 'category', '5'), t, 'person', '7');
    const personOnly = pick(both, t, 'category', '3');
    expect(fieldDraft(personOnly, 9, 'category')).toBeUndefined();
    expect(fieldDraft(personOnly, 9, 'person')).toEqual({ value: '7', base: '' });
    expect(pick(personOnly, t, 'person', '')).toEqual(new Map());
  });

  it('compares Household as the empty value', () => {
    expect(pick(NO_DRAFTS, t, 'person', '')).toBe(NO_DRAFTS);
    expect(fieldDraft(pick(NO_DRAFTS, u, 'person', ''), 10, 'person')).toEqual({ value: '', base: '7' });
  });

  it('gives the same map back when nothing changes', () => {
    const d = pick(NO_DRAFTS, t, 'category', '5');
    expect(pick(d, t, 'category', '5')).toBe(d);
    expect(pick(d, u, 'category', '4')).toBe(d);
  });

  it("picking again on a flagged field starts over from what's saved now", () => {
    const flagged = settleDrafts(pick(NO_DRAFTS, t, 'category', '5'), [{ ...t, category: cat(6) }]);
    expect(fieldDraft(flagged, 9, 'category')).toEqual({ value: '5', base: '3', changedTo: '6' });
    expect(fieldDraft(pick(flagged, { ...t, category: cat(6) }, 'category', '8'), 9, 'category')).toEqual({ value: '8', base: '6' });
  });
});

describe('draftCount and hiddenCount', () => {
  it('counts edited fields, not rows, and those on rows not shown', () => {
    let d: Drafts = NO_DRAFTS;
    expect(draftCount(d)).toBe(0);
    d = pick(d, t, 'category', '5');
    d = pick(d, t, 'person', '7');
    d = pick(d, u, 'category', '5');
    expect(draftCount(d)).toBe(3);
    // Arrowing on through the options doesn't add to the count.
    d = pick(d, u, 'category', '6');
    expect(draftCount(d)).toBe(3);
    expect(hiddenCount(d, new Set([10]))).toBe(2);
    expect(hiddenCount(d, new Set([9, 10]))).toBe(0);
  });
});

describe('clearSent (Remove rule, which resets fields to automatic)', () => {
  it('clears only the fields reset, and only while each still holds what it did when the reset was sent', () => {
    const d = pick(pick(pick(NO_DRAFTS, t, 'category', '5'), t, 'person', '7'), u, 'category', '5');
    const sent = d.get(9);
    expect(fieldDraft(clearSent(d, 9, ['category'], sent), 9, 'category')).toBeUndefined();
    expect(fieldDraft(clearSent(d, 9, ['category'], sent), 9, 'person')).toEqual({ value: '7', base: '' });
    expect(clearSent(d, 9, ['category', 'person'], sent).has(9)).toBe(false);
    expect(clearSent(d, 9, ['category', 'person'], sent).has(10)).toBe(true);
    // A pick made while the reset was out is newer than the reset, so it stays.
    const newer = pick(d, t, 'category', '6');
    expect(fieldDraft(clearSent(newer, 9, ['category'], sent), 9, 'category')?.value).toBe('6');
    // Nothing was drafted when it was sent: nothing to clear.
    expect(clearSent(d, 9, ['category'], undefined)).toBe(d);
  });
});

describe('settleDrafts', () => {
  it('drops each draft that now holds the saved value', () => {
    const d = pick(pick(pick(NO_DRAFTS, t, 'category', '5'), t, 'person', '7'), u, 'category', '5');
    const saved = [{ ...t, category: cat(5), person: kid }, { ...u, category: cat(5) }];
    expect(settleDrafts(d, saved)).toEqual(new Map());
  });

  it('keeps a draft picked while the save was out, since it differs from what was saved (review S3-M1)', () => {
    const d = pick(NO_DRAFTS, { ...t, category: cat(5) }, 'category', '6');
    expect(settleDrafts(d, [{ ...t, category: cat(5) }])).toBe(d);
  });

  it("after the person's own Save, a pick made while it was out is made against what they saved: not flagged", () => {
    // Picked 5, saved; picked 6 while the save was out.
    const d = pick(pick(NO_DRAFTS, t, 'category', '5'), t, 'category', '6');
    const after = settleDrafts(d, [{ ...t, category: cat(5) }], true);
    expect(fieldDraft(after, 9, 'category')).toEqual({ value: '6', base: '5' });
    // Fresh rows later agree with that base: still not flagged.
    expect(settleDrafts(after, [{ ...t, category: cat(5) }])).toBe(after);
  });

  it("flags a field someone else changed to a third value, and unflags it if it's changed back", () => {
    const d = pick(NO_DRAFTS, t, 'category', '5');
    const flagged = settleDrafts(d, [{ ...t, category: cat(6) }]);
    expect(fieldDraft(flagged, 9, 'category')).toEqual({ value: '5', base: '3', changedTo: '6' });
    expect(settleDrafts(flagged, [{ ...t, category: cat(6) }])).toBe(flagged);
    expect(fieldDraft(settleDrafts(flagged, [t]), 9, 'category')).toEqual({ value: '5', base: '3' });
  });

  it("leaves rows that aren't in the list, and gives the same map back when nothing changes", () => {
    const d = pick(NO_DRAFTS, t, 'category', '5');
    expect(settleDrafts(d, [u])).toBe(d);
    expect(settleDrafts(d, [t])).toBe(d);
  });
});

describe('rows that no longer exist', () => {
  it('pruneMissing drops drafts made in that cycle whose row is gone from it', () => {
    const d = pick(pick(NO_DRAFTS, t, 'category', '5'), u, 'category', '5', { cycle: '2026-09-27', label: 'U' });
    // A fresh fetch of October's cycle without t: t goes; u was picked in September's, so it stays.
    expect([...pruneMissing(d, '2026-10-27', [{ ...u }]).keys()]).toEqual([10]);
    expect(pruneMissing(d, '2026-10-27', [t])).toBe(d);
  });

  it('dropIds drops the rows the server says are gone', () => {
    const d = pick(pick(NO_DRAFTS, t, 'category', '5'), u, 'category', '5');
    expect([...dropIds(d, [9, 99]).keys()]).toEqual([10]);
    expect(dropIds(d, [99])).toBe(d);
  });
});

describe('settleMissing', () => {
  // t (9) is a CSV row a bank sync replaced with row 50; u (10) is gone for good.
  const w: SpendTransaction = { ...t, id: 50, source: 'plaid', category: cat(6) };

  it("moves a replaced row's drafts to the row that took its place, keeping what they expect, and drops the rest", () => {
    const d = pick(pick(pick(NO_DRAFTS, t, 'category', '5'), t, 'person', '7'), u, 'category', '5');
    const out = settleMissing(d, [9, 10], { 9: 50 });
    expect([...out.drafts]).toEqual([[50, { cycle: null, label: at.label, category: { value: '5', base: '3' }, person: { value: '7', base: '' } }]]);
    expect(out).toMatchObject({ moved: 2, removed: 1, first: { id: 50, field: 'category' } });
    // The next Save still expects what the old row held, so the server's 409 decides if row 50 holds something else.
    expect(draftChanges(out.drafts)).toEqual([{ id: 50, categoryId: 5, personUserId: 7, expected: { categoryId: 3, personUserId: null } }]);
  });

  it('keeps a flag someone else made, and a pick made on the new row itself', () => {
    const flagged = markConflicts(pick(pick(NO_DRAFTS, t, 'category', '5'), t, 'person', '7'), [{ transactionId: 9, field: 'category', current: 8 }]);
    const d = pick(flagged, w, 'category', '4', { cycle: '2026-10-27', label: 'W' });
    const out = settleMissing(d, [9], { 9: 50 });
    expect(out.drafts.get(50)).toEqual({ cycle: null, label: 'W', category: { value: '4', base: '6' }, person: { value: '7', base: '' } });
    expect(out).toMatchObject({ moved: 1, removed: 1, first: { id: 50, field: 'person' } });
    const kept = settleMissing(flagged, [9], { 9: 50 }).drafts.get(50);
    expect(kept?.category).toEqual({ value: '5', base: '3', changedTo: '8' });
  });

  it('drops a row whose replacement is unreadable, and changes nothing when no draft was for a missing row', () => {
    const d = pick(NO_DRAFTS, t, 'category', '5');
    for (const bad of [{ 9: '50' }, { 9: 0 }, { 9: 1.5 }, { 9: 9 }, {}, undefined]) {
      expect(settleMissing(d, [9], bad)).toEqual({ drafts: NO_DRAFTS, moved: 0, removed: 1, first: null });
    }
    expect(settleMissing(d, [99], { 99: 100 })).toEqual({ drafts: d, moved: 0, removed: 0, first: null });
  });

  it('says what moved', () => {
    expect(movedMessage(1)).toBe('1 change was for a transaction a bank sync replaced, so it was moved to the new one.');
    expect(movedMessage(3)).toBe('3 changes were for transactions a bank sync replaced, so they were moved to the new ones.');
  });
});

describe('markConflicts', () => {
  it("flags the fields the server says changed, with what's saved now", () => {
    const d = pick(pick(NO_DRAFTS, t, 'category', '5'), u, 'person', '');
    const marked = markConflicts(d, [{ transactionId: 9, field: 'category', current: 6 }, { transactionId: 10, field: 'person', current: null }]);
    expect(fieldDraft(marked, 9, 'category')?.changedTo).toBe('6');
    expect(fieldDraft(marked, 10, 'person')?.changedTo).toBe('');
  });
});

describe('draftChanges', () => {
  it("is one change per row, with Household as null, and what each field was last seen holding", () => {
    let d = pick(pick(NO_DRAFTS, t, 'category', '5'), t, 'person', '7');
    d = pick(d, u, 'person', '');
    d = markConflicts(d, [{ transactionId: 9, field: 'category', current: 6 }]);
    expect(draftChanges(d)).toEqual([
      // Flagged: the person has seen it's 6 now, so Save means "use mine anyway".
      { id: 9, categoryId: 5, personUserId: 7, expected: { categoryId: 6, personUserId: null } },
      { id: 10, personUserId: null, expected: { personUserId: 7 } },
    ]);
  });
});

describe('storage', () => {
  it('keeps ids and picks only, never merchant names, and reads back what it wrote', () => {
    const d = markConflicts(pick(pick(NO_DRAFTS, t, 'category', '5'), u, 'person', ''), [{ transactionId: 9, field: 'category', current: 6 }]);
    const text = serializeDrafts(d);
    expect(text).not.toContain(at.label);
    expect(text).not.toContain('"M"');
    const back = parseDrafts(text);
    expect(fieldDraft(back, 9, 'category')).toEqual({ value: '5', base: '3', changedTo: '6' });
    expect(fieldDraft(back, 10, 'person')).toEqual({ value: '', base: '7' });
    expect(back.get(9)?.label).toBeUndefined();
  });

  it('reads anything broken or foreign as no drafts', () => {
    for (const text of [null, '', 'nope', '{}', '[1]', JSON.stringify({ v: 1, rows: [[1, { cycle: 3 }]] }), JSON.stringify({ v: 1, rows: [['x', {}]] })]) {
      expect(parseDrafts(text).size).toBe(0);
    }
    // One bad field doesn't take the others with it.
    const mixed = JSON.stringify({ v: 1, rows: [[9, { cycle: null, category: { value: 5, base: '3' }, person: { value: '7', base: '' } }]] });
    expect([...parseDrafts(mixed)]).toEqual([[9, { cycle: null, person: { value: '7', base: '' } }]]);
  });
});

describe('copy', () => {
  it('says how many changes, in the singular for one, and how many of them are on rows not shown', () => {
    expect(saveLabel(1, 0)).toBe('Save 1 change');
    expect(saveLabel(3, 2)).toBe('Save 3 changes (2 not shown)');
    expect(unsavedLine(3)).toBe('3 unsaved changes.');
    expect(discardQuestion(1)).toBe('Discard 1 unsaved change?');
    expect(discardQuestion(2)).toBe('Discard 2 unsaved changes?');
    expect(discardChangesQuestion(3)).toBe('Discard 3 changes?');
  });

  it('says what was saved, and how many transactions the filter now hides', () => {
    expect(savedMessage(1, 0)).toBe('Saved 1 change.');
    expect(savedMessage(3, 1)).toBe("Saved 3 changes. 1 transaction no longer matches the filter, so it's hidden.");
    expect(savedMessage(4, 2)).toBe("Saved 4 changes. 2 transactions no longer match the filter, so they're hidden.");
  });

  it('says why drafts went without a pick', () => {
    expect(removedMessage(1)).toBe('1 change was for a transaction that no longer exists and was removed.');
    expect(removedMessage(2)).toBe('2 changes were for transactions that no longer exist and were removed.');
    expect(matchedMessage(1)).toBe("1 unsaved change now matches what's saved, so it was cleared.");
    expect(matchedMessage(2)).toBe("2 unsaved changes now match what's saved, so they were cleared.");
    expect(conflictNote('Dining')).toBe("Someone else changed this to Dining. Your pick isn't saved yet.");
    expect(cardGoneMessage(1)).toBe("1 unsaved change was dropped because that card isn't shown any more.");
    expect(cardGoneMessage(3)).toBe("3 unsaved changes were dropped because that card isn't shown any more.");
  });

  it('counts transactions, not changes, against the limit of one save', () => {
    expect(tooManyLine(612)).toBe('One save can take changes on up to 500 transactions. You have changes on 612, so undo the changes on at least 112 of them first.');
  });
});

describe('keepsDrafts', () => {
  const to = (search: Record<string, unknown>, pathname = '/spend') => ({ pathname, search });
  const shown = [1, 4, 5];

  it('keeps them for the same card: another cycle, a filter, or a search', () => {
    expect(keepsDrafts(to({ card: 4, cycle: '2026-10-11' }), 4, 4, shown)).toBe(true);
    expect(keepsDrafts(to({ card: 4, person: 'household', q: 'x', category: 2 }), 4, 1, shown)).toBe(true);
    // No card in the address is the default one.
    expect(keepsDrafts(to({ cycle: '2026-10-11' }), 1, 1, shown)).toBe(true);
  });

  it("treats a card that isn't shown as the default card, which the server falls back to (review M3)", () => {
    expect(keepsDrafts(to({ card: 99, q: 'x' }), 1, 1, shown)).toBe(true);
    expect(keepsDrafts(to({ card: 99 }), 4, 1, shown)).toBe(false);
  });

  it('drops them for another card, Spend settings, or another page', () => {
    expect(keepsDrafts(to({ card: 5 }), 4, 4, shown)).toBe(false);
    expect(keepsDrafts(to({}), 4, 1, shown)).toBe(false);
    expect(keepsDrafts(to({ card: 4, tab: 'settings' }), 4, 4, shown)).toBe(false);
    expect(keepsDrafts(to({ card: 4 }, '/'), 4, 4, shown)).toBe(false);
    expect(keepsDrafts(to({ card: 4 }, '/chores'), 4, 4, shown)).toBe(false);
  });
});
