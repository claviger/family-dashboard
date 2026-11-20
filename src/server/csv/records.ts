/**
 * A small, strict CSV parser (RFC 4180), written here rather than added as a dependency: the
 * importer needs only records and fields, and it needs one bad row to fail on its own, with its
 * line number, without taking the rest of the file with it. Shared by Spend's and Savings' importers
 * (`src/server/csv/`).
 *
 * - Records end at CRLF, LF, or a lone CR (BofA's line endings are unverified, research §1.2).
 *   Empty lines are skipped (nothing is made for them), but still counted for line numbers.
 * - A field is quoted when its first character (after spaces) is `"`. Inside quotes, `""` is a
 *   quote, and commas and line breaks are part of the value (a line break is kept as `\n`).
 * - Spaces and tabs before an opening quote or after a closing one are ignored. Other white space
 *   (a no-break space, say) before a quote makes it a stray quote. Nothing else may
 *   follow a closing quote, and a quote may not appear inside an unquoted value: either makes that
 *   record an error, and parsing goes on at the next line.
 * - A quote that's never closed makes its record an error, and parsing goes on at the line after
 *   the one where the quote opened, so the rest of the file isn't lost.
 * - With `multiline: false`, a quoted value may not hold a line break: a quote still open at the
 *   end of its line fails that record there. Bank exports have one record per line, and this keeps
 *   a file full of stray quotes linear (each unclosed quote would otherwise be read to the end).
 * - `csvRecords` yields one record at a time, so a reader can stop early; `parseCsv` collects them.
 * - Values are returned exactly as written (no trimming); the importer decides what to trim.
 */

export type CsvRecord =
  | { line: number; fields: string[]; error?: undefined }
  | { line: number; fields?: undefined; error: string };

export interface CsvOptions {
  /** Whether a quoted value may hold a line break (RFC 4180). Default true. */
  multiline?: boolean;
}

export const CSV_ERRORS = {
  unclosed: 'A quoted value is never closed.',
  unclosedLine: "A quoted value isn't closed on its line.",
  afterQuote: 'Something follows a closing quote.',
  strayQuote: 'A quote is in the middle of a value.',
} as const;

export function* csvRecords(text: string, opts: CsvOptions = {}): Generator<CsvRecord> {
  const multiline = opts.multiline ?? true;
  const n = text.length;
  let i = 0;
  let line = 1;

  /** Moves past the end of the current line, so the next record starts on the next one. */
  function skipLine(): void {
    while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
    if (text[i] === '\r' && text[i + 1] === '\n') i++;
    if (i < n) {
      i++;
      line++;
    }
  }

  while (i < n) {
    // An empty line: skip it without making a record.
    if (text[i] === '\n' || text[i] === '\r') {
      skipLine();
      continue;
    }
    const startLine = line;
    const fields: string[] = [];
    let error: string | undefined;
    let field = '';
    let state: 'start' | 'unquoted' | 'quoted' | 'closed' = 'start';
    let quoteAt = -1;
    let quoteLine = 0;

    for (;;) {
      if (i >= n) {
        if (state === 'quoted') {
          error = CSV_ERRORS.unclosed;
          // Start again on the line after the one where the quote opened.
          i = quoteAt;
          line = quoteLine;
          skipLine();
        } else {
          fields.push(field);
        }
        break;
      }
      const ch = text[i]!;

      if (state === 'quoted') {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            state = 'closed';
            i++;
          }
        } else if (ch === '\r' || ch === '\n') {
          if (!multiline) {
            error = CSV_ERRORS.unclosedLine;
            skipLine();
            break;
          }
          if (ch === '\r' && text[i + 1] === '\n') i++;
          i++;
          line++;
          field += '\n';
        } else {
          field += ch;
          i++;
        }
        continue;
      }

      if (ch === ',') {
        fields.push(field);
        field = '';
        state = 'start';
        i++;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        fields.push(field);
        skipLine();
        break;
      }
      if (state === 'closed') {
        if (ch === ' ' || ch === '\t') {
          i++;
          continue;
        }
        error = CSV_ERRORS.afterQuote;
        skipLine();
        break;
      }
      if (ch === '"') {
        if (state === 'start') {
          // Spaces and tabs before the opening quote don't count (they leave the state at 'start').
          state = 'quoted';
          field = '';
          quoteAt = i;
          quoteLine = line;
          i++;
          continue;
        }
        error = CSV_ERRORS.strayQuote;
        skipLine();
        break;
      }
      // A space at the start may still be followed by a quote; anything else makes it unquoted.
      if (!(state === 'start' && (ch === ' ' || ch === '\t'))) state = 'unquoted';
      field += ch;
      i++;
    }

    yield error === undefined ? { line: startLine, fields } : { line: startLine, error };
  }
}

export function parseCsv(text: string, opts: CsvOptions = {}): CsvRecord[] {
  return [...csvRecords(text, opts)];
}
