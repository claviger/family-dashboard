# Plaid for the Savings panel: Fidelity, Investments, balances

Research for the Savings panel (docs/specs/2026-11-19-savings-panel-design.md, "To verify during implementation"), done 2026-11-19. It builds on docs/research/plaid-6b.md, which covers the Plaid client, Link, Items, webhooks and errors the app already uses.

**Sources and method.** Only Plaid's public documentation (plaid.com/docs) was read, through a fetch tool that returns a model's summary of each page rather than its raw HTML. Short quotes below are what that tool returned. Treat exact field names and enum lists as "read once, spot-check before hardcoding": the plan keeps every enum it depends on in one constant with a test, so a correction is a one-line change. Nothing was checked against the live API, and no Plaid account was logged in to.

Each finding is marked **Confirmed** (the docs say it), **Inference** (our reading of what the docs say), or **Unverified** (the docs don't say, or we couldn't read the page).

---

## 1. Fidelity through Plaid

### 1.1 Which products Fidelity supports

- **Unverified.** No public page lists Fidelity's products. `https://plaid.com/institutions/fidelity-investments/` returned a 404. The coverage explorer on https://plaid.com/docs/institutions/ is an interactive widget the fetch couldn't read, and that page says it "is not updated in real time" and points to `/institutions/get` or the Dashboard.
- **Confirmed** (https://plaid.com/docs/api/institutions/): `/institutions/get` and `/institutions/get_by_id` return `products`, "A list of the Plaid products supported by the institution", with values that include `transactions`, `investments`, `balance` and `auth`. `/institutions/get` takes `options.products` and "will only return institutions that support all listed products". `oauth` "Indicates that the institution has an OAuth login flow."
- **What to do:** before the first real link, someone with the production keys checks Fidelity's `products` with `/institutions/search` or `/institutions/get_by_id` (or the Dashboard). The plan lists it under "Verify on first real link". The app doesn't call `/institutions/*`.

### 1.2 Access to Fidelity

- **Confirmed** (https://plaid.com/docs/investments/): "Access to Fidelity Investments is granted automatically for all new customers on Growth or Custom plans", effective "approximately 4 weeks after Production access has been granted". Pay-as-you-go customers "must manually request access to Fidelity by going to the OAuth institutions page" and click "Request access".
- **Confirmed** (https://plaid.com/docs/link/oauth/): Fidelity is an OAuth institution. Registration for "Fidelity and Charles Schwab, may take longer" (no duration given). Fidelity is listed among institutions whose OAuth consent must be refreshed every 12 months.
- **Confirmed** (https://plaid.com/docs/changelog/): 2026-05-20, "Trial plan customers can now get immediate access to all OAuth institutions". 2026-09-11, "Improved user experience for accessing Fidelity Investments".
- **Inference:** on the Trial plan, Fidelity should be reachable without a separate request, per the 2026-05-20 entry. Whether that holds for this team is something only the owner can see on the Dashboard's OAuth institutions page.

### 1.3 How the cash management account is typed

- **Confirmed** (https://plaid.com/docs/api/accounts/, the account type schema): `cash management` is a subtype of `depository` only ("A cash management account, typically a cash account at a brokerage"). It is not an `investment` subtype. Investment subtypes include `brokerage`, `ira`, `roth`, `401k` and many more.
- **Confirmed** (same page, the product and account type matrix): "Investments does not support `depository` types other than `cash management`."
- **Inference:** Fidelity's Cash Management Account will most likely come back as `type: depository`, `subtype: cash management`, and the brokerage as `type: investment`, `subtype: brokerage`. The docs don't name Fidelity's mapping, so the plan reads `type` from `/accounts/get` and decides each account's flow source from it (`depository`: Transactions; `investment`: Investments), rather than assuming either.
- **Inference:** since Investments covers `cash management`, the CMA's cash movements may also show up in `/investments/transactions/get`. The plan only reads Investments transactions for `investment` accounts, so a depository CMA's flows come from Transactions alone and nothing is counted twice.

---

## 2. Asking for products in Link

### 2.1 The four product arrays of `/link/token/create`

Sources: https://plaid.com/docs/api/link/ and https://plaid.com/docs/link/initializing-products/. All **Confirmed** unless marked.

| Field | What it does | Billing |
|---|---|---|
| `products` | "List of Plaid product(s) that the linked Item must support." "Only institutions that support _all_ requested products can be selected." "Item creation will fail if one or more listed products is unavailable at the institution." A product "cannot be removed from an Item once the Item has been initialized." `balance` "is _not_ a valid value". At least one product is required. | Subscription and one-time products are billed at Item creation. |
| `required_if_supported_products` | Used "only if the institution and account(s) selected by the user support the product". "Institutions that do not support these products will still be shown in Link." If unsupported, it's ignored and "Item creation will succeed." | Billed at Item creation, like `products`. |
| `optional_products` | "failure to support these products will not affect Item creation." | Only Auth, Identity, Signal Transaction Scores and Plaid Check are billed solely on use. **Inference:** Investments here would be billed at Item creation. |
| `additional_consented_products` | Collects consent only; Plaid does not extract data during Link. "Institutions that do not support these products will still be shown in Link." | "These products will not be billed until you start using them by calling the relevant endpoints." |

- **Confirmed:** a product may appear in only one of the four arrays.
- **Confirmed:** no restriction on combining Transactions and Investments is stated. The page says "virtually all Items that support Liabilities or Investments also support Transactions".

### 2.2 What the Savings link asks for

- **Decision (inference from 2.1):** `products: ['transactions']`, `required_if_supported_products: ['investments']`. Transactions is what the checking account's flows need, and a missing Investments product then never hides Fidelity or fails the link; it only leaves the brokerage on the "deposits and withdrawals aren't available" fallback. This is the same shape Spend uses for Liabilities.
- **Risk:** if Fidelity turns out not to support Transactions, `products: ['transactions']` hides Fidelity in Link altogether. The fix is a one-line change of `SAVINGS_LINK_PRODUCTS` to `products: ['investments']` (the checking account's flows then come from nowhere and it shows the same fallback). Check 1.1 first.
- **Alternative not taken:** `additional_consented_products: ['investments']` defers billing until the first call, but Plaid extracts nothing during Link, and update mode would be needed if consent turns out to be missing (`ADDITIONAL_CONSENT_REQUIRED`, section 7). We call Investments on the first sync anyway, so nothing would be saved.

### 2.3 `account_filters`

- **Confirmed** (https://plaid.com/docs/api/link/): keys `depository`, `credit`, `loan`, `investment`, `other`, each `{ account_subtypes: string[] }`. "To indicate that all subtypes should be shown, use the value `"all"`." "any account type for which a filter is not specified … will be entirely omitted from Link."
- **Decision:** `{ depository: { account_subtypes: ['all'] }, investment: { account_subtypes: ['all'] } }`, so credit cards (and loans) are never offered or shared, as the spec asks.

### 2.4 Investments options at link time

- **Confirmed:** `investments.async_update` on `/link/token/create`: "If `true`, only a 30-day initial history of investment transactions is pulled synchronously before the Link session." Other fields on `investments`: `allow_manual_entry`, `allow_unverified_crypto_wallets` (both default `false`).
- **Unverified:** the page says `async_update` is configurable only for Plaid teams created before November 18, 2026, defaulting to `false`; what newer teams get isn't stated. The plan leaves the `investments` object out entirely and never relies on initial history, since the panel's numbers start at the first balance snapshot anyway.

### 2.5 `transactions.days_requested`

- **Inference:** the Savings link leaves `transactions` out (Plaid's default history). Flows before the first snapshot never enter a number (spec "Numbers shown": the first month starts from the first snapshot), so asking for 730 days, as Spend does, would only fetch and store more personal data for nothing. The default's length isn't something the plan depends on.

---

## 3. `/investments/transactions/get`

Source: https://plaid.com/docs/api/products/investments/. **Confirmed** unless marked.

### 3.1 Request

- `access_token`, `start_date` and `end_date` (required, `YYYY-MM-DD`).
- `options.account_ids`; `options.count` (default 100, min 1, max 500); `options.offset` (default 0).
- `options.async_update` (default `false`); when `true`, "Plaid will subsequently fire a `HISTORICAL_UPDATE` webhook when the extraction completes". The plan doesn't use it.
- History: "up to 24 months of user-authorized transaction data"; `start_date` "up to 2 years prior to the initial linking of the Item".
- Results are "returned in reverse-chronological order" and paginated by `offset` up to `total_investment_transactions` ("The total number of transactions available within the date range specified").

### 3.2 Response

- `investment_transactions[]`: `investment_transaction_id`, `account_id`, `security_id`, `date`, `transaction_datetime`, `name`, `quantity`, `amount`, `price`, `fees`, `type`, `subtype`, `iso_currency_code`, `unofficial_currency_code`.
- `type` and `subtype` can be `null` when the institution doesn't provide them.
- `total_investment_transactions`.
- **Unverified:** the response's other top-level fields (`accounts`, `securities`, `item` are likely, by analogy with holdings). The plan's client schema reads only `investment_transactions` and `total_investment_transactions`, and from each entry only `investment_transaction_id`, `account_id`, `security_id`, `date`, `amount`, `type`, `subtype`, `iso_currency_code`, `unofficial_currency_code`. `name` is never read or stored (the spec keeps no names).

### 3.3 Sign of `amount`

- **Confirmed:** "Positive values when cash is debited, e.g. purchases of stock; negative values when cash is credited, e.g. sales of stock." The schema adds that "transactions representing inflow of cash will appear as negative amounts".
- So a deposit is negative and a withdrawal positive, the same as `/transactions/sync`'s convention (positive is money out).

### 3.4 `type` and `subtype` values

From the "Investment transaction types schema" on https://plaid.com/docs/api/accounts/ (**Confirmed**, as read through the summarizing fetch):

| `type` | `subtype` values |
|---|---|
| `cash` | account fee, contribution, deposit, dividend, interest, legal fee, long-term capital gain, management fee, margin expense, non-qualified dividend, non-resident tax, pending credit, pending debit, qualified dividend, short-term capital gain, tax, tax withheld, transfer fee, trust fee, unqualified gain, withdrawal |
| `buy` | assignment, buy, buy to cover, contribution, dividend reinvestment, interest reinvestment, long-term capital gain reinvestment, short-term capital gain reinvestment |
| `sell` | distribution, exercise, sell, sell short |
| `fee` | account fee, adjustment, dividend, interest, interest receivable, legal fee, long-term capital gain, management fee, margin expense, non-qualified dividend, non-resident tax, qualified dividend, return of principal, short-term capital gain, tax, tax withheld, transfer fee, trust fee, unqualified gain |
| `transfer` | adjustment, assignment, exercise, expire, merger, request, send, spin off, split, trade, transfer |
| `cancel` | none listed |

- **Confirmed** (changelog 2026-09-03): `fund fee`, `loan payment` and `rebalance` were removed; `stock distribution` was deprecated in favor of `transfer` / `spin off`.
- The `fee` row lists dividend and interest; that's what the schema says, and it doesn't matter here, since no `fee` row is a flow.

### 3.5 Which ones are cash movements (the plan's classification)

**Inference**, written as one constant (`CASH_MOVEMENTS` in `src/server/panels/savings/flows.ts`) with a test for every listed pair:

- **Flows:** `cash` / `deposit`, `cash` / `contribution`, `cash` / `withdrawal`; and `transfer` / `transfer` only when `security_id` is null (a cash transfer; with a security it's shares moving, which isn't money in or out).
- **Direction from the sign** (3.3), not the subtype: negative is a deposit, positive a withdrawal, zero is skipped. A subtype whose sign disagrees with its name (a `deposit` with a positive amount) is still classified by the sign, and counted in the sync's log line.
- **Not flows:** every other pair, including dividends, interest, capital gains, fees, taxes, buys, sells, reinvestments, `buy` / `contribution` (shares bought with a contribution, which the spec's "buys" excludes), `pending credit` and `pending debit` (they post later as their own entries; counting both would double them), and any row whose `type` or `subtype` is null. These land in "Market change", which is the spec's intent.
- **Unverified:** what Fidelity actually sends for an ACH deposit or a CMA-to-brokerage transfer. Listed under "Verify on first real link": the plan's sync log counts rows by `type:subtype` (never names or amounts), so the first real sync's log line shows what came.

---

## 4. `/investments/holdings/get`

- **Confirmed** (https://plaid.com/docs/api/products/investments/): request `access_token`, optional `options.account_ids`; response `accounts` (with balances, "including margin loan information for investment accounts"), `holdings`, `securities`, `item`, `request_id`, `is_investments_fallback_item`.
- **Decision:** not used. The spec has no holdings view, and `/accounts/get` already gives the balances (5.1).

---

## 5. Balances

### 5.1 `/accounts/get` (cached)

- **Confirmed** (https://plaid.com/docs/api/accounts/): "The balance returned will reflect the balance at the time of the last successful Item update."
- `balances.current`: for investment accounts, the total value of assets as the institution presents it. `balances.available`: for investment accounts, "the total cash available to withdraw as presented by the institution". `iso_currency_code` is "Always null if `unofficial_currency_code` is non-null".
- `balances.last_updated_datetime` is only returned for Capital One (`ins_128026`) and Apple Card (`ins_136439`); expect null for Fidelity. The plan records its own `fetched_at` instead.
- **Confirmed** (product matrix footnote): "Investments holdings data is not priced intra-day."
- **Confirmed** (https://plaid.com/docs/balance/): cached data is "unsuitable for situations where you need real-time balance information"; Transactions Items update "once a day or more". (https://plaid.com/docs/investments/): Investments checks "at least once per day during market days", 2 to 4 times a day depending on the institution.
- **Confirmed:** `/accounts/get` is free (docs/research/plaid-6b.md §4.3 already relies on this; https://plaid.com/docs/account/billing/ bills Balance per call, and `/accounts/get` isn't a Balance call).

### 5.2 `/accounts/balance/get` (real time)

- **Confirmed:** real time, latency "p50 ~3s, p95 ~11s" (https://plaid.com/docs/balance/). Billing: "Balance is billed on a flat fee model", per successful call (https://plaid.com/docs/account/billing/). "A price list is not available in the documentation."
- **Confirmed** rate limits (https://plaid.com/docs/errors/rate-limit-exceeded/), production, per Item: `/accounts/get` 15/min; `/accounts/balance/get` 5/min and 30/hr; `/investments/holdings/get` 15/min; `/investments/transactions/get` 30/min; `/investments/refresh` 1/min, 10/hr, 20/day. Sandbox is looser. No limits specific to Trial or Limited Production are listed.

### 5.3 Decision

Balances come from `/accounts/get`. The panel shows a daily snapshot with "as of", so Plaid's cached balance (refreshed at least daily, and investment holdings aren't priced intra-day anyway) is what it needs, at no cost. A real-time call would be billed per call after the Trial for a number that changes once a day. This answers the spec's "cost and rate limits of the balance call" item: the cached call is free and its limit (15 a minute per Item) is far above one daily run plus an admin's Refresh (10 a minute per admin).

---

## 6. How investments updates are signaled

Source: https://plaid.com/docs/api/products/investments/ and https://plaid.com/docs/investments/. **Confirmed** unless marked.

- `HOLDINGS` / `DEFAULT_UPDATE`: fields `webhook_type`, `webhook_code`, `item_id`, `user_id`, `error`, `new_holdings`, `updated_holdings`, `environment`. Fires "when new holdings have been detected or the quantity or price of an existing holding has changed".
- `INVESTMENTS_TRANSACTIONS` / `DEFAULT_UPDATE`: fields `webhook_type`, `webhook_code`, `item_id`, `user_id`, `error`, `new_investments_transactions`, `cancelled_investments_transactions` (two Ls), `environment`.
- `INVESTMENTS_TRANSACTIONS` / `HISTORICAL_UPDATE` exists; its payload fields weren't read (**Unverified**).
- `/investments/refresh` exists ("initiates an on-demand extraction") but is a paid add-on that needs a product access request. Not used.
- Sandbox: Investments `DEFAULT_UPDATE` webhooks "typically do not fire in Sandbox" (https://plaid.com/docs/sandbox/).
- **Decision:** for a Savings Item, `TRANSACTIONS` `SYNC_UPDATES_AVAILABLE`, `HOLDINGS` `DEFAULT_UPDATE` and `INVESTMENTS_TRANSACTIONS` `DEFAULT_UPDATE` each ask for a background Savings sync (folded per Item, like Spend's). Only `webhook_type`, `webhook_code`, `item_id` and `environment` are read; the counts are ignored. The daily job is the backstop, so a missed webhook costs at most a day.

---

## 7. Errors

**Confirmed** unless marked.

| `error_type` / `error_code` | HTTP | When | Source |
|---|---|---|---|
| `ITEM_ERROR` / `PRODUCTS_NOT_SUPPORTED` | 400 | "A product endpoint request was made for an Item that does not support that product." | https://plaid.com/docs/errors/item/ |
| `ITEM_ERROR` / `NO_INVESTMENT_ACCOUNTS` | 400 | Link ran with Investments but no investment accounts were linked, or OAuth permission for them wasn't granted. | same |
| `ITEM_ERROR` / `PRODUCT_NOT_READY` | 400 | "/investments/transactions/get was called before the investments data could be extracted." | same |
| `INVALID_INPUT` / `INVALID_PRODUCT` | 400 | "your client ID does not have access to this product", or the product isn't enabled in that environment. | https://plaid.com/docs/errors/invalid-input/ |
| `INVALID_INPUT` / `ADDITIONAL_CONSENT_REQUIRED` | 400 | "The end user has not provided consent to the requested product." | same |

- **Unverified:** a `PRODUCT_NOT_ENABLED` code wasn't found on these pages; the related codes are `INVALID_PRODUCT` and `UNAUTHORIZED_ROUTE_ACCESS`. The plan doesn't name `PRODUCT_NOT_ENABLED`.
- **Unverified:** the fix for `ADDITIONAL_CONSENT_REQUIRED` (update mode with `additional_consented_products`) came from a search summary of https://plaid.com/docs/link/update-mode/, not a read of the page. The plan's update mode doesn't add products, so for this code Savings settings says to remove the connection and link it again.
- **Decision:** `PRODUCTS_NOT_SUPPORTED`, `NO_INVESTMENT_ACCOUNTS`, `INVALID_PRODUCT` and `ADDITIONAL_CONSENT_REQUIRED` from `/investments/transactions/get` mean "Investments isn't available for this connection": not a connection failure (the status stays `ok`, no backoff), recorded on the Item (`investments_status = 'unavailable'` with the code), and tried again on the next daily run, so enabling the product later is picked up without code changes. `PRODUCT_NOT_READY` stays transient, as the client already classes it.

---

## 8. Trial plan and enabling Investments

- **Confirmed** (changelog 2026-04-16; https://plaid.com/docs/sandbox/): Trial plans are free Production access for up to 10 Items and "replace Limited Production for all newly created Plaid teams" (on or after 2026-04-15).
- **Confirmed** (https://plaid.com/docs/account/billing/): subscription products added during a Trial are billed after the upgrade. Investments is a monthly subscription per Item; Holdings starts when you link with Investments or call holdings, and the first `/investments/transactions/get` call "adds both the Investments Transactions and Investments Holdings subscriptions". `/investments/refresh` is billed per request.
- **Confirmed** (https://plaid.com/docs/investments/): Investments can be tested in Sandbox "without any additional permissions".
- **Unverified:** whether Investments must be enabled (or requested) in the Dashboard for this Trial team in Production, and which products are on by default. **Only the account owner can check this** (Dashboard, Products or the team's product access page). If it isn't enabled, `/link/token/create` with Investments in `required_if_supported_products` may be refused with `INVALID_PRODUCT` (**Inference**: the docs say the code covers a product not enabled for the client; whether Link token creation or the later product call is what refuses wasn't stated). The plan handles both: a link token refused with `INVALID_PRODUCT` is retried once without Investments, and Savings settings says Investments isn't enabled.

---

## 9. Sandbox (for the fake, shapes only)

- **Confirmed** (https://plaid.com/docs/sandbox/test-credentials/): `user_good` / `pass_good` gives "basic account access to most Plaid products"; whether it includes an investment account isn't stated.
- **Confirmed** (https://plaid.com/docs/sandbox/user-custom/): custom users take `override_accounts[]` with `type`, `subtype`, `starting_balance`, `holdings[]` and `investment_transactions[]` (`date`, `name`, `quantity`, `price`, `fees`, `type`, `currency`, `security`). The page doesn't list a `subtype` for custom investment transactions. "Investments must be placed in the `products` array" for custom users.
- The app's tests don't use Sandbox (main spec §16); the in-memory `FakePlaid` gains `/investments/transactions/get` and settable balances, with synthetic data only.

---

## 10. Interest on the cash account (`personal_finance_category`)

Asked by the CSV import design (docs/specs/2026-11-20-savings-csv-import-design.md, "Interest from Plaid"): which v2 `personal_finance_category` marks interest earned on a depository account, so the Savings sync can stop counting it as a deposit. Checked 2026-11-20, plaid.com/docs pages only, same method as above.

- **Confirmed** (https://plaid.com/docs/api/products/transactions/): `personal_finance_category` is "Information describing the intent of the transaction", with `primary` and `detailed`, and the page sends you to a taxonomy CSV for the full list. That file is at https://plaid.com/documents/pfc-taxonomy-all.csv, outside plaid.com/docs, so it wasn't read.
- **Confirmed** (same page): the only `INCOME_` value in the page is `INCOME_WAGES`, in the `/transactions/recurring/get` example. No interest category is named for either taxonomy version.
- **Confirmed** (https://plaid.com/docs/transactions/pfc-migration/): v2 adds "six additional income subcategories". The page doesn't name them.
- **Confirmed** (https://plaid.com/docs/api/products/transactions/): `transaction_code` has an `interest` value ("Interest earned or incurred"), but it's only filled in "for European institutions, as well as certain institutions in the United States", and `null` otherwise. So the sync can't count on it for Fidelity.
- **Inference, not from plaid.com/docs:** a web search turned up `INCOME_INTEREST_EARNED` ("Income from interest on savings accounts") in the taxonomy CSV. Whether v2 still uses that code wasn't confirmed, and a `site:plaid.com/docs` search found no docs page with it.

**Decision (spec, "Interest from Plaid", approved 2026-11-20):** since the category isn't confirmed, the sync uses a heuristic. A cash-account transaction counts as interest, so it isn't a deposit, when its `personal_finance_category.detailed` starts with `INCOME_INTEREST`, or its `name` starts with `INTEREST EARNED` or `INTEREST PAID` (ignoring case). The name is read at sync time only, never stored or logged. The sync log counts these (`interest`), so the first real Fidelity sync shows whether the heuristic catches Fidelity's interest. If it misses, read the v2 taxonomy CSV and add the real code or wording to `isPlaidInterest` with a test (, Task 7).

---

## Couldn't verify (the plan is built to survive each)

| Question | Why it matters | How the plan copes |
|---|---|---|
| Fidelity's products (`/institutions/get_by_id`) | Transactions missing would hide Fidelity in Link | One constant to flip; checked before the first real link |
| Fidelity's real account types | Which flow source each account uses | Decided per account from `/accounts/get`'s `type` |
| Whether this team has Investments enabled (owner only) | The brokerage's deposits and withdrawals | `required_if_supported_products`, a retry without it on `INVALID_PRODUCT`, and the spec's fallback view |
| What Fidelity sends for deposits and transfers | The classification | One constant; the sync logs counts by `type:subtype` |
| `async_update` for teams created on or after 2026-11-18 | Initial history | Not used; numbers start at the first snapshot |
| `HISTORICAL_UPDATE` payload | None | Acknowledged and ignored |
| The full `/investments/transactions/get` response | None | Only the listed fields are read |
| `ADDITIONAL_CONSENT_REQUIRED`'s fix | Recovery wording | Treated as "remove and link again" |
| Prices (Investments subscription, Balance per call) | Cost after the Trial | Balance calls aren't used; Investments billing is in the plan's risks |
| Trial-specific rate limits | None at one run a day | Refresh limited to 10 a minute per admin |
| The v2 `personal_finance_category` for interest earned (§10) | Interest must land in Other change, from Plaid as from a CSV | A heuristic (`INCOME_INTEREST…`, or a name starting `INTEREST EARNED` / `INTEREST PAID`), counted in the sync log |
