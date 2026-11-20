# Generic credit card CSV import: design

Status: approved 2026-11-20. Changes Spend's CSV import (main spec §12.13), which today reads only Bank of America's credit card export. Where this and §12.13 disagree, this wins, and §12.13 is updated as part of the work.

## Why

Card issuers export activity in different layouts and sign conventions. Spend should import any of them, the way the Savings importer (main spec §21.8) maps any bank's columns. Bank of America's layout stays as a built-in format so those files keep working with no extra steps.

## Steps

1. **Upload.** An admin picks the card and a file. The server finds the table with the same rules as the Savings importer (main spec §21.8: preamble skipped, header found by field-count consistency, blank lines skipped, the table ends after the last row with the header's field count, quoted fields, BOM, CRLF or LF, strict UTF-8). A line between the header and that last row that doesn't fit is a bad row: Spend lists it as unreadable by line number and reason, never its contents, and imports the rest (Savings refuses the file by that line). Spend also takes a header whose first row doesn't fit when a later row does. Lines after the last fitting row are a footer: for an issuer's own columns they're skipped and the preview says how many; Bank of America's files have no footer, so there they're listed as unreadable rows, as before. Limits as today: 5 MB, 20,000 rows, 200 columns.
2. **Map columns** (skipped when a saved or built-in mapping applies; see below). The admin sees the column names and the first 8 rows and picks:
   - **Date** (required). Format detected from the values (`YYYY-MM-DD`, `M/D/YYYY`, `D/M/YYYY`); when every day is 12 or under, the admin chooses. Rows whose date cell is empty are skipped and counted ("not posted yet").
   - **Amount**: either one signed column, with a **"purchases are negative in this file"** switch (Bank of America: on), or separate **Charges** and **Payments and credits** columns (read as positive whatever sign the issuer wrote). Money parsing as the Savings importer: currency signs, thousands separators, parentheses; decimal commas refused.
   - **Description / payee** (required). It's the transaction's raw name, used by rules, the duplicate test, and display, as the CSV Payee is today.
   - **Reference number** (optional). The issuer's own id for the row.
   - **Address / location** (optional), stored where the CSV Address is stored today.
3. **Preview, Import, Undo**: exactly as today (main spec §12.13): counts, the date range, "Already imported", "Possible duplicate (different reference number)", "Looks like one already here" (Plaid twins), unreadable rows with why, ticking rows, rules applied on import, Import, Undo with its refusals. There is no groups step: every row is a transaction, and rules and categories file it.

## Re-importing without a reference number

- With a reference column, rows whose reference is already stored for the card are skipped, as today.
- Without one, each row gets a key: a SHA-256 of the card id, date, amount in cents, the whitespace-collapsed description, and the row's position among identical rows that day in file order (so two identical $5 coffees on one day stay two). It's stored in `csv_reference` with a versioned prefix (for example `k1:`) that a real reference can't have, so the existing unique index and "Already imported" logic work unchanged. Undo, Plaid replacement, and Remove duplicate treat these rows like any CSV row.
- The duplicate test's "the bank hasn't said they differ" clause applies only to real references; key-only rows behave like rows without a reference number for that clause.

## Saved per card

- The mapping (column names, date format, sign setting or debit/credit columns, which columns are reference, description, address) is saved on the card when an import is committed. The next file whose header matches exactly goes straight to the preview. Admins can view and clear it in the card's Imports area.
- **Built-in formats** are recognized by exact header. Bank of America's credit card export (`Posted Date, Reference Number, Payee, Address, Amount`; purchases negative; `TEMPRET` references skipped as not posted) is built in and behaves as today. Bank of America's checking and savings export is no longer refused by name; it maps like any file (a hint can still say checking and savings belong in Savings).
- The precedence is: a saved mapping whose header matches and that reads the file, then a built-in format, then a guess the admin confirms. Saved columns that are exactly a built-in format's apply on the header alone, as that format does.
- When saved columns don't fit a file with a built-in format's header, the built-in format is used and the preview says so. Importing that draft keeps the card's saved columns instead of replacing them; they're replaced only if the admin chooses columns (**Change the columns**, then Preview), the built-in ones included.

## Shared code

The table finder and the column-mapping and money/date parsing used by the Savings importer move to one module both panels use. Its money and date parsing and its mapping don't change for Savings, but where the table ends does: blank lines are now skipped, and the table ends after the last row with the header's field count instead of at the first blank line. So a Savings export with more than one section of the same field count, which used to import its first section, is now read as one table, and the second section's header row is refused by its line number when its date doesn't read. Savings' tests pass with only their import paths changed; the table finder's own tests changed with the rule.

## Data changes

One additive migration: a `spend_import_profiles` table (one per card: header, mapping JSON, who, when), and a nullable `format` on `csv_imports` (`bofa_credit` or `custom`). Existing imports read as Bank of America.

## Not stored

As today, Spend stores each imported row's date, amount, payee/description, address when mapped, and reference (or key). The file itself, other columns, and anything from the file in logs are never stored with a transaction.

- **The draft.** Between upload and Import, the draft holds the file's table, every column of it, for up to an hour, bound to the admin who uploaded it. That's what lets them choose the columns and use **Change the columns**. It's deleted at Import, Cancel, a new upload, or expiry (the 15-minute prune, which also runs on each upload).
- **Deleted means gone from the database file.** The database runs with `secure_delete` on, so a deleted draft's cells are overwritten with zeros. Each prune also checkpoints the WAL with `TRUNCATE`, which empties the WAL file of older frames that still held them.
- **Backups don't keep drafts.** The nightly backup and the manual one before a deploy (`dist/server/db/backupNow.js`) delete every import draft, Spend's and Savings', from the copy and `VACUUM` it before it counts as a backup. A copy that can't be scrubbed is deleted, and the backup job fails with a message that has nothing from the database in it.
- **What's left, honestly.**
  - A draft can sit for up to an hour, plus up to 15 minutes until the next prune deletes it once it has expired.
  - After a delete, its cells can stay in the WAL file for up to 15 minutes, until the next prune's checkpoint. If something held the WAL open, that checkpoint would only partly finish and the next one would catch up.
  - `secure_delete` only covers deletes made after it's turned on. Cells freed before that release can stay in the database's free pages until a `VACUUM`, which this change doesn't run.
  - The nightly backup writes a full copy, drafts included, as `<name>.partial`, then scrubs it in place. A copy that fails the scrub is deleted, not overwritten.
  - Below SQLite (a journaling filesystem, an SSD's remapped blocks, snapshots or host backups of the data volume), old blocks can outlive all of this. The app can't reach those.
  - Backups taken before this change keep whatever drafts existed when they were made.

## Testing

- Unit: mapping for signed (both sign conventions) and debit/credit files, the key (stability across overlapping files, identical same-day rows), empty-date skipping, Bank of America built-in equivalence (every existing BofA import test still passes through the new path), profile apply/replace, ambiguous dates.
- Service and routes: preview with mapping steps, commit saving the profile, undo, permissions, size and rate limits as today.
- e2e: a non-BofA card CSV (e.g. `Transaction Date, Description, Category, Debit, Credit` with D/M/YYYY) through the steps; a BofA file straight to the preview as today; re-importing an overlapping key-only file adds only new rows.
- Fixtures use invented data.
