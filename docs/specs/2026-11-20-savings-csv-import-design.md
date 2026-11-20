# Savings CSV import and hand-added accounts: design

Status: approved 2026-11-20. Extends the Savings panel (main spec §21). Where this and §21 disagree, this wins, and §21 is updated as part of the work.

## Why

Plaid gives no past balances and may not support everything the family needs from Fidelity. Fidelity's "History for Account" CSV export fills the gap: the cash management account's file carries a running balance on every row, so it can rebuild the account's balance history and money in and out; the brokerage file gives the real money in and out. Hand-added accounts let Savings work even if the Plaid link doesn't.

## Accounts

- An account is either **linked** (from a Plaid pick, as today) or **added by hand**: a nickname and a kind, `cash` or `investment`, with no Plaid link.
- Admins add hand accounts in Savings settings with **Add an account by hand**. They can be renamed, hidden, and removed (with or without their data) like linked accounts.
- **Set balance** (admins, hand-added investment accounts, and any account without a Plaid balance for that day): an amount as of today or a chosen date. Stored as that day's balance with source `manual`. A Plaid balance for the same day replaces it; a manual balance never replaces a Plaid one.

## Importing

- Every account in Savings settings has **Import a CSV** (admins).
- Steps: upload; **map columns** and **say what rows mean** (skipped when a saved or built-in mapping matches and every group is already decided; see "Reading any bank's CSV"); a **results preview**; then **Import**. Like Spend's CSV import (main spec §12.13), the server reads the file and keeps the draft for an hour under a random id bound to the admin, and nothing from the file is logged. The draft holds every column of the file's table, so the admin can map the columns and change them. It's deleted at Import, Cancel, a new upload, or expiry, with `secure_delete` on so its cells are zeroed, and each 15-minute prune checkpoints the WAL (`TRUNCATE`). Backups are scrubbed of drafts before they count. What's left (up to 15 minutes in the WAL after a delete, cells freed before `secure_delete` was turned on, and anything below SQLite) is listed in the generic card import design, "Not stored".
- The results preview shows the date range, how many deposits, withdrawals, and daily balances it will add, how many are already there (skipped), and each description group with its count and what it counts as (for example "YOU SOLD … (12): not counted"), with a way back to change the choices.
- Each saved import is recorded: account, file name, a SHA-256 of the file, who, when, and counts. Never the file. An import can be undone, which deletes exactly the flows and balances it added.

## Reading any bank's CSV

The importer is general: it maps columns rather than assuming one bank's layout. Fidelity's two "History for Account" layouts are built-in formats on top of it.

**Finding the table.** The server finds the table in the file without help:
- It skips preamble lines and takes as the header the first row that looks like column names, where the rows that follow have the same number of fields.
- Blank lines and blank rows are skipped. The table ends after the last row with the header's field count; what follows (disclaimers, "Date downloaded …") is a footer and ignored.
- A line between the header and that last row that doesn't fit is a bad row, and the file is refused with its line number (never its contents). Spend's importer, which shares this table finder, lists such rows instead.
- It handles quoted fields, a UTF-8 byte-order mark, and CRLF or LF line endings.
- A file with no recognizable table is refused with a plain message (and a line number, never the line's contents).

**Sample.** The admin sees the column names and the first 8 rows.

**Mapping columns** (admin picks a column for each role):
- **Date** (required). The date format is detected from the values: `YYYY-MM-DD`, `M/D/YYYY`, `D/M/YYYY`, with or without zero padding. When the values are ambiguous (every day 12 or under), the admin chooses.
- **Amount**: either one signed column, with a "money in is negative" switch for banks that flip the sign, or separate **Debit** and **Credit** columns (both positive). Numbers may be quoted, have a currency sign, thousands separators, or parentheses for negatives; empty means none.
- **Running balance** (optional). For a cash account it becomes daily balances. For an investment account the admin says whether it's the account's whole value; by default it isn't, and it's ignored.
- **Description** (optional, recommended): used to tell real deposits and withdrawals from interest, trades, and dividends.
- A balance cell that isn't a number (e.g. Fidelity's `Processing`) means that row has no balance.

**What rows mean.** Rows are grouped by a short label from the description: its first two words, uppercased, with digits and punctuation dropped ("DIRECT DEPOSIT", "YOU SOLD", "INTEREST EARNED"). Rows with no description form one group. For each group the admin chooses: **Deposit**, **Withdrawal**, **By sign** (money in is a deposit, money out a withdrawal), or **Not counted** (it lands in Other change or Market change). Defaults:
- Cash account: By sign, except groups whose label contains INTEREST, which are Not counted.
- Investment account: Not counted, except groups that look like money moving in or out (labels containing TRANSFER, DEPOSIT, WITHDRAWAL, CHECK, ACH, EFT, CONTRIBUTION, or DISTRIBUTION), which default to By sign.
- A zero amount is never a flow.

