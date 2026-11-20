import { describe, expect, it } from 'vitest';
import { mostlyPossibleDuplicates, POSSIBLE_DUPLICATE, startsTicked, type PreviewRow } from './spend.js';

const row = (line: number, patch: Partial<PreviewRow> = {}): PreviewRow => ({
  line, status: 'new', date: '2026-11-02', reference: `R${line}`, payee: 'SHOP', address: null, amountCents: 100, reason: null, duplicateOf: null, ...patch,
});
const possible = (line: number) => row(line, { reason: POSSIBLE_DUPLICATE, duplicateOf: { id: line, date: '2026-11-02', merchant: 'SHOP', amountCents: 100 } });

describe('startsTicked', () => {
  it('ticks new rows, possible duplicates included, and leaves duplicates and blocked rows out', () => {
    const rows = [row(2), possible(3), row(4, { status: 'duplicate' }), row(5, { status: 'already_imported' }), row(6)];
    expect(mostlyPossibleDuplicates(rows)).toBe(false);
    expect(startsTicked(rows)).toEqual([2, 3, 6]);
  });

  it('leaves possible duplicates unticked when they are more than half of the new rows', () => {
    // Two of three new rows: the bank has likely renumbered what's already stored.
    const rows = [possible(2), possible(3), row(4), row(5, { status: 'duplicate' })];
    expect(mostlyPossibleDuplicates(rows)).toBe(true);
    expect(startsTicked(rows)).toEqual([4]);
    // Exactly half isn't more than half.
    expect(mostlyPossibleDuplicates([possible(2), row(3)])).toBe(false);
    expect(mostlyPossibleDuplicates([])).toBe(false);
  });
});
