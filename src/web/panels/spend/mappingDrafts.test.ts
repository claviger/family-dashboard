import { describe, expect, it } from 'vitest';
import type { MappingView } from '../../../shared/plaid.js';
import {
  dropCodes, goneLine, keepsMappingDrafts, mappingChanges, markMappingConflicts, markMappingProblem, NO_MAPPING_DRAFTS, savedMappingsLine,
  setMappingDraft, settleMappingDrafts, shownMappingCodes, storedValue, fallbackOptionLabel, settleSentMappingDrafts, unknownMappingLine,
  serializeMappingDrafts, parseMappingDrafts, mappingDraftsKey,
} from './mappingDrafts.js';

// Plaid's own category codes; the categories are made up.
const cat = (id: number, name = `Category ${id}`) => ({ id, name, kind: 'normal' as const, archived: false });
function view(rows: [string, number][], unmapped: string[] = []): MappingView {
  return {
    rows: rows.map(([code, id]) => ({
      code, kind: code.split('_').length > 3 ? 'detailed' : 'primary', primary: null, taxonomyVersion: 'v2', category: cat(id), transactionCount: 0,
    })),
    unmapped: unmapped.map((code) => ({ code, kind: 'detailed', primary: null, taxonomyVersion: 'v2', transactionCount: 1, fallsBackTo: null })),
  };
}

