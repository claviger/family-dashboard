import { z } from 'zod';

/**
 * What both CSV importers share (Savings, main spec §21.8; Spend, §12.13 and the generic import
 * design): how a file writes its dates, a column by its index in the header, how many rows the
 * columns step shows, and the upload limit. Each panel keeps its own amount schema: Savings' signs
 * are money in and out of an account, Spend's are money spent on a card.
 */

/** How a file writes its dates: `YYYY-MM-DD`, `M/D/YYYY`, `D/M/YYYY`, padded or not. */
export const CSV_DATE_FORMATS = ['ymd', 'mdy', 'dmy'] as const;
export type CsvDateFormat = (typeof CSV_DATE_FORMATS)[number];
export const CSV_DATE_FORMAT_LABELS: Record<CsvDateFormat, string> = { ymd: 'YYYY-MM-DD', mdy: 'M/D/YYYY', dmy: 'D/M/YYYY' };

/** A column, by its index in the header (the Savings plan's decision 3). */
export const CsvColumnSchema = z.number({ error: 'Choose a column.' }).int('Choose a column.').min(0, 'Choose a column.').max(199, 'Choose a column.');

/** The date column and how its dates are written. */
export const CsvDateColumnSchema = z.object({ column: CsvColumnSchema, format: z.enum(CSV_DATE_FORMATS, { error: 'Choose how the dates are written.' }) });

/** How many rows the columns step shows. */
export const CSV_SAMPLE_ROWS = 8;
/** The most a CSV upload may be, for either panel. */
export const CSV_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
