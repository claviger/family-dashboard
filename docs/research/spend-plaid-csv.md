# Spend panel: BofA CSV and Plaid reference notes

Researched 2026-11-16, for spec §12 (Spend) and §19 items 1, 2 and 5.

**How I checked**

- Plaid: the official docs pages linked in each section, read with WebFetch. WebFetch runs pages through a summarizer, so short quotes below are as returned by it; anything that matters should be re-read on the page before code depends on it.
- Plaid taxonomy: I downloaded the two public CSVs Plaid links from its docs (`curl`, into my scratchpad, not the repo) and parsed them with Python, so the category lists in §2 are exact, not summarized.
- BofA CSV: Bank of America doesn't document the file format anywhere I could find. Everything about the file comes from open-source importers on GitHub (found with `gh search code`, read with `gh api`) and third-party help pages. I note for each one whether its author says it was read from a real export or is a synthetic fixture.
- Tags: **UNVERIFIED** means no source I found states it. **INFERRED** means I'm reasoning from sources, not quoting them. **JUDGMENT** marks my own calls in the category mapping.
- No accounts created, nothing sent anywhere except search queries (header strings, bank names).

---

## 1. Bank of America credit-card activity CSV

### 1.1 Header and columns

Exact first line, as every source has it:

```
Posted Date,Reference Number,Payee,Address,Amount
```

Five columns, in that order. The spec's guess (§12.13) is right.