describe('the mapping drafts (review G4-I3)', () => {
  it('knows what each code holds now: its own category, none (a code Plaid sent), or gone', () => {
    const v = view([['FOOD_AND_DRINK', 1]], ['TRANSPORTATION_GAS']);
    expect(storedValue(v, 'FOOD_AND_DRINK')).toBe(1);
    expect(storedValue(v, 'TRANSPORTATION_GAS')).toBeNull();
    expect(storedValue(v, 'NEVER_SENT')).toBeUndefined();
  });

  it('keeps a pick that differs from what is stored, and drops one that picks the stored value again', () => {
    let d = setMappingDraft(NO_MAPPING_DRAFTS, 'FOOD_AND_DRINK', 2, 1, 'Food and drink');
    expect(d.get('FOOD_AND_DRINK')).toEqual({ value: 2, base: 1, label: 'Food and drink' });
    expect(setMappingDraft(d, 'FOOD_AND_DRINK', 2, 1, 'Food and drink')).toBe(d);
    // Delete (back to the main category's) is a pick too.
    d = setMappingDraft(d, 'FOOD_AND_DRINK_COFFEE', null, 5, 'Food and drink: coffee');
    expect(d.get('FOOD_AND_DRINK_COFFEE')).toEqual({ value: null, base: 5, label: 'Food and drink: coffee' });
    d = setMappingDraft(d, 'FOOD_AND_DRINK', 1, 1, 'Food and drink');
    expect([...d.keys()]).toEqual(['FOOD_AND_DRINK_COFFEE']);
    expect(setMappingDraft(NO_MAPPING_DRAFTS, 'X', 1, 1, 'X')).toBe(NO_MAPPING_DRAFTS);
  });

  it('sends each draft with what the page last saw stored, or what someone else stored since', () => {
    let d = setMappingDraft(NO_MAPPING_DRAFTS, 'FOOD_AND_DRINK', 2, 1, 'a');
    d = setMappingDraft(d, 'TRANSPORTATION_GAS', 3, null, 'b');
    d = setMappingDraft(d, 'FOOD_AND_DRINK_COFFEE', null, 5, 'c');
    d = markMappingConflicts(d, [{ code: 'FOOD_AND_DRINK', current: 4 }]);
    expect(mappingChanges(d)).toEqual([
      { code: 'FOOD_AND_DRINK', categoryId: 2, expected: 4 },
      { code: 'TRANSPORTATION_GAS', categoryId: 3, expected: null },
      { code: 'FOOD_AND_DRINK_COFFEE', categoryId: null, expected: 5 },
    ]);
    // Picking again clears the flag: the new pick is made against what's stored now.
    expect(setMappingDraft(d, 'FOOD_AND_DRINK', 6, 4, 'a').get('FOOD_AND_DRINK')).toEqual({ value: 6, base: 4, label: 'a' });
  });

  it('settles against a fresh view: a draft that now matches goes, a code that is gone goes, and one changed by someone else is flagged', () => {
    let d = setMappingDraft(NO_MAPPING_DRAFTS, 'FOOD_AND_DRINK', 2, 1, 'a');
    d = setMappingDraft(d, 'TRAVEL_FLIGHTS_SYNTHETIC', 3, null, 'b');
    d = setMappingDraft(d, 'GONE_CODE_SYNTHETIC', 3, null, 'c');
    d = setMappingDraft(d, 'MEDICAL', 7, 1, 'd');
    const out = settleMappingDrafts(d, view([['FOOD_AND_DRINK', 2], ['MEDICAL', 9]], ['TRAVEL_FLIGHTS_SYNTHETIC']));
    expect(out.matched).toBe(1);
    expect(out.gone).toBe(1);
    expect([...out.drafts.keys()]).toEqual(['TRAVEL_FLIGHTS_SYNTHETIC', 'MEDICAL']);
    expect(out.drafts.get('MEDICAL')).toEqual({ value: 7, base: 1, label: 'd', changedTo: 9 });
    // Nothing new: the same map comes back.
    expect(settleMappingDrafts(out.drafts, view([['FOOD_AND_DRINK', 2], ['MEDICAL', 9]], ['TRAVEL_FLIGHTS_SYNTHETIC'])).drafts).toBe(out.drafts);
    // Changed back to what the page saw: no longer flagged.
    expect(settleMappingDrafts(out.drafts, view([['MEDICAL', 1]], ['TRAVEL_FLIGHTS_SYNTHETIC'])).drafts.get('MEDICAL')).toEqual({ value: 7, base: 1, label: 'd' });
  });

  it("after the person's own Save, a pick made while it was out is made against what was saved, not flagged", () => {
    const d = setMappingDraft(NO_MAPPING_DRAFTS, 'MEDICAL', 7, 1, 'd');
    const out = settleMappingDrafts(d, view([['MEDICAL', 3]]), true);
    expect(out.drafts.get('MEDICAL')).toEqual({ value: 7, base: 3, label: 'd' });
    expect(out.matched).toBe(0);
  });

  it('names a refused value beside its row until it is picked again, and drops codes the server says are gone', () => {
    let d = setMappingDraft(NO_MAPPING_DRAFTS, 'TRAVEL', 2, 1, 'Travel');
    d = setMappingDraft(d, 'MEDICAL', 2, 1, 'Medical');
    d = markMappingProblem(d, 'TRAVEL', 'That category is archived.');
    expect(d.get('TRAVEL')!.problem).toBe('That category is archived.');
    expect(setMappingDraft(d, 'TRAVEL', 3, 1, 'Travel').get('TRAVEL')!.problem).toBeUndefined();
    expect(dropCodes(d, ['MEDICAL', 'NOT_A_DRAFT'])).toEqual({ drafts: new Map([['TRAVEL', d.get('TRAVEL')]]), removed: 1 });
  });

  it('counts the codes shown: the unmapped list always, the folded list only while open', () => {
    const v = view([['FOOD_AND_DRINK', 1]], ['TRANSPORTATION_GAS']);
    expect([...shownMappingCodes(v, false)]).toEqual(['TRANSPORTATION_GAS']);
    expect([...shownMappingCodes(v, true)].sort()).toEqual(['FOOD_AND_DRINK', 'TRANSPORTATION_GAS']);
  });

  it('keeps its drafts on Spend settings, and asks before going anywhere else', () => {
    expect(keepsMappingDrafts({ pathname: '/spend', search: { tab: 'settings' } })).toBe(true);
    expect(keepsMappingDrafts({ pathname: '/spend/', search: { tab: 'settings', bank: 3 } })).toBe(true);
    expect(keepsMappingDrafts({ pathname: '/spend', search: {} })).toBe(false);
    expect(keepsMappingDrafts({ pathname: '/admin', search: {} })).toBe(false);
  });

  it('says what was saved, what went, and what Delete falls back to', () => {
    expect(savedMappingsLine(1)).toBe('Saved 1 change. It applies to new transactions.');
    expect(savedMappingsLine(3)).toBe('Saved 3 changes. They apply to new transactions.');
    expect(goneLine(1)).toBe("1 change was for a category code that isn't here anymore, so it was removed.");
    expect(goneLine(2)).toBe("2 changes were for category codes that aren't here anymore, so they were removed.");
    expect(fallbackOptionLabel('Food and drink', cat(1, 'Dining'))).toBe("Use Food and drink's category (Dining)");
    expect(fallbackOptionLabel(null, null)).toBe('No mapping of its own (Uncategorized)');
    for (const t of [savedMappingsLine(2), goneLine(2), fallbackOptionLabel('A', null)]) expect(t).not.toMatch(/—/);
  });
});

