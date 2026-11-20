# Savings panel: design

Status: approved 2026-11-19. A new panel beside Calendar, To-do, Chores, and Spend that shows the family's Fidelity checking and brokerage accounts as summary numbers only. Where this and the main spec (docs/specs/2026-11-15-family-dashboard-design.md) disagree, this wins, and the main spec gets a new section for the panel as part of the work.

## Why

The family wants to see where its savings stand and how they moved this month, split into what was put in, what was taken out, and what the market did, without a list of every transaction. The card spending view already exists in Spend; this is a separate, more sensitive view, so it gets its own panel and its own grant.

## Scope

- One Fidelity login holding a checking (cash management) account and a brokerage account, linked through Plaid as a second Plaid connection (the Trial plan allows 10; BofA uses one).
- Summary data only: balances, and money in and out. No transaction list, no merchant names, no holdings view.
- Calendar months for "this month".

## Access

- A new panel id, `savings`, granted per person in Admin like the other panels (main spec §6). Anyone with the grant sees the panel.
- Linking, renaming or hiding an account, and Refresh are admin-only.

## Linking

- The Savings drill-down has a **Settings** tab (admins) with **Connect an account**. It opens Plaid Link asking for depository and investment accounts rather than credit cards.
- After linking, admins pick which of the Item's accounts to show (as the card pick works in Spend, main spec §12.2), give each a nickname, and can hide or rename one later.
- The connection follows the existing Plaid connection rules (encrypted access token, reconnect, remove, webhooks; main spec §8, §12.2), reusing the Plaid client and Item handling.

## Data

Stored per account, nothing else:

- **Balances:** one snapshot per account per day (family time zone): current balance and, where Plaid gives it, available balance, plus when it was fetched. A later fetch the same day replaces that day's snapshot.
- **Flows:** money in and out of the account: Plaid's id (for idempotency), date, amount, and kind (`deposit` or `withdrawal`). No names or descriptions.
  - Checking: from Plaid Transactions. Money in is a deposit, money out a withdrawal. Transfers to or from the brokerage count, since each account is shown on its own.
  - Brokerage: from Plaid Investments transactions of the cash-movement kinds only (deposits, withdrawals, contributions, transfers in and out). Buys, sells, dividends, interest, and fees are not flows.
- Kept forever, like Spend history. Removing the connection with "also delete its data" deletes it; otherwise it stays, as for cards.

## Numbers shown

For each account, for the current calendar month:

- **Start:** the balance at the end of last month (the last snapshot dated in the previous month).
- **Deposits:** sum of this month's deposits.
- **Withdrawals:** sum of this month's withdrawals.
- **Market change** (brokerage) or **Other change** (checking: interest, fees): `now − start − deposits + withdrawals`. Dividends, interest, and fees land here.
- **Now:** the latest snapshot, with "as of" time.

The first month after linking has no end-of-last-month snapshot: it starts from the first snapshot and says "since <date>". Past months are viewable from the drill-down with the same breakdown, from snapshots and flows.

**Without the Investments product** (Plaid refuses it, or the institution doesn't support it): the brokerage shows Start, Now, and the month's total change, with a short note that deposits and withdrawals aren't available. Checking is unaffected.

## Line graph

- The drill-down shows a line graph of the **total balance of all shown accounts** for the last six months, one point per day from the daily snapshots.
- Plaid gives no past balances, so the line starts on the day the accounts were linked and fills in over time. The graph says so while it has less than six months.
- A day where an account has no snapshot carries its last known balance forward (never before its first snapshot).
- Drawn as inline SVG with no chart library (the CSP allows no external scripts), following the `dataviz` guidance and the design system; the numbers are also available as text for screen readers (the latest total, and the month-end totals).

## Home card

- Each shown account: nickname, current balance, and this month's change (with + or −).
- The total across shown accounts.
- A "stale" note when the latest snapshot is more than a day old, as Spend does for its data.

## Sync

- A daily job (early morning, family time) fetches balances and new flows for every Savings Item; admins also get **Refresh**.
- Balances: Plaid's balance data for the Item's accounts. Flows: Transactions (sync with a cursor) for checking; Investments transactions for a recent date window (re-reading overlap is harmless because flows are keyed by Plaid's id) for the brokerage.
- Errors follow the existing Plaid error handling (needs reconnect, backoff, the System page).

## To verify during implementation

These are not confirmed and must be checked against Plaid's documentation before building on them; anything that can't be confirmed is reported:

- Which products Fidelity supports through Plaid (Transactions on the cash management account; Investments on the brokerage), and how its cash management account is typed (depository or investment).
- Whether the Plaid account has Investments enabled (the Dashboard's Products page; on the Trial plan it may need a request only the account owner can make).
- How Link should request products for this connection (required vs optional products) so a missing Investments product doesn't block linking.
- The cost and rate limits of the balance call on this plan, which decide whether balances come from a dedicated balance call or the cached account data.

## Testing

- Unit: month breakdown (start, deposits, withdrawals, market change; first partial month; missing days), the six-month series with carry-forward, flow classification for each Plaid kind.
- Service: linking and picking accounts, daily sync idempotency, the no-Investments fallback, panel access.
- e2e with the fake Plaid server: link a fake Fidelity Item with a checking and a brokerage account, see the home card, the drill-down breakdown, and the graph; a member without the grant can't see the panel.
