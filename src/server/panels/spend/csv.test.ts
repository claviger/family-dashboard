import { describe, expect, it } from 'vitest';
import { CSV_ERRORS, csvRecords, parseCsv } from './csv.js';

const fields = (text: string) => parseCsv(text).map((r) => r.fields ?? r.error);

describe('parseCsv', () => {
  it('splits records and fields, with or without a final line break', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([
      { line: 1, fields: ['a', 'b', 'c'] },
      { line: 2, fields: ['1', '2', '3'] },
    ]);
    expect(fields('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('ends records at CRLF, LF, or a lone CR', () => {
    expect(fields('a\r\nb\nc\rd')).toEqual([['a'], ['b'], ['c'], ['d']]);
    expect(parseCsv('a\r\nb\rc').map((r) => r.line)).toEqual([1, 2, 3]);
  });

  it('keeps empty fields, including a trailing one, and skips empty lines, counting them', () => {
    expect(fields(',a,,\n\nb')).toEqual([['', 'a', '', ''], ['b']]);
    expect(parseCsv('\r\n\r\na\n\n\nb\r\r').map((r) => r.line)).toEqual([3, 6]);
    expect(parseCsv('\n'.repeat(1000))).toEqual([]);
  });

  it('reads quoted fields with commas, doubled quotes, and line breaks', () => {
    expect(fields('"a,b","say ""hi""",""\n')).toEqual([['a,b', 'say "hi"', '']]);
    expect(parseCsv('"one\r\ntwo",x\nnext')).toEqual([
      { line: 1, fields: ['one\ntwo', 'x'] },
      { line: 3, fields: ['next'] },
    ]);
  });

  it('keeps the padding BofA writes, inside quotes and in unquoted values', () => {
    // The 2012 sample's shape (research §1.2): quoted, space-padded Payee and Address; a left-padded Amount.
    expect(fields('10/23/2012,24692162298100012345678,"COFFEE SHOP           ","SEATTLE WA     ",    -12.74')).toEqual([
      ['10/23/2012', '24692162298100012345678', 'COFFEE SHOP           ', 'SEATTLE WA     ', '    -12.74'],
    ]);
  });

  it('ignores spaces and tabs around quotes', () => {
    expect(fields('  "a" , \t"b"\t\n')).toEqual([['a', 'b']]);
  });

  it('counts only spaces and tabs before a quote as padding: other white space makes the quote stray', () => {
    for (const pad of [' ', '\f', '\v', ' ', '  ', '  ']) {
      expect(parseCsv(`ok,${pad}"x"\nnext`), JSON.stringify(pad)).toEqual([
        { line: 1, error: CSV_ERRORS.strayQuote },
        { line: 2, fields: ['next'] },
      ]);
    }
  });

  it('fails only the record with a stray quote or text after a closing quote, and goes on at the next line', () => {
    expect(parseCsv('ok,1\nab"c,2\n"x"y,3\nok,4')).toEqual([
      { line: 1, fields: ['ok', '1'] },
      { line: 2, error: CSV_ERRORS.strayQuote },
      { line: 3, error: CSV_ERRORS.afterQuote },
      { line: 4, fields: ['ok', '4'] },
    ]);
  });

  it("fails a quote that's never closed, and goes on at the line after it opened", () => {
    expect(parseCsv('ok,1\n"never closed,2\nok,3\nok,4\n')).toEqual([
      { line: 1, fields: ['ok', '1'] },
      { line: 2, error: CSV_ERRORS.unclosed },
      { line: 3, fields: ['ok', '3'] },
      { line: 4, fields: ['ok', '4'] },
    ]);
    expect(parseCsv('"only')).toEqual([{ line: 1, error: CSV_ERRORS.unclosed }]);
  });

  it('counts line numbers across quoted line breaks', () => {
    expect(parseCsv('"a\nb\nc",1\nbad"\nz').map((r) => [r.line, r.error ?? r.fields])).toEqual([
      [1, ['a\nb\nc', '1']],
      [4, CSV_ERRORS.strayQuote],
      [5, ['z']],
    ]);
  });

  it('without multiline, fails a quote still open at the end of its line there, and goes on', () => {
    expect(parseCsv('"one\ntwo",x\nok,1', { multiline: false })).toEqual([
      { line: 1, error: CSV_ERRORS.unclosedLine },
      { line: 2, error: CSV_ERRORS.strayQuote },
      { line: 3, fields: ['ok', '1'] },
    ]);
    expect(parseCsv('"a"",b\n"c",d', { multiline: false })).toEqual([
      { line: 1, error: CSV_ERRORS.unclosedLine },
      { line: 2, fields: ['c', 'd'] },
    ]);
  });

  it('reads records one at a time, so a reader can stop early', () => {
    const records = csvRecords('a\nb\nc');
    expect(records.next().value).toEqual({ line: 1, fields: ['a'] });
    expect(records.next().value).toEqual({ line: 2, fields: ['b'] });
  });

  it('stays linear on a file of stray quotes when multiline is off', () => {
    const text = '"x\n'.repeat(100_000);
    const started = performance.now();
    expect(parseCsv(text, { multiline: false })).toHaveLength(100_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
  });
});