**Daily balances.** For each date, the balance of the newest row that day (by the file's order when rows share a date; the file's overall order, newest-first or oldest-first, is detected from the dates) is that day's end balance.

**Saved per account.** The mapping (column names, date format, sign setting, balance meaning) and the group choices are saved on the account. The next import whose header matches skips straight to the results preview; groups not seen before are always shown for a decision first. Admins can edit or clear the saved choices.

**Built-in formats.** A built-in format is a mapping plus group rules recognized by exact column names. Fidelity's two layouts are built in:
- Cash management: header `Run Date, Action, Symbol, Description, Type, Price ($), Quantity, Commission ($), Fees ($), Accrued Interest ($), Amount ($), Cash Balance ($), Settlement Date`; Date = Run Date (M/D/YYYY), Amount = Amount ($), balance = Cash Balance ($) (the account's value), description = Action; INTEREST EARNED is Not counted, everything else By sign.
- Brokerage: header `Run Date, Action, Symbol, Description, Type, Exchange Quantity, Exchange Currency, Currency, Price, Quantity, Exchange Rate, Commission, Fees, Accrued Interest, Amount, Cash Balance, Settlement Date`; Date = Run Date, Amount = Amount, balance = Cash Balance but not the account's value (ignored), description = Action; TRANSFERRED FROM, DIRECT DEPOSIT, CHECK RECEIVED, ELECTRONIC FUNDS are By sign; TRANSFERRED TO and DIRECT DEBIT are By sign; everything else Not counted.
A built-in format fills in steps that an admin can still change before importing.

**Stored.** Only date, amount in cents, and deposit or withdrawal for a flow. The saved mapping stores column names, the date format, the sign setting, and group labels (short, first words only) with their choices. Never full descriptions, symbols, or the file.

## Overlap rules

- **Re-importing:** each CSV flow has a key built from the account, date, amount, direction, the row's full description text (hashed, never stored), and its position among identical rows that day (so two identical $27.60 gym charges the same day stay two). The key is a hash; the action text itself isn't stored. A flow whose key exists is skipped.
- **CSV vs Plaid flows:** a CSV flow is skipped when a Plaid flow on the same account has the same direction and amount within 3 days and isn't already matched (one to one, nearest date). When Plaid later reports a flow matching an imported one the same way, Plaid's copy replaces it.
- **Balances:** imported balances are written only for days before the account's first Plaid balance. A Plaid balance always wins for its day; an imported balance never replaces a Plaid or manual one.

## Interest from Plaid

To match, the Plaid sync stops counting interest on a cash account as a deposit, so it lands in Other change the same way. Plaid's documentation doesn't confirm its category name for interest earned (research note §10), so a cash transaction counts as interest when its personal finance category's detailed value starts with `INCOME_INTEREST`, or its name starts with `INTEREST EARNED` or `INTEREST PAID` (case-insensitive). The name is read at sync time only and never stored.

## Data changes

- `savings_accounts.plaid_item_id` and `plaid_account_id` become nullable, plus a `source` column (`plaid` or `manual`). SQLite needs a table rebuild for this, so the migration guard gets a reviewed exception pinned to that one migration, as for 0009; the rebuild keeps the AUTOINCREMENT counter (sqlite_sequence).
- `savings_balances` gains `source` (`plaid`, `csv`, `manual`) and an optional `import_id`.
- `savings_flows` gains `import_id` and accepts source `csv` with the hash key.
- New tables `savings_imports` (import records) and `savings_import_profiles` (the saved mapping and group choices per account).

## Graph and numbers

No change to how they're computed. The cash account's imported history fills the graph back to its first imported day; the brokerage's line joins from its first balance (Plaid or manual), shown with the existing join marker and sentence.

## Testing

- Unit: table finding on varied files (preamble, footer, BOM, CRLF, quoted fields, Debit/Credit columns, flipped signs, each date format and the ambiguous case), the Fidelity built-in formats (from fixtures modeled on the real exports with made-up numbers), blank and disclaimer lines, quoted negatives, `Processing`, refusal of bad files; classification for each kind; end-of-day balance; the occurrence key; overlap with Plaid flows both ways; balance precedence.
- Service: preview, import, re-import, undo, hand-added account and Set balance, permissions.
- e2e: add an account by hand, import a cash file, see past months and the graph filled; import a brokerage file onto an investment account; undo.
- Fixture files use invented amounts and account numbers. Never commit the real exports.