describe('a Save whose answer never came (review C-M5)', () => {
  const sent = (code: string, categoryId: number | null, expected: number | null) => ({ code, categoryId, expected });

  it('settles against what was sent: saved codes go, and a pick made since is kept against what was saved', () => {
    let d = setMappingDraft(NO_MAPPING_DRAFTS, 'FOOD_AND_DRINK', 2, 1, 'a');
    d = setMappingDraft(d, 'TRAVEL', 4, 3, 'b');
    const changes = mappingChanges(d);
    // Picked again while the Save was out.
    d = setMappingDraft(d, 'TRAVEL', 6, 3, 'b');
    const out = settleSentMappingDrafts(d, changes, view([['FOOD_AND_DRINK', 2], ['TRAVEL', 4]]));
    expect([...out.drafts]).toEqual([['TRAVEL', { value: 6, base: 4, label: 'b' }]]);
    expect(out).toMatchObject({ saved: 2, notSaved: 0, flagged: 0, remaining: 1 });
    expect(unknownMappingLine(out)).toBe("The server didn't answer in time. Your changes now show as saved, except 1 change made since, which isn't saved yet.");
  });

  it("flags a code someone else changed meanwhile, rather than taking it as this person's own save", () => {
    const d = setMappingDraft(setMappingDraft(NO_MAPPING_DRAFTS, 'FOOD_AND_DRINK', 2, 1, 'a'), 'TRAVEL', 4, 3, 'b');
    // Nothing went through; someone else set TRAVEL to 9.
    const out = settleSentMappingDrafts(d, mappingChanges(d), view([['FOOD_AND_DRINK', 1], ['TRAVEL', 9]]));
    expect(out.drafts.get('TRAVEL')).toEqual({ value: 4, base: 3, label: 'b', changedTo: 9 });
    expect(out.drafts.get('FOOD_AND_DRINK')).toEqual({ value: 2, base: 1, label: 'a' });
    expect(out).toMatchObject({ saved: 0, notSaved: 2, flagged: 1, remaining: 2 });
    expect(unknownMappingLine(out)).toBe("The server didn't answer in time, and your changes don't show as saved. Someone else changed 1 of them meanwhile. Check it, then save again.");
    const none = settleSentMappingDrafts(d, mappingChanges(d), view([['FOOD_AND_DRINK', 1], ['TRAVEL', 3]]));
    expect(unknownMappingLine(none)).toBe("The server didn't answer in time, and your changes don't show as saved. Save again.");
  });

  it('drops codes that are gone, and says all saved when nothing remains', () => {
    const d = setMappingDraft(setMappingDraft(NO_MAPPING_DRAFTS, 'FOOD_AND_DRINK', 2, 1, 'a'), 'GONE_CODE', 4, 3, 'b');
    const out = settleSentMappingDrafts(d, [sent('FOOD_AND_DRINK', 2, 1), sent('GONE_CODE', 4, 3)], view([['FOOD_AND_DRINK', 2]]));
    expect(out.drafts.size).toBe(0);
    expect(out).toMatchObject({ saved: 1, gone: 1, remaining: 0 });
    expect(unknownMappingLine(out)).toBe("The server didn't answer in time. Your changes now show as saved.");
  });
});

describe('mapping drafts kept across a reload (review C-M7)', () => {
  it('round-trips through storage, flags included, and reads anything broken as none', () => {
    let d = setMappingDraft(NO_MAPPING_DRAFTS, 'FOOD_AND_DRINK', 2, 1, 'Food and drink');
    d = setMappingDraft(d, 'FOOD_AND_DRINK_COFFEE', null, 5, 'Food and drink: coffee');
    d = markMappingConflicts(d, [{ code: 'FOOD_AND_DRINK', current: 7 }]);
    expect(parseMappingDrafts(serializeMappingDrafts(d))).toEqual(d);
    for (const bad of [null, '', 'nope', '{"v":2,"codes":[]}', '{"v":1,"codes":[["X",{"value":"2","base":1,"label":"x"}]]}', '{"v":1,"codes":[[3,{"value":2,"base":1,"label":"x"}]]}']) {
      expect(parseMappingDrafts(bad).size, String(bad)).toBe(0);
    }
  });

  it('is kept per person under the drafts prefix', () => {
    expect(mappingDraftsKey(7)).toBe('spend-mappings:7');
  });
});
