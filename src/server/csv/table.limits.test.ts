import { describe, expect, it, vi } from 'vitest';

// Counts the records the table finder takes from the reader, to show a huge file is refused
// without reading (or keeping) every record. A count, not a memory measurement.
const reads = vi.hoisted(() => ({ n: 0 }));
vi.mock('./records.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./records.js')>();
  return {
    ...actual,
    csvRecords: function* (...args: Parameters<typeof actual.csvRecords>) {
      for (const r of actual.csvRecords(...args)) {
        reads.n++;
        yield r;
      }
    },
  };
});

const { CSV_TABLE_MAX_ROWS, CSV_TABLE_MESSAGES, findCsvTable } = await import('./table.js');

describe('findCsvTable on a huge file', () => {
  // About 4 MB of tiny rows, 50 times the row limit: what a 5 MB upload can hold.
  const huge = `Date,Amount\n${'2026-11-01,1\n'.repeat(CSV_TABLE_MAX_ROWS * 50)}`;

  it.each([false, true])('refuses it as too many rows soon after the limit, without reading the rest (keepBadRows %s)', (keepBadRows) => {
    reads.n = 0;
    expect(findCsvTable(huge, { keepBadRows })).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.tooManyRows });
    expect(reads.n).toBeLessThanOrEqual(CSV_TABLE_MAX_ROWS + 2);
  });

  it('refuses a bad row before the limit by its line for Savings, as soon as a row after it fits', () => {
    reads.n = 0;
    const text = `Date,Amount\n2026-11-01,1\nshort\n${'2026-11-01,1\n'.repeat(CSV_TABLE_MAX_ROWS * 50)}`;
    expect(findCsvTable(text)).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.badLine(3) });
    expect(reads.n).toBeLessThanOrEqual(5);
  });

  it('reads a file at the limit in full, twice at most', () => {
    reads.n = 0;
    const text = `Date,Amount\n${'2026-11-01,1\n'.repeat(CSV_TABLE_MAX_ROWS)}Total\n`;
    const found = findCsvTable(text, { keepBadRows: true });
    expect(found).toMatchObject({ ok: true, bad: [], trailingSkipped: 1 });
    expect(found.ok && found.table.rows).toHaveLength(CSV_TABLE_MAX_ROWS);
    expect(reads.n).toBeLessThanOrEqual(2 * (CSV_TABLE_MAX_ROWS + 2));
  });
});