| Source | Date | Real file or synthetic? | How it detects the file |
|---|---|---|---|
| christoomey/vim-kata-meetup, [`_csv_cleanup/before.txt`](https://github.com/christoomey/vim-kata-meetup/blob/45b040e27d41b119ec083ca538a3a8af2a845592/_csv_cleanup/before.txt) | committed 2012-11-12 | Looks like a real export (23-digit reference numbers, real merchants, fixed-width padding). Used as a vim exercise, not an importer. | n/a |
| brennonyork/budget-buddy, [`bin/budget-buddy`](https://github.com/brennonyork/budget-buddy/blob/f64dc5ab5248794f101cc704e3754b2882f1d3c3/bin/budget-buddy) | 2019-11-25 | Real-use script | First line must equal the header string exactly, **and** the file name must match `^.*[0-9]{4}_[0-9]{4}\.csv$` |
| mschilli/go-ynabler, [`bofacc.go`](https://github.com/mschilli/go-ynabler/blob/c82fcf57b53a26a5cbb4492c20b7cf76ed5055e2/bofacc.go) | 2024-03-05 | Real-use YNAB converter | First line contains the header string; skips line 1; reads column 0 (date), 2 (payee), 4 (amount); comment says BofA shows outflows as negative and reverses them |
| poindexter12/maxwells-wallet, [`bofa_cc.py`](https://github.com/poindexter12/maxwells-wallet/blob/c17edb92944106dedb5e8bf8bb06d819af493ad1/backend/app/parsers/formats/bofa_cc.py) | 2025-12 | Unclear | Any of the first 10 lines contains `Posted Date`, `Reference Number` and `Payee`. Date `%m/%d/%Y`, thousands separator `,`, negative = charge |
| openaccountant/wilson, [`bofa.ts`](https://github.com/openaccountant/wilson/blob/0d415497042bf09efce3a6cde512904d64923148/src/tools/import/parsers/bofa.ts) | 2026-03 | Fixtures are synthetic (sequential reference numbers) | Content contains `Posted Date` and `Reference Number` → card; else checking. Negative = charge |
| kevinmyo-code/legion, [`bofa_activity.py`](https://github.com/kevinmyo-code/legion/blob/50c8dc615800cc719762fc005d1eacf346ba9d3e/server/ingest/parsers/bofa_activity.py) | 2026-09-28 | Says it was checked against real card and checking exports (2026-08-06 and 2026-09-28). Most detailed source. | First line, stripped, must equal the header exactly; each row must have exactly 5 fields; strict CSV quoting; `%m/%d/%Y`; decodes `utf-8-sig` |
| averatec0773/yomi, [`guides/import-boa.md`](https://github.com/averatec0773/yomi/blob/26874bb27b826cb4a98c223c681ac5e3656b2475/guides/import-boa.md) and [`boa.ts`](https://github.com/averatec0773/yomi/blob/26874bb27b826cb4a98c223c681ac5e3656b2475/packages/importers/src/boa.ts) | 2026-10-01 | Says the sign convention was "inferred from real files, not documented by the bank" | First non-blank line, BOM stripped, matches `^Posted Date,Reference Number,Payee\b` |
| lewis-john-lloyd/household, [`boa_csv.py`](https://github.com/lewis-john-lloyd/household/blob/27e81518423068cfb98866cd2b192d848f4693c7/src/household/parsers/boa_csv.py) | 2026-10/11 | Real-use | First line, BOM stripped, split on commas with quotes stripped, must equal the 5-tuple exactly; refuses rows without a reference number and files with a repeated reference number |
| vniranjan/mint_person, [`bank_of_america.py`](https://github.com/vniranjan/mint_person/blob/8a058654d93c0282f00921ab7042fa9f5f495555/apps/worker/parsers/bank_of_america.py) | 2026 | Its docstring sample has "Bank of America credit card account" and "Account #" lines above the header. **No other source shows that preamble, and its sample looks made up.** I'd discount it. | Scans for any line containing `Posted Date` and `Payee` |

Not found: Firefly III's official [import-configurations](https://github.com/firefly-iii/import-configurations) repo has no Bank of America config (US has Chase, Citi, NC SECU, Payoneer, Veridian CU, Wells Fargo). I found no hledger rules file, GnuCash doc, Actual Budget doc, or beancount importer for the BofA card CSV. [beancount.io's converter page](https://beancount.io/tools/csv-to-beancount/bank-of-america) only documents the checking header and says card exports "generally" have no preamble.

**Confidence:** high on the header string and column order. Seven independent sources from 2012 to 2026 agree, and two (legion, yomi) say they checked real files. Nothing is from Bank of America itself, so it can change without notice. I found no evidence it has changed since 2012.

### 1.2 Field formats

| Item | Finding | Confidence and source |
|---|---|---|
| Date | `MM/DD/YYYY`, zero-padded (`10/23/2012`) | High. 2012 sample; every parser uses `%m/%d/%Y` |
| Sign | Purchases negative, payments and refunds positive | Medium-high. 2012 sample (all purchases negative, one positive row shaped like a payment); legion read a real file as "38 negative debits and 2 positive credits (a refund and a payment)"; go-ynabler, maxwells-wallet, wilson, yomi, lewis agree. Not documented by BofA. |
| Currency symbol | None seen | High for the samples I saw |
| Thousands separator | **UNVERIFIED.** The 2012 sample's one four-digit amount has no comma (`9999.99` shape). Only the synthetic wilson fixture shows `"5,000.00"`. maxwells-wallet configures `,` as a separator without saying why. | Accept both |
| Quoting | 2012 sample: `Payee` and `Address` are always double-quoted and padded with trailing spaces to a fixed width (Payee is 22 characters); `Amount` is unquoted and left-padded with spaces (`    -12.74`); reference number and date unquoted | Medium. Only one real sample, and it's from 2012. Trim every field. |
| Reference Number | 23 digits in the 2012 sample | **Store as TEXT.** 23 digits overflows a 64-bit integer (max 19 digits). |
| Address | Present, may be empty (wilson fixture) | Medium |
| Pending temporary credits | legion (real file, 2026-09-28): a not-yet-posted temporary credit (refund or dispute credit) appears with an **empty Posted Date** and `TEMPRET` in the Reference Number column | Single source, but specific. Treat as real. |
| Encoding | **UNVERIFIED.** No source says. The 2012 sample is ASCII with no BOM. legion, yomi and lewis all strip a UTF-8 BOM defensively; yomi says "UTF-8; a byte order mark is fine". | Decode UTF-8, strip BOM |
| Line endings | **UNVERIFIED.** The only real sample is in git, where it has LF, but git may have normalized it. legion splits on `\r\n`, `\n` or `\r`. | Accept all three |
| Preamble or summary above header | None for the card export: legion ("The export prints no balance, no total"), yomi ("Credit card ... Summary read: None"), beancount.io ("generally don't"), 2012 sample. Only vniranjan disagrees (see table). | High |
| Trailing lines | legion tolerates trailing blank lines only | Medium |
| Account identity | The file body has no account number (legion, verified on real files; yomi). The file **name** carries the last four: `currentTransaction_<last4>.csv` for current activity (legion) and `<Month><YYYY>_<last4>.csv`, e.g. `April2026_1234.csv`, for a statement period (lewis; budget-buddy's 2019 regex matches the same shape) | Medium. Community observations, not BofA docs. |
| History available | BofA: "Request up to 12 months of detailed transaction information" in Online Banking ([BofA credit card FAQ](https://www.bankofamerica.com/credit-cards/credit-card-payments-statements-faq/)) | Official, but it doesn't say whether older statement-period CSVs can be downloaded one by one. **UNVERIFIED.** |
| Download path | Activity → Download → Transaction Period → "Microsoft Excel Format" gives a `.csv` (yomi guide citing [Finaloop help](https://help.finaloop.com/en/articles/9306344-bank-of-america-how-to-upload-your-csv-bank-statements); go-ynabler code comment) | Third-party only |
| Other formats | BofA ended Quicken OFX/QFX downloads on 2025-09-30 ([Quicken Community thread title](https://community.quicken.com/discussion/7966609/9-30-25-bank-of-america-ofx-discontinued); body didn't render for me). yomi's guide says the remaining options are "Microsoft Excel Format" and "Printable Text Format". | Medium |

### 1.3 Checking and savings export (to detect and refuse)

Different layout (legion and yomi both say they checked real files; wilson, beancount.io and the Jane project's [`formats.ts`](https://github.com/cubic1M/Jane/blob/2ac781128ce37de4710ed121adb981ed245110b3/src/data-sources/csv/formats.ts) agree):

1. A summary block whose first line is `Description,,Summary Amt.`, then rows for `Beginning balance as of MM/DD/YYYY`, `Total credits`, `Total debits`, `Ending balance as of MM/DD/YYYY`
2. A blank line
3. The table header `Date,Description,Amount,Running Bal.`
4. A first table row `Beginning balance as of ...` with no amount

So the checking file never starts with `Posted Date`. Detecting either `Description,,Summary Amt.` or `Date,Description,Amount,Running Bal.` as the first non-blank line is enough to name it.

Unconfirmed edge: a vendor page claims a *business* checking CSV "may use Posted Date/Reference Number/Payee/Amount" ([imagetotable.ai](https://imagetotable.ai/blog/convert-bank-of-america-statement-to-excel)). It's four columns (no Address), so an exact 5-column header match still rejects it. The same page makes other claims the real-file sources contradict, so it's low confidence. Business credit-card exports: **UNVERIFIED**, no source.

---

## 2. Plaid `personal_finance_category` taxonomy

### 2.1 Versions and rollout

- **Current taxonomy is PFCv2**, released December 2025 ([PFC migration guide](https://plaid.com/docs/transactions/pfc-migration/)).
- "All new customers enabled for Transactions after December 3, 2025 will be opted in to PFCv2 by default" (same page). The API reference is stricter: customers who enabled Transactions on or after December 3, 2025 "may only receive the `v2` taxonomy" ([Transactions API](https://plaid.com/docs/api/products/transactions/), `options.personal_finance_category_version`). Customers enabled before that get v1 by default and can request v2.
- **For us (INFERRED):** a Trial team created now is a new customer, so we'll get v2. Still store the version, because the field exists.
- Request option: `options.personal_finance_category_version` = `v1` | `v2`, on `/transactions/sync`, `/transactions/get`, `/transactions/enrich`, `/transactions/recurring/get` (migration guide).
- Response: `personal_finance_category.version` is `v1` or `v2` ([Transactions API](https://plaid.com/docs/api/products/transactions/)).
- The accuracy improvements are not backfilled to transactions Plaid categorized before (migration guide).
- PFCv2 is described as a superset of PFCv1 (note row inside the CSV).

### 2.2 Files

| File | URL | Contents |
|---|---|---|
| v2 + v1 comparison (current) | https://plaid.com/documents/pfc-taxonomy-all.csv | Columns `PFCv2 Primary, PFCv2 Detailed, PFCv2 Description, PFCv1 Primary, PFCv1 Detailed, PFCv1 Description`. 127 category rows plus one note row. UTF-8. |
| v1 only (older) | https://plaid.com/documents/transactions-personal-finance-category-taxonomy.csv | Columns `PRIMARY, DETAILED, DESCRIPTION`. 104 rows, 16 primaries. |
| v2 → v1 mapping sheet | [Google Sheet](https://docs.google.com/spreadsheets/d/e/2PACX-1vQjAYBlds-bOGY6DfBW_Fl1lPD7xdwq7RjWWsVshwzWjUhIAxkIlroacVQKtIp-8xXY5DGHcsCq7Mse/pubhtml) (linked from the migration guide; I didn't open it) | |

Cross-check I ran: every one of the 104 v1 detailed codes appears in the comparison file's v1 column, and nothing else does. Three v1 codes were renamed in v2: `INCOME_WAGES` → `INCOME_SALARY`, `INCOME_OTHER_INCOME` → `INCOME_OTHER`, `TRANSFER_IN_CASH_ADVANCES_AND_LOANS` → `LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT`. v1 `TRANSFER_IN_OTHER_TRANSFER_IN` and `TRANSFER_OUT_OTHER_TRANSFER_OUT` also map to v2 `OTHER_OTHER`. No code string means different things in the two versions, so one mapping table keyed on the code string can hold both.

### 2.3 Full v2 list (18 primaries, 127 detailed)

`*` = new in v2 (no v1 equivalent). Detailed codes are shown without their primary prefix to save space; the real code is `PRIMARY_` + suffix (e.g. `FOOD_AND_DRINK` + `GROCERIES` = `FOOD_AND_DRINK_GROCERIES`).

- **INCOME** (13): CHILD_SUPPORT\*, CONTRACTOR\*, DIVIDENDS, GIG_ECONOMY\*, INTEREST_EARNED, LONG_TERM_DISABILITY\*, MILITARY\*, RENTAL\*, RETIREMENT_PENSION, SALARY (v1 INCOME_WAGES), TAX_REFUND, UNEMPLOYMENT, OTHER (v1 INCOME_OTHER_INCOME)
- **LOAN_DISBURSEMENTS**\* (7, new primary): AUTO\*, CASH_ADVANCES\*, EWA\*, MORTGAGE\*, PERSONAL\*, STUDENT\*, OTHER_DISBURSEMENT (v1 TRANSFER_IN_CASH_ADVANCES_AND_LOANS)
- **LOAN_PAYMENTS** (9): BNPL\*, CAR_PAYMENT, CASH_ADVANCES\*, CREDIT_CARD_PAYMENT, EWA\*, MORTGAGE_PAYMENT, PERSONAL_LOAN_PAYMENT, STUDENT_LOAN_PAYMENT, OTHER_PAYMENT
- **TRANSFER_IN** (7): ACCOUNT_TRANSFER, DEPOSIT, INVESTMENT_AND_RETIREMENT_FUNDS, SAVINGS, TRANSFER_IN_FROM_APPS\*, WIRE\*, OTHER_TRANSFER_IN
- **TRANSFER_OUT** (8): ACCOUNT_TRANSFER, CRYPTO\*, INVESTMENT_AND_RETIREMENT_FUNDS, SAVINGS, TRANSFER_OUT_FROM_APPS\*, WIRE\*, WITHDRAWAL, OTHER_TRANSFER_OUT
- **BANK_FEES** (8): ATM_FEES, INSUFFICIENT_FUNDS, INTEREST_CHARGE, FOREIGN_TRANSACTION_FEES, OVERDRAFT_FEES, LATE_FEES\*, CASH_ADVANCE\*, OTHER_BANK_FEES (description includes annual fees)
- **ENTERTAINMENT** (6): CASINOS_AND_GAMBLING, MUSIC_AND_AUDIO (includes streaming), SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS, TV_AND_MOVIES (includes streaming services), VIDEO_GAMES, OTHER_ENTERTAINMENT
- **FOOD_AND_DRINK** (7): BEER_WINE_AND_LIQUOR, COFFEE, FAST_FOOD, GROCERIES, RESTAURANT, VENDING_MACHINES, OTHER_FOOD_AND_DRINK
- **GENERAL_MERCHANDISE** (14): BOOKSTORES_AND_NEWSSTANDS, CLOTHING_AND_ACCESSORIES, CONVENIENCE_STORES, DEPARTMENT_STORES, DISCOUNT_STORES, ELECTRONICS, GIFTS_AND_NOVELTIES, OFFICE_SUPPLIES, ONLINE_MARKETPLACES, PET_SUPPLIES, SPORTING_GOODS, SUPERSTORES (Target, Walmart), TOBACCO_AND_VAPE, OTHER_GENERAL_MERCHANDISE (toys, hobbies, crafts)
- **HOME_IMPROVEMENT** (5): FURNITURE, HARDWARE, REPAIR_AND_MAINTENANCE, SECURITY, OTHER_HOME_IMPROVEMENT
- **MEDICAL** (7): DENTAL_CARE, EYE_CARE, NURSING_CARE, PHARMACIES_AND_SUPPLEMENTS, PRIMARY_CARE, VETERINARY_SERVICES, OTHER_MEDICAL
- **PERSONAL_CARE** (4): GYMS_AND_FITNESS_CENTERS, HAIR_AND_BEAUTY, LAUNDRY_AND_DRY_CLEANING, OTHER_PERSONAL_CARE
- **GENERAL_SERVICES** (9): ACCOUNTING_AND_FINANCIAL_PLANNING, AUTOMOTIVE (oil changes, repairs, towing), CHILDCARE, CONSULTING_AND_LEGAL, EDUCATION (school through college tuition), INSURANCE (auto, home, health), POSTAGE_AND_SHIPPING, STORAGE, OTHER_GENERAL_SERVICES (includes cloud storage)
- **GOVERNMENT_AND_NON_PROFIT** (4): DONATIONS, GOVERNMENT_DEPARTMENTS_AND_AGENCIES, TAX_PAYMENT, OTHER_GOVERNMENT_AND_NON_PROFIT
- **TRANSPORTATION** (7): BIKES_AND_SCOOTERS, GAS, PARKING, PUBLIC_TRANSIT, TAXIS_AND_RIDE_SHARES, TOLLS, OTHER_TRANSPORTATION
- **TRAVEL** (4): FLIGHTS, LODGING, RENTAL_CARS, OTHER_TRAVEL
- **RENT_AND_UTILITIES** (7): GAS_AND_ELECTRICITY, INTERNET_AND_CABLE, RENT, SEWAGE_AND_WASTE_MANAGEMENT, TELEPHONE, WATER, OTHER_UTILITIES
- **OTHER**\* (1, new primary; v1 had no OTHER primary): OTHER_OTHER (no description in the file)

### 2.4 Proposed default mapping

Lookup order per §12.7: detailed code, then primary code, then Uncategorized.

**Primary defaults**

| Plaid primary | Family category | Note |
|---|---|---|
| FOOD_AND_DRINK | Dining | spec |
| GENERAL_MERCHANDISE | Shopping | |
| HOME_IMPROVEMENT | Home | |
| RENT_AND_UTILITIES | Utilities | |
| ENTERTAINMENT | Entertainment | |
| TRAVEL | Travel | |
| MEDICAL | Health | |
| TRANSPORTATION | Gas and auto | |
| BANK_FEES | Fees and interest | |
| PERSONAL_CARE | Other | JUDGMENT (no personal-care category) |
| GENERAL_SERVICES | Other | JUDGMENT |
| GOVERNMENT_AND_NON_PROFIT | Other | JUDGMENT |
| LOAN_PAYMENTS | Payments and transfers | spec |
| TRANSFER_IN | Payments and transfers | spec |
| TRANSFER_OUT | Payments and transfers | spec |
| LOAN_DISBURSEMENTS | Payments and transfers | JUDGMENT. New v2 primary. A card cash advance probably lands here, and it isn't spending. |
| INCOME | Payments and transfers | JUDGMENT. Rare on a card (cash back or rewards credits, maybe). Excluding it stops it netting against real spend. "Other" is the alternative. |
| OTHER | Uncategorized | JUDGMENT. Plaid couldn't classify it, so leave it in the review pile instead of quietly calling it Other. |

**Detailed overrides** (only where the answer differs from the primary)

| Plaid detailed | Family category | Note |
|---|---|---|
| FOOD_AND_DRINK_GROCERIES | Groceries | spec |
| FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR | Groceries | JUDGMENT (liquor stores; Dining is the alternative) |
| GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES | Gifts and donations | JUDGMENT (also covers photo and card shops) |
| GENERAL_MERCHANDISE_SUPERSTORES | Shopping (same as primary, listed so nobody "fixes" it) | JUDGMENT. Target and Walmart mix groceries and goods, and Plaid can't split them. Rules fix it per family. |
| RENT_AND_UTILITIES_RENT | Home | JUDGMENT (rent on a card is rare) |
| GENERAL_SERVICES_AUTOMOTIVE | Gas and auto | |
| GENERAL_SERVICES_CHILDCARE | Kids | |
| GENERAL_SERVICES_EDUCATION | Kids | JUDGMENT (could be adult tuition) |
| GENERAL_SERVICES_INSURANCE | Other | JUDGMENT (auto, home and health all land here) |
| GOVERNMENT_AND_NON_PROFIT_DONATIONS | Gifts and donations | |
| PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS | Health | JUDGMENT |
| MEDICAL_VETERINARY_SERVICES | Other | JUDGMENT (Health is for people; no Pets category) |
| TRANSPORTATION_PUBLIC_TRANSIT | Travel | JUDGMENT |
| TRANSPORTATION_TAXIS_AND_RIDE_SHARES | Travel | JUDGMENT |
| TRANSPORTATION_BIKES_AND_SCOOTERS | Travel | JUDGMENT |
| v1 `INCOME_WAGES`, `INCOME_OTHER_INCOME`, `TRANSFER_IN_CASH_ADVANCES_AND_LOANS` | (fall through to primary) | Seed the v1-only codes anyway only if you want the admin mapping screen to list them; the primary rows already cover them |

Gaps in the taxonomy (INFERRED from the list):

- **Subscriptions** has no Plaid equivalent. Streaming lands in ENTERTAINMENT_TV_AND_MOVIES or ENTERTAINMENT_MUSIC_AND_AUDIO, software and cloud storage in GENERAL_SERVICES_OTHER_GENERAL_SERVICES, phone and internet in RENT_AND_UTILITIES. Subscriptions will come almost entirely from rules.
- **Kids** gets only childcare and education automatically.
- How Plaid categorizes refunds (same category as the purchase?) is **UNVERIFIED**.

---

## 3. `/transactions/sync` transaction object

Source unless noted: [Transactions API reference](https://plaid.com/docs/api/products/transactions/) ([markdown version](https://plaid.com/docs/api/products/transactions/index.html.md)).

| Field | What it is |
|---|---|
| `transaction_id` | Unique id, case-sensitive |
| `account_id` | Account the transaction belongs to. On the account object, the docs say the id won't change "unless Plaid can't reconcile the account with the data returned by the financial institution"; the summary I got also says it can change when the access token is deleted and recreated |
| `amount` | Number (dollars, not cents). "Positive values when money moves out of the account; negative values when money moves in." On a card: purchase positive, payment or refund negative. Matches §12.3. |
| `iso_currency_code` | ISO-4217. Always `null` when `unofficial_currency_code` is set |
| `date` | `YYYY-MM-DD`. For pending: the date it occurred. For posted: the date it posted |
| `authorized_date` | When the institution authorized it. Plaid says it's "generally preferable" to `date` for posted transactions, when available |
| `datetime`, `authorized_datetime` | ISO 8601, when available |
| `pending` | `true` = pending or unsettled |
| `pending_transaction_id` | On a posted transaction: the `transaction_id` of its pending version, "where applicable" |
| `merchant_name` | Nullable. Plaid's enriched merchant name; `null` for things like checks and transfers |
| `name` | **Deprecated**: "a legacy field that is not actively maintained". Still returned. |
| `original_description` | Raw institution string, only if `options.include_original_description` = `true` |
| `personal_finance_category` | Nullable object: `primary`, `detailed`, `confidence_level` (`VERY_HIGH` >98%, `HIGH` >90%, `MEDIUM`, `LOW`, `UNKNOWN`; nullable), `version` (`v1`/`v2`) |
| `personal_finance_category_icon_url` | Icon for the primary category |
| `counterparties[]` | `name`, `entity_id`, `type` (`merchant`, `financial_institution`, `payment_app`, `marketplace`, `payment_terminal`, `income_source`), `website`, `logo_url`, `confidence_level`, `account_numbers` |
| `logo_url` | Nullable, 100×100 PNG |
| `merchant_entity_id` | Stable Plaid id for the merchant |

**Sync response**

- `added`, `modified`: transaction objects, "ordered by ascending last modified time".
- `removed`: objects with only `transaction_id` and `account_id`.
- `next_cursor`: cursor for the next call; empty string if transactions aren't ready yet.
- `has_more`: more pages exist; call again with `next_cursor`.
- `transactions_update_status`: `TRANSACTIONS_UPDATE_STATUS_UNKNOWN`, `NOT_READY`, `INITIAL_UPDATE_COMPLETE`, `HISTORICAL_UPDATE_COMPLETE`.
- Request `count`: default 100, min 1, max 500.

**Cursor rules**

- No cursor means the whole history from the start.
- Persist the cursor only after the whole run of pages finishes ([add-to-app guide](https://plaid.com/docs/transactions/add-to-app/): store it "after successfully pulling all currently available pages"; the sample code saves updates and cursor together after the `while (hasMore)` loop).
- On `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` (HTTP 400, "Underlying transaction data changed since last page was fetched"), "the entire pagination request loop must be restarted beginning with the cursor for the first page of the update" ([API ref](https://plaid.com/docs/api/products/transactions/); [error docs](https://plaid.com/docs/errors/transactions/)). So: discard the pages you buffered and restart from the stored cursor.
- `TRANSACTIONS_SYNC_ITEM_LIMIT_EXCEEDED` (HTTP 400): history too large to sync without a cursor; don't retry, use `/transactions/get` or contact support ([error docs](https://plaid.com/docs/errors/transactions/)). Unlikely for one family.
- Passing `"now"` as the cursor is only for migrating from `/transactions/get`.

**Pending → posted** ([Transaction states](https://plaid.com/docs/transactions/transactions-data/))

- **The id changes.** The posted transaction is a new transaction whose `pending_transaction_id` is the `transaction_id` of the now-removed pending one.
- With sync, the pending id arrives in `removed` and the posted one in `added`, and they "aren't guaranteed to be in the same page". This supports the spec's 7-day soft delete.
- Name and amount can change between pending and posted.
- Some pending transactions never post and just disappear.
- Some institutions (Capital One and USAA are named) don't provide pending data, and Plaid occasionally fails to match a posted transaction to its pending one, so `pending_transaction_id` can be `null` even when a pending row existed. Whether BofA provides pending data is **UNVERIFIED**.

**API version:** `2020-09-14` is the newest version listed, sent as the `Plaid-Version` header ([versioning](https://plaid.com/docs/api/versioning/)). The page doesn't explicitly call it "current".

---

## 4. `/liabilities/get` credit object

Source: [Liabilities API reference](https://plaid.com/docs/api/products/liabilities/). Path `liabilities.credit[]`.

| Field | Type | Notes |
|---|---|---|
| `account_id` | nullable string | Joins to `accounts[].account_id` |
| `last_statement_issue_date` | nullable string, `YYYY-MM-DD` | "The date of the last statement" |
| `last_statement_balance` | nullable number | Total owed as of the last statement |
| `next_payment_due_date` | nullable string, `YYYY-MM-DD` | `null` if no payment is expected |
| `minimum_payment_amount` | nullable number | |
| `last_payment_amount`, `last_payment_date` | nullable | `last_payment_date` has "limited" availability |
| `is_overdue` | nullable boolean | "limited" availability |
| `aprs[]` | array | Empty if the issuer doesn't provide APRs |

**`mask`:** yes, accounts have one. Nullable string, "the last 2-4 alphanumeric characters" of the displayed mask or the account number, and "may be non-unique between an Item's accounts". So it's not always 4 digits and not a key. Credit cards are `type` = `credit`, `subtype` = `credit card` ([Transactions API](https://plaid.com/docs/api/products/transactions/), account object).

Whether BofA returns `last_statement_issue_date` (§19 item 1) is still **UNVERIFIED**; only a real link answers it.

---

## 5. Plaid Trial plan

From [Plaid billing docs](https://plaid.com/docs/account/billing/):

- "You can create 10 Production Items on a Trial plan." **Confirmed.**
- "Removing Items created on a Trial plan (using /item/remove) will not allow you to create more Items." **Confirmed:** removed Items still count.
- "All access tokens created in Production will count against your Trial plan Item limit." So the local counter in §18 `settings.plaid_items_created` should go up on every successful public-token exchange, even if we later drop the Item.
- Trial includes Transactions (with Refresh) and Liabilities, among others.
- The support article "What is the Plaid Trial plan" ([link](https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan)) returned HTTP 403 to me, so I couldn't read it.
- Whether update mode avoids creating a new Item: **UNVERIFIED.** The [Items API page](https://plaid.com/docs/api/items/) only says update mode lets you "update an `access_token` that has stopped working". It's very likely, since update mode works on an existing access token, but no page I read says it doesn't count.

Related, from [OAuth guide](https://plaid.com/docs/link/oauth/) (for §19 items 1 and 5):

- Trial teams can use OAuth institutions in Production; the registration requirements (app profile, MSA, security questionnaire) can wait until you upgrade to a paid plan.
- Bank of America: "The migration to the new Bank of America API ended on October 15, 2026." Items on the new API get a **12-month consent expiration**, and BofA has its own hosted account-select screen.
- When consent is about to expire, US Items get a `PENDING_DISCONNECT` webhook ([Items API](https://plaid.com/docs/api/items/): "fired only for US or Canadian institutions"). If consent lapses the Item goes to `ITEM_LOGIN_REQUIRED`, and update mode fixes it. The Item object has `consent_expiration_time` (`null` if none is scheduled).
- Redirect URI: not strictly required for mobile web in a normal browser (Link opens the bank in a pop-up or tab), required for webviews, and Plaid recommends always setting it.

---

## Implications for the design

### Columns to create now

The constraint is real but narrower than "only add columns". SQLite's `ALTER TABLE` can add, rename and drop columns, but an added column can't be `UNIQUE` or `PRIMARY KEY`, a `NOT NULL` one needs a non-null default, and changing a type, adding a `CHECK`, or adding a foreign key needs the 12-step table rebuild ([SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)). Unique *indexes* can be created at any time. So the things to get right now are types, NOT NULL, CHECK lists and foreign keys. Anything nullable can come later, but adding the Plaid columns now costs nothing and keeps Phase 6b to code only.

Two rules that follow from that:

- Don't put enum `CHECK` constraints on `source` or `category_source`, or list every future value (`plaid`, `csv`, `manual`) now.
- Put uniqueness in separate partial unique indexes, not column constraints.

**`transactions`** (spec §18 plus additions, marked +)

| Column | Type | Why |
|---|---|---|
| id | INTEGER PK | |
| card_id | INTEGER NOT NULL → cards | |
| source | TEXT NOT NULL | `plaid` / `csv` (no CHECK, or a CHECK listing both now) |
| plaid_transaction_id | TEXT NULL | partial unique index where not null |
| + plaid_account_id | TEXT NULL | raw Plaid account id at sync time, for re-matching if Plaid changes account ids |
| pending | INTEGER NOT NULL DEFAULT 0 | |
| pending_transaction_id | TEXT NULL | |
| date | TEXT NOT NULL `YYYY-MM-DD` | Plaid `date` / CSV Posted Date |
| authorized_date | TEXT NULL | |
| amount_cents | INTEGER NOT NULL | positive = money out. Convert Plaid's number and CSV text to cents with decimal-string parsing, not float multiplication |
| + iso_currency_code | TEXT NULL | `USD` for CSV rows. Lets the app refuse or flag non-USD later instead of summing it |
| + unofficial_currency_code | TEXT NULL | |
| merchant | TEXT NULL | Plaid `merchant_name` |
| raw_name | TEXT NOT NULL | Plaid `name` (deprecated but present) or CSV `Payee`, whitespace-collapsed |
| + original_description | TEXT NULL | only if we request it; optional |
| + csv_address | TEXT NULL | BofA `Address`, useful for rules and duplicate matching |
| plaid_pfc_primary, plaid_pfc_detailed | TEXT NULL | |
| + plaid_pfc_confidence | TEXT NULL | lets the UI or rules treat `LOW` differently later |
| + plaid_pfc_version | TEXT NULL | `v1`/`v2` |
| + merchant_entity_id | TEXT NULL | stable merchant key, better than text for future rules |
| + logo_url | TEXT NULL | |
| + counterparties | TEXT NULL (JSON) | |
| category_id, category_source, person_user_id, person_source, note | as spec | |
| csv_reference | TEXT NULL | **TEXT**, not INTEGER (23 digits seen). Partial unique index on (card_id, csv_reference) |
| + csv_import_id | INTEGER NULL → csv_imports | which upload it came from, for an undo and an audit trail |
| + removed_at | TEXT NULL | Plaid `removed` time (spec's `deleted_at` can serve; keep one meaning per column) |
| deleted_at | TEXT NULL | as spec |
| + created_at, updated_at | TEXT NOT NULL | |

**`cards`**

| Column | Notes |
|---|---|
| id, nickname, included, usual_closing_day | as spec |
| plaid_item_id, plaid_account_id | **NULL**-able, because CSV-only cards exist before Plaid. Partial unique index on plaid_account_id |
| mask | TEXT NULL. From Plaid (2 to 4 chars, not unique), or typed or taken from the CSV file name for CSV cards |
| + plaid_name / official_name | TEXT NULL, to show which account is which at link time |
| + plaid_type, plaid_subtype | TEXT NULL (`credit` / `credit card`) |
| + iso_currency_code | TEXT NULL |
| + removed_at | TEXT NULL (Item removed, card kept with history, §12.2) |
| + created_at | |

INFERRED design point: when Plaid later links a BofA card, the admin should be able to attach it to the existing CSV card (match on mask, then confirm), not get a second card. Otherwise the §12.13 "Plaid replaces CSV rows" step can't work, because the duplicate test requires the same card.

**`statements`**

| Column | Notes |
|---|---|
| id, card_id, closing_date, source | as spec. Unique index (card_id, closing_date) |
| + statement_balance_cents | INTEGER NULL, from `last_statement_balance` |
| + payment_due_date | TEXT NULL, from `next_payment_due_date` (belongs to the latest statement) |
| + minimum_payment_cents | INTEGER NULL |
| + fetched_at, updated_at | |

**`plaid_items`**: add `consent_expiration_time` (TEXT NULL) and `status` / `last_webhook_code`, because BofA Items expire after 12 months. (`connections.status` may already cover status.)

**New `csv_imports`** (INFERRED, optional): id, card_id, file_name, file_sha256, uploaded_by, uploaded_at, row_count, imported_count, skipped_count.

### CSV importer: detection and safe failure

1. **Size and bytes.** Up to 5 MB (spec). Decode as strict UTF-8 and strip one leading U+FEFF. If decoding fails: "This file isn't a text CSV. Download it again from Bank of America using Microsoft Excel Format."
2. **Lines.** Split on `\r\n`, `\n` or `\r`. Ignore leading and trailing blank lines.
3. **Header.** Parse the first non-blank line as CSV, trim each cell, and compare to exactly `["Posted Date","Reference Number","Payee","Address","Amount"]`.
   - If the first line is `Description,,Summary Amt.` or `Date,Description,Amount,Running Bal.`: "This is a Bank of America checking or savings export. Only credit-card activity can be imported."
   - If it contains `Posted Date` but doesn't match exactly: "This looks like a Bank of America file, but its columns are different from what the importer knows. Expected: Posted Date, Reference Number, Payee, Address, Amount. Found: …" Show only the header cells, never row data.
   - Anything else: "This isn't a Bank of America credit-card activity CSV."
   - Never scan past line 1 looking for a header. No real source shows a card preamble, and scanning is how the wrong file gets accepted.
4. **Rows.** Parse with a strict CSV parser (a malformed quote fails that row). Then, per row:
   - Exactly 5 fields, or the row is unreadable.
   - Trim every field (the 2012 sample pads Payee, Address and Amount).
   - Date matches `^\d{2}/\d{2}/\d{4}$` and is a real calendar date.
   - Amount matches an optional minus sign, then digits with optional `,` grouping, then an optional `.dd`, and no currency symbol. Convert to integer cents from the string, then negate for the app's convention.
   - Reference number is non-empty.
5. **Special rows.**
   - Empty date with reference `TEMPRET`: show it in the preview as a "pending temporary credit, not imported until it posts". Never store `TEMPRET` as a reference, or the next upload would skip a real row.
   - A reference repeated within the file: flag it in the preview.
   - Other unreadable rows: list them by row number in the preview (§12.13 already does this).
   - Fail the whole import if zero rows are readable.
6. **Sign sanity check** (INFERRED): if most rows are positive after the flip and a "PAYMENT" row is negative, warn that the sign convention may be reversed, as yomi does. This is cheap insurance against BofA flipping the format or someone feeding a re-saved file.
7. **Card cross-check.** If the file name matches `_(\d{4})\.csv$` and the chosen card has a different mask, warn and don't block. The name pattern is community-observed, not documented.
8. **Payments.** CSV rows have no Plaid category, so card payments land in Uncategorized and count toward spend unless a rule catches them. Consider seeding an editable default rule: payee contains `PAYMENT` and the app amount is negative (a credit) → Payments and transfers. That needs a "max amount 0" condition, which §12.8's amount range already allows. The exact BofA payment text is **UNVERIFIED**.

### Conflicts and gaps in spec §12

1. **§12.7 taxonomy version.** The spec doesn't say v1 or v2. A team enabled after 2025-12-03 gets only v2, which adds two primaries (`LOAN_DISBURSEMENTS`, `OTHER`) and renames three codes. The default mapping must cover v2, and the table should store `plaid_pfc_version`. The spec's examples are valid codes in both versions.
2. **§12.1 "CSV also brings in older history."** BofA's own FAQ says Online Banking offers up to 12 months of detailed transactions, while §12.2 asks Plaid for 730 days. So CSV probably gives *less* history than Plaid, unless older statement-period CSVs can be downloaded (UNVERIFIED). CSV's real value is the period before Plaid is linked, or if Plaid can't link BofA.
3. **§12.13 reference numbers** must be TEXT, and `TEMPRET` rows need handling. The spec doesn't mention either.
4. **§12.13 duplicate test vs Plaid.** It needs the Plaid account to land on the *same* card as the CSV rows. The spec's linking flow (§12.2) creates new cards per account, so it needs an "attach to existing card" step.
5. **§12.3 pending carry-over.** Matches Plaid's model: new id on post, possibly separate pages. Two gaps: `pending_transaction_id` can be null even when a pending row existed, and pending rows can vanish without posting. The 7-day soft delete handles the second. For the first, carry-over just won't happen (acceptable, but worth knowing).
6. **§12.3 webhooks.** Only `SYNC_UPDATES_AVAILABLE` is listed. BofA's 12-month consent means we also want `PENDING_DISCONNECT` (and `ITEM_LOGIN_REQUIRED` errors) to prompt an admin to run update mode.
7. **§12.4 cycle date.** The spec uses Plaid's `date` (posted date for posted rows), which lines up with the CSV's Posted Date and, presumably, with how the issuer builds statements. Plaid suggests `authorized_date` for display. Keep `date` for cycles; consider showing `authorized_date` in the table. That statements are built on posted date is INFERRED, not verified for BofA.
8. **§18 `cards.mask`.** Plaid's mask is 2 to 4 characters, nullable and not unique within an Item. Don't key or match on it alone.
9. **§18 `cards.plaid_account_id`.** Plaid says account ids can change if it can't reconcile the account. Low risk, but keep the raw id on each transaction so a re-map is possible.
10. **§12.2 Trial counting.** Confirmed: 10 Items, and removed Items still count. Also, every Production access token counts, so increment the counter at token exchange.
11. **§19 item 1.** Partly answered: Trial teams can reach OAuth institutions like BofA without finishing registration. Whether BofA returns `last_statement_issue_date` is still open.
12. **§19 item 5.** Answered by the OAuth guide: a regular mobile browser works without a redirect URI, a webview doesn't, and Plaid recommends always setting one. The spec already sets it.

### UNVERIFIED list

- Everything about the BofA CSV is community-sourced. No Bank of America document describes the format.
- BofA CSV encoding, BOM and line endings.
- Whether BofA puts thousands separators (`1,234.56`) in the card CSV.
- The exact payee text BofA uses for card payments.
- Whether BofA statement-period CSVs older than 12 months can be downloaded.
- BofA business card and business checking export layouts.
- Whether BofA provides pending transactions through Plaid.
- Whether BofA returns `last_statement_issue_date` (and the other credit fields) through `/liabilities/get`.
- Whether Plaid update mode is guaranteed not to count as a new Trial Item.
- How Plaid categorizes refunds.
- Whether `2020-09-14` is still the current Plaid API version (it's the newest one listed).
