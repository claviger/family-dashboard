# Family Dashboard

A self-hosted dashboard for one family. One page of cards, read at a glance from a phone or a kitchen tablet, with a drill-down behind each one. I built it for my own household and run it on a small home server; it's meant for one family per install, not as a multi-tenant service.

The full design lives in `docs/specs/2026-11-15-family-dashboard-design.md`. The later features each have their own design in `docs/specs/`, and `docs/research/` has the notes on the outside APIs (Google Calendar, Todoist, Plaid).

## What it does

- **Calendar.** Reads and edits one shared Google Calendar. The home card shows the next seven days; the drill-down has agenda, week, and month views, repeating events, and an event dialog. Changes from the dashboard never email guests.
- **To-do.** A to-do list per person. Each person can link their own Todoist account, and then their Todoist Inbox is their list, kept in sync both ways.
- **Chores.** A chore board: every household chore, how often it comes up, and who has it. Anyone can claim a chore, from the board or from someone else. A claimed chore goes on that person's to-do list, due the next time it comes up, and comes back on schedule after it's done. Unassigned chores are never late. Completion history with credit, late, and skipped counts.
- **Spend.** Credit card spending by billing cycle, by category and by person, with donut charts and an "on track for" projection. Transactions come from your card issuers through Plaid, and from CSV imports. Rules and bank categories file transactions automatically; you can sort the list, and remove duplicates with an undo.
- **Savings.** Checking and brokerage accounts as summary numbers: each month's start, deposits, withdrawals, market change, and end, past months, a six-month graph of the total with deposit and withdrawal markers, and a one-month graph on the home card. Accounts come from your bank or brokerage through Plaid, from any institution's CSV export through a column-mapping importer, or are added by hand with a balance you set. It stores balances and the dates and amounts of money moving in and out, never transactions, merchants, or holdings.
- **People and access.** Google sign-in. Only people an admin adds can sign in, and each person sees only the panels an admin turns on for them.

It follows the system's light or dark setting, works by keyboard, and keeps touch targets at least 44 px.

### What you can connect

The money panels work with whatever financial institutions you use. Nothing is tied to a particular bank.

| Kind of account | Panel | How it comes in |
| --- | --- | --- |
| Credit cards | Spend | Through [Plaid](https://plaid.com) from any card issuer Plaid supports, or from a CSV export (Bank of America's format is built in today) |
| Checking, savings, and cash management accounts | Savings | Through Plaid from any bank Plaid supports, from any bank's CSV export, or added by hand |
| Brokerage and other investment accounts | Savings | Through Plaid (with its Investments product) from any brokerage Plaid supports, from any brokerage's CSV export, or added by hand with balances you set |

I run it with Bank of America credit cards and a Fidelity cash management account and brokerage, so those are the examples below. Plaid is optional: without it, Spend uses CSV imports and Savings uses CSV imports and hand-set balances.

## How it's built

- **Server:** Node 22+, TypeScript, [Hono](https://hono.dev), SQLite through better-sqlite3 and [Drizzle](https://orm.drizzle.team) (migrations in `drizzle/`), Zod for validation, pino for logs, and an in-process job scheduler.
- **Web:** React 19, TanStack Router and Query, Vite. Charts are inline SVG with no chart library. Fonts are self-hosted (EB Garamond and Figtree). The design tokens and components are documented in `docs/design-system/`.
- **Security:** a strict Content-Security-Policy (self only, no inline scripts or styles), CSRF checks on every change, rate limits, encrypted OAuth and Plaid tokens at rest (`TOKEN_ENCRYPTION_KEY`), and no secrets or imported file contents in the logs.
- **Tests:** Vitest for unit and integration tests, and Playwright end-to-end tests against fake Google, Todoist, and Plaid servers.

| Path | What's there |
| --- | --- |
| `src/server/` | The API, jobs, integrations (`integrations/google`, `todoist`, `plaid`), and one folder per panel under `panels/` |
| `src/web/` | The React app: the shell, and one folder per panel under `panels/` |
| `src/shared/` | Types, Zod schemas, and messages used by both sides |
| `drizzle/` | Database migrations, applied automatically at startup |
| `e2e/` | Playwright tests |
| `deploy/` | An nginx snippet and a systemd unit |
| `docs/` | The specs, research notes on the outside APIs, and the design system |

## Setting up your own instance

1. **Google Cloud**
   - Create a project, and **enable the Google Calendar API** for it (APIs & Services, Library).
   - Configure the OAuth consent screen as External, then **publish it as "In production."**
     - In Testing mode, Google refresh tokens expire after 7 days, so the calendar link would stop working every week.
     - Add the two calendar scopes to the consent screen: `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.calendarlist.readonly`. Sign-in asks only for `openid`, `email`, and `profile`.
     - The app can stay unverified. Google shows its "unverified app" warning only when an admin connects the calendar, since only that asks for calendar scopes; the admin continues past it.
     - Unverified apps can be granted those scopes by at most 100 Google accounts, over the project's whole life. Only the accounts that connect the calendar count, so a family never gets near it.
   - Create an OAuth client of type *Web application*, with both redirect URIs:
     - `https://YOUR_HOST/auth/google/callback` (sign-in)
     - `https://YOUR_HOST/connect/google-calendar/callback` (the calendar link)
2. **Todoist** (optional; skip it and the To-do panel uses its own list for everyone)
   - In Todoist's [App Management Console](https://app.todoist.com/app/settings/integrations/app-management), create an app.
   - Set its **OAuth redirect URL** to exactly `https://YOUR_HOST/connect/todoist/callback`. Register only this one URL.
   - Set its **webhook callback URL** to `https://YOUR_HOST/webhooks/todoist`. Todoist requires HTTPS on port 443, with no port in the URL.
   - Subscribe the webhook to the `item:*` events: `item:added`, `item:updated`, `item:completed`, `item:uncompleted`, and `item:deleted`. Then **activate** the webhook.
   - Copy the app's client ID and client secret.
   - Todoist doesn't send webhooks for the account that owns the app until that account goes through the app's OAuth flow. So the owner links like everyone else, with **Settings → Connect Todoist**, never with a personal API token. Until then, the 10-minute sync still keeps them up to date.
3. **Plaid** (optional; it connects your credit cards, bank accounts, and brokerage accounts. Skip it and Spend and Savings use CSV imports, plus hand-set balances in Savings)
   - Create a Plaid team and get it on the **Trial plan**. Plaid's docs say who the Trial is for, but not exactly how a team gets it (an application that Plaid approves, or an option when the team is created), so follow what the Plaid Dashboard offers. It's free for teams in the US or Canada created on or after April 15, 2026, and it runs in Plaid's **production** environment, with real bank data, for up to 10 connections (Plaid calls each login at an institution an Item, whether it's a card issuer, a bank, or a brokerage). Removing a connection doesn't give it back. Spend settings counts the connections this server has made, but Plaid's Dashboard homepage has the real number.
   - Copy the team's client ID and its **production** secret. The client ID is the same in every environment, but each environment (Sandbox and production) has its own secret, so `PLAID_ENV` must match the secret you set. The app can't check that pair when it starts: with the wrong one, Plaid refuses every call, starting with **Connect bank**.
   - The secret goes in `PLAID_SECRET`. `PLAID_CLIENT_SECRET` isn't read: if it's set and `PLAID_SECRET` isn't, the app refuses to start and says to rename it.
   - In the Dashboard's **Allowed redirect URIs**, add exactly `https://YOUR_HOST/connect/plaid/oauth-return`. Many institutions (Bank of America and Fidelity among them) have you sign in on their own pages, and on a phone or in an in-app browser (a dashboard link opened from Mail, say) Link comes back to this page to finish.
   - There's no webhook URL to set in the Dashboard. The app sends `https://YOUR_HOST/webhooks/plaid` with each link, and Plaid keeps it for that connection. So if you change `BASE_URL` later, update the redirect URI, then remove each connection and link it again, which uses another Trial connection each.
   - Check that your institutions are available on your plan. Plaid's general rule is that Trial teams get institutions that use their own sign-in pages (OAuth) without the paid plan's extra steps; Bank of America and Fidelity both worked for me on the Trial. If one isn't in Link on the day the Trial starts, wait a day or two: Plaid says new Trial teams can take that long to get some institutions.
   - For brokerage accounts in the Savings panel: check that **Investments** is enabled for your team in Plaid's Dashboard (its Products page). On some plans you have to request it, and only the team's owner can see that page or ask. Without it, Savings still links, and the brokerage shows its total change only, with no deposits or withdrawals. After the Trial, Investments is a monthly subscription per connection, which Spend's cards never needed. See [Savings: connecting a bank or brokerage](#savings-connecting-a-bank-or-brokerage).
4. **Secrets**
   - Generate a session secret with `openssl rand -base64 32`.
   - Generate a token encryption key the same way: `openssl rand -base64 32`. It's required. The app encrypts the Google Calendar, Todoist, and Plaid tokens it stores with it. **Keep a copy outside the server**, for example in a password manager. It isn't in the database or the backups, which is the point.
   - If the app starts with a different key while it has tokens saved, it keeps running but turns Google Calendar, Todoist, and bank syncing off, and the System section of the Admin page says so. The calendar still shows the events it last fetched, and Spend still shows every transaction. Put the original key back and restart, and everything works as before.
   - If the original key is lost: set a new key, restart, and press **Reset links for a new key** in the System section. Google Calendar is disconnected, and everyone's to-dos stay on the dashboard. The old tokens are deleted, since they can't be read, so the app can't revoke them; each Google or Todoist account can remove the dashboard's access in its own settings. Then an admin connects Google Calendar again, and each person connects Todoist again from Settings. No other data is lost. If nothing was linked yet, the new key just works.
   - With Plaid, the reset also disconnects every bank. Its cards and transactions stay, listed under **Removed banks** in Spend settings. The old connections stay active at Plaid until they expire, since their tokens can't be read to end them, so Spend settings and the System section show a notice for each one (and for any bank removal Plaid hadn't confirmed yet) saying to remove the dashboard at the bank or at my.plaid.com, until you dismiss it. Then connect each bank again, which uses another Trial connection each. Linking a bank again doesn't double its history (see [Spend: linking credit cards through Plaid](#spend-linking-credit-cards-through-plaid)).
5. **Configure**
   - Copy `.env.example` to `.env` and fill in:
     - `BASE_URL=https://YOUR_HOST`
     - `SESSION_SECRET`
     - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
     - `BOOTSTRAP_ADMIN_EMAIL` (your Google address)
     - `TOKEN_ENCRYPTION_KEY`
     - For Todoist: `TODOIST_CLIENT_ID` and `TODOIST_CLIENT_SECRET`
     - For Plaid: `PLAID_CLIENT_ID`, `PLAID_SECRET` (the production secret), and `PLAID_ENV=production`
   - See [Configuration](#configuration) for every setting.
6. **Run** it with either Docker or systemd:
   - **Docker:**

     ```bash
     docker compose up -d --build
     ```

     The image runs on `node:24-bookworm-slim` as the `node` user. Data lives in the `dashboard-data` volume, mounted at `/data`. If you bind-mount a host directory at `/data` instead, it must be owned by uid 1000 (the `node` user in the image), for example `chown 1000:1000 ./data`.

   - **systemd** (needs Node 22 or later):
     1. Run `npm ci && npm run build` in `/opt/family-dashboard`.
     2. Create a `dashboard` user and the data directory `/var/lib/family-dashboard`, owned by that user.
     3. Install `deploy/family-dashboard.service`, with your env file at `/etc/family-dashboard.env` (set `DATA_DIR=/var/lib/family-dashboard` in it).
7. **nginx**
   - Add the block from `deploy/nginx.conf.example` to your TLS server block, then reload nginx.
   - The app trusts `X-Forwarded-For` (used for rate limiting) only when the connection comes from a loopback or private address. With Docker, nginx reaches the container through the bridge gateway, which is private, so this works.
   - Plaid needs nothing new here. The app sets the Link pages' looser Content-Security-Policy itself, only on those two pages, along with `Cross-Origin-Opener-Policy: same-origin-allow-popups`, and it checks every webhook's signature. That opener policy is there so Link can keep track of the bank's sign-in pop-up on a desktop browser. It's my judgment from how pop-ups and opener policies work, not something Plaid documents, and it hasn't been tried with a real bank yet (it's in the plan's "Verify on first real link" list).
   - Don't limit `/webhooks/plaid` to Plaid's addresses in nginx. Plaid says its list of webhook addresses can change, and a stale list would answer real webhooks with 403, which Plaid doesn't retry. The app already refuses any webhook without a valid signature, and it keeps a budget of key fetches for Plaid's listed addresses that other senders can't use up.

8. **First sign-in**
   - Visit `https://YOUR_HOST` and sign in as the bootstrap admin.
   - On the Admin page, set the family name and time zone, add your family, and turn on their panels.
   - In **Admin → Integrations**, press **Connect Google Calendar**, sign in to the Google account that can make changes to the family calendar, allow both calendar permissions, and pick the calendar. Only calendars that account owns or can make changes to are offered. Any admin can reconnect it, pick another calendar, or disconnect it later.
     - Disconnecting revokes the dashboard's access to that Google account. Google ends every grant the account gave the app when it does, including its consent for signing in here: if that account is also someone's sign-in, Google asks them for consent again next time. Nobody is signed out of the dashboard.
     - Reconnecting with the same Google account, or picking another calendar, never revokes anything. Reconnecting with a *different* Google account replaces the old one, and the dashboard's access is removed from the old account once you pick a calendar, the same as a disconnect.
     - Changes made from the dashboard never email an event's guests: every create, edit, and delete tells Google `sendUpdates=none`. Google warns this can keep a change from reaching a guest whose calendar isn't Google's, so if someone outside the family is invited, change that event in Google Calendar instead.
   - With Todoist set up, each person who wants it links their own account from **Settings → Connect Todoist**. Their open to-dos move into their Todoist Inbox. Admins see everyone's link status on the Admin page, but can't link or unlink for anyone else.
     - **Only the Inbox syncs**, plus chore to-dos. A person's to-do list is the tasks in their Todoist Inbox and their chore to-dos, wherever those are in Todoist (the chores project they picked, or wherever they moved them). Tasks in their other projects, shared ones included, stay in Todoist and never show on the dashboard. Admins see and can edit what's on each person's list: their Inbox tasks and chore to-dos.
     - What the dashboard stores: those tasks, plus the names of every project in the account (for the chores project picker, which only the person themselves sees). The list shows only the project names it uses.
     - This narrows what's stored and shown, not what the app can reach. Todoist has no Inbox-only permission, so the link's OAuth grant still covers the whole Todoist account, and syncs still receive tasks from every project; the server just doesn't keep or show them.
     - Moving a task out of the Inbox in Todoist takes it off the dashboard list. It isn't deleted, from Todoist or as a chore. Moving it back brings it back. Checking off a chore to-do in Todoist completes the chore, whatever project it's in.
     - Upgrading from a version that synced every project: each start removes other projects' tasks from the dashboard's copy (the first start after the upgrade is the one that finds any) and logs how many. Chore to-dos stay, and nothing changes in Todoist.
   - For Spend, open **Spend → Settings**, add each credit card (a nickname, optionally its last 4, and the day its statements usually close), and either import its activity or connect its issuer through Plaid. See [Spend: linking credit cards through Plaid](#spend-linking-credit-cards-through-plaid) and [Spend: importing a credit card CSV](#spend-importing-a-credit-card-csv). For checking, savings, and brokerage accounts, see [Savings: connecting a bank or brokerage](#savings-connecting-a-bank-or-brokerage).

Only people an admin has added can sign in.

## Configuration

Set these in `.env` (Docker) or the systemd env file. An empty value counts as unset.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `BASE_URL` | yes | none | Public origin, such as `https://dashboard.example.com`. Used for OAuth redirects and Origin checks. Must be `https` unless the host is `localhost` or `127.0.0.1`. |
| `SESSION_SECRET` | yes | none | At least 32 characters. |
| `GOOGLE_CLIENT_ID` | yes | none | From your OAuth client. |
| `GOOGLE_CLIENT_SECRET` | yes | none | From your OAuth client. |
| `BOOTSTRAP_ADMIN_EMAIL` | no | none | Becomes the first admin when the database has no users. |
| `HOST` | no | `127.0.0.1` | Bind address. The Docker image sets `0.0.0.0`. |
| `PORT` | no | `3000` | Listen port. |
| `DATA_DIR` | no | `/data` | Holds the SQLite database and `backups/`. The Docker image uses `/data`; `.env.example` uses `./data` for development. |
| `LOG_LEVEL` | no | `info` | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. |
| `NODE_ENV` | no | `production` | Leave as `production` when deployed. |
| `ENABLE_TEST_LOGIN` | no | `false` | `true` or `false`. For end-to-end tests only. It requires `NODE_ENV=test` and a `localhost` `BASE_URL`, so never set it in production. |
| `TODOIST_CLIENT_ID` | no | none | From your Todoist app. Set it and `TODOIST_CLIENT_SECRET` together, or neither. Without them, everything Todoist is hidden. |
| `TODOIST_CLIENT_SECRET` | no | none | From your Todoist app. Also the key Todoist signs webhooks with. |
| `PLAID_CLIENT_ID` | no | none | From your Plaid team. Set it and `PLAID_SECRET` together, or neither. Without them, everything Plaid is hidden and Spend uses CSV imports only. |
| `PLAID_SECRET` | no | none | The team's secret for the environment in `PLAID_ENV`: each environment has its own. Not `PLAID_CLIENT_SECRET`, which isn't read. |
| `PLAID_ENV` | no | `production` | `production` or `sandbox`. The Trial plan uses `production`. |
| `TOKEN_ENCRYPTION_KEY` | yes | none | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts the saved Google Calendar, Todoist, and Plaid sign-ins. Keep a copy outside the server. |
| `TODOIST_API_BASE_URL`, `TODOIST_OAUTH_BASE_URL` | no | Todoist's own | For end-to-end tests only, to point at a fake Todoist. Like `ENABLE_TEST_LOGIN`, they require `NODE_ENV=test` and a `localhost` `BASE_URL`. |
| `GOOGLE_OAUTH_BASE_URL`, `GOOGLE_API_BASE_URL` | no | Google's own | For end-to-end tests only, to point the calendar link and the Calendar API at a fake Google. Same rule as above. Sign-in doesn't use them. |
| `PLAID_API_BASE_URL`, `PLAID_LINK_SCRIPT_URL` | no | Plaid's own | For end-to-end tests only, to point the Plaid API and Link's script at a fake Plaid. Same rule as above. |

## Spend: linking credit cards through Plaid

With Plaid set up (see [Setting up your own instance](#setting-up-your-own-instance)), an admin links each card issuer's login once (your bank, or whoever issues the card), and its cards' transactions and statement dates then arrive on their own. Any issuer Plaid supports works. I use Bank of America, so that's the example below, and it syncs on the Trial plan. Some of what's below still comes from Plaid's docs rather than experience. Plaid's own behavior that I relied on is in `docs/research/plaid-6b.md`.

One thing I learned on a real link: Plaid built Bank of America's initial history in windows of about 99 days and kept only the newest 250 posted transactions in each, so a busy card's history had gaps. Other institutions may behave differently. If yours does too, fill them with a CSV import (below) and use **Remove duplicate**, or sort by amount, to clean up any overlap.

**Connecting a bank and choosing cards**

1. Open **Spend → Settings**. The **Banks** section says how many of the 10 Trial connections this server has used. Removed banks still count, and Plaid's Dashboard homepage has the real number. At 10 it warns that another link will fail while you're on the Trial, but it doesn't stop you.
2. Press **Connect bank**. Plaid Link opens on its own page. Pick your card issuer (Bank of America, say), sign in, and choose which credit cards to share. The dashboard asks Link for credit cards only, but institutions that sign you in on their own pages show their own list of accounts, and Plaid says its filter may not reach that screen, so it can include checking and savings too. Plaid says an account you pick there that isn't a credit card isn't added to Spend, and if you pick only accounts that aren't credit cards, the link fails and Link asks you to try again. (Checking, savings, and brokerage accounts belong in Savings, which has its own Connect button.)
3. Link brings you back to Spend settings with the bank's **Choose cards** open. For each account, pick:
   - **an existing card**, to put the bank's transactions on a card you made for CSV imports. The card with the same last 4 is suggested. Do this for every card with CSV history, so the two meet on one card (below).
   - **New card**, which makes a card named after the bank's name for the account. Like every new card it starts out excluded, so include it in **Cards**.
   - **Skip this account**, to leave it out. Its transactions are dropped. You can attach it later with **Choose cards**, and the bank's whole history is fetched again then.
4. Press **Save cards**. Nothing is synced before that, so closing the tab is fine: **Choose cards** waits in Spend settings. Saving fetches the transactions straight away, up to 24 months back. Plaid can take a minute or more to gather the older history, and the rest arrives on its own. If the first sync takes more than about 40 seconds, the page says "Saved. Syncing in the background." and the sync carries on without you.

If Plaid or the bank has a hiccup right after you link, the bank is kept (the link already used a Trial connection), but its accounts aren't fetched yet. Spend settings then shows **Load accounts** on it instead of **Choose cards**. Press it, and **Choose cards** opens once the accounts are in.

Connecting the same bank login twice is refused before the dashboard asks Plaid for a new connection: it compares the bank and the accounts Link reports with the banks already connected, as Plaid suggests. Plaid's docs imply that a link stopped there doesn't use up a Trial connection, since only connections the dashboard finishes count, but they don't say it outright, so that's unverified. A different login at the same bank (a spouse's cards, say) is fine.

**When CSV history and the bank meet.** Each posted transaction from the bank is compared with the card's imported CSV rows by the same duplicate test the CSV preview uses (same card and amount, dates within 3 days, a similar merchant). A match keeps the bank's transaction, gives it the CSV row's category, person, and note if you set them by hand, and hides the CSV row. Importing that CSV file again doesn't bring the row back, and neither does undoing its import. If the bank later drops its copy without sending it again, the CSV row comes back, with the category, person, and note you set by hand on the bank's copy. Pending transactions never replace a CSV row, since their amount can still change, so a pending one can show beside its CSV twin until it posts.

**Known limitation.** That matching is greedy: it takes the bank's transactions in date order and gives each the nearest CSV row still free. It always gives the same answer, but not always the most matches. For example, two same-amount purchases 4 days apart, each in the CSV and from the bank, can leave one pair unmatched, and then that purchase shows twice. It should be rare, so I've left the smarter matching for later. To fix one by hand, sort the transaction list by amount so the two copies sit together, and press **Remove duplicate** on the CSV copy (admins; it can be undone from the status line).

**Keeping up to date**

- Plaid says it checks a bank for new transactions one to four times a day, depending on the institution, and it tells the dashboard when there's something new, so new transactions usually show up within hours. The dashboard also syncs every bank every 6 hours, in case a notice is missed.
- **Refresh** on a bank gets whatever Plaid has right now. It doesn't make Plaid ask the bank, which is a separate paid call after the Trial. Like the first sync, one that takes more than about 40 seconds carries on in the background, and the page says so.
- Each morning at 06:00 (family time), and when Plaid says they changed, each card's last statement date from the bank becomes a closing date, and the latest one sets the card's usual closing day. A date 15 days or less from one you entered by hand is skipped: yours wins. A new date from the bank 15 days or less from an earlier one it sent for that card (the bank moved it by a day, say) moves that closing date rather than adding a second one. If your issuer doesn't send statement dates, the usual closing day keeps working as before.
- A pending transaction that posts keeps the category, person, and note you gave it. So does one the bank changes enough that Plaid sends it again under a new id.
- If a sync replaces a transaction while you have unsaved changes on it in the drill-down (a pending one posts, or the bank's copy replaces a CSV row), **Save** saves nothing, moves your changes to the transaction that took its place, and says so. Check them and save again. If the new transaction holds a different value from the one you saw, that Save says so, as when someone else changes a transaction.
- Plaid's category for a transaction goes through **Bank categories** in Spend settings, after your rules. Change as many codes' categories there as you like, then press **Save** once for all of them; **Discard changes** drops them, and leaving the page with changes asks first. A detailed code can also go back to its main category's (the first choice in its list). Saved changes apply from then on, and to past transactions with **Apply to past transactions**. If someone else changed a code while you were editing, Save saves nothing and says which one; check it and save again.
- The home card and the drill-down say when each linked card last updated: the later of the bank's last completed sync and the card's last CSV import. They warn when that's over 12 hours ago. Reading statement dates doesn't count, since it brings no transactions.

**Reconnecting**

- When the bank needs you to sign in again, the bank's status in Spend settings says so, and so does each of its cards on the home card, with a **Reconnect** link for admins. Reconnect opens Link for the same connection, so it shouldn't use a Trial connection (Plaid's docs imply this but don't say it outright).
- Plaid's notices can arrive late or out of order, so when one says the bank needs you to sign in again, the dashboard asks Plaid first, and only shows it if Plaid still says so. Each morning at 06:00 it also asks again about every bank waiting for a reconnect, and clears the state if Plaid says the login works again (not when access was turned off at the bank, below).
- If access was turned off at the bank's end, Spend settings offers both **Reconnect** and removing the bank and connecting it again, since Plaid says reconnecting may not work then.
- If you untick a card while reconnecting, it keeps its history, and Spend settings says the bank didn't share it.
- When Plaid says the login has new accounts, or a sync gets transactions for an account the dashboard doesn't know, Spend settings offers **Load accounts** first, which picks up any account the login already shares, and **Add accounts**, which reconnects with the account list open. New accounts then wait in **Choose cards**. Those transactions aren't lost meanwhile: attaching the account fetches the bank's whole history again.
- If the bank gives a card's account a new number (a reissued card, say), after **Load accounts** or a reconnect the old one shows as a card the bank didn't share, and the new one waits in **Choose cards**. Put it on the old card (it's suggested when the last 4 match): the card moves to the new account, and its history isn't doubled, since the new account's transactions replace the old account's copies.
- Some institutions' consent expires (Bank of America's lasts 12 months). About a week before it ends, Spend settings says "Reconnect before" the date.
- If a bank says "This bank connection no longer works at Plaid", Reconnect can't fix it: remove the bank and connect it again.

**Removing a bank**

1. Press **Remove** on the bank. The dashboard ends its connection at Plaid and stops syncing. Its cards stay, marked "bank connection removed", with their transactions, unless you tick **Also delete its transactions**. Its pending transactions go either way, since the bank will never post them now. Once you press **Remove bank** it can't be cancelled, since Plaid may already have ended the access; it can take up to a minute while Plaid confirms. If the page loses touch with the server meanwhile, it checks the bank list and says whether the bank now shows as removed.
2. **Also delete its transactions** deletes only the transactions that came from this bank connection. The rows they had replaced come back: CSV rows, or an earlier connection's posted transactions, each with the category, person, and note set by hand on the bank's copy. CSV rows from an import you undid don't come back, unless you imported that file again. In Spend settings, a bank removed this way says so, rather than saying its cards kept their history.
3. If the bank is in the middle of a long sync, Remove waits up to about 40 seconds, then says "That bank is busy syncing. Try again in a minute." Nothing is removed then. Finishing a reconnect can say the same; reconnect again in a minute. If Plaid is just slow to confirm the removal, the bank is removed anyway, the page says Plaid didn't confirm it yet, and the dashboard keeps asking Plaid (step 6).
4. Removing a bank doesn't give back a Trial connection.
5. **Also remove the dashboard in the institution's own connected apps settings**, if it has them (Bank of America does). Plaid says some institutions keep listing a removed connection there.
6. If Plaid doesn't confirm the removal, the dashboard tries again every hour, 12 times, then gives up with a notice naming the bank, in Spend settings and on the System page. Remove the dashboard at the bank, or at my.plaid.com, then dismiss the notice in Spend settings or on the System page.

Linking a removed bank again doesn't double its history. Plaid sends the history again under new ids, and when you attach its accounts to the same cards, those transactions replace the old connection's copies, carrying over what you set by hand, the same way they replace CSV rows.

Admin → Integrations lists each bank's status, with a link to Spend settings, where banks are managed.

**Tightening the Link pages' security policy**

The two Link pages run Plaid's script, so they get a looser Content-Security-Policy than the rest of the app. Beside it they send a narrower `Content-Security-Policy-Report-Only`, which blocks nothing but reports what it would have blocked to `/csp-report`. Each report becomes one `csp report` log line with only the directive, the blocked address's origin (or `inline`, `eval`, `data`), and the page's path. `/csp-report` takes at most 20 reports a minute from one address and 200 in all, and ignores bodies over 16 KiB.

To see whether the real policy can be narrowed:

1. Connect or reconnect a bank all the way through, OAuth pages included, on a desktop browser and a phone.
2. Look for `csp report` in the logs (`docker compose logs dashboard | grep "csp report"`, or `journalctl -u family-dashboard | grep "csp report"`).
3. No lines means the narrower policy would have worked. Today the only difference is that it drops `cdn.plaid.com` from `default-src`, so you can drop it from `defaultSrc` in `plaidLinkHeaders` (`src/server/integrations/plaid/routes.ts`) too.
4. A line names the directive that would have blocked something and the origin it came from. Keep that source in the real policy. If it's a new source Plaid needs, add it to the report-only policy as well, so the next link is clean.
5. To try a narrower step, change only `contentSecurityPolicyReportOnly` in `plaidLinkHeaders`, deploy, and link again. Move a change into `contentSecurityPolicy` only after a whole link reports nothing.

## Savings: connecting a bank or brokerage

The Savings panel shows the family's checking, savings, cash management, and brokerage accounts as summary numbers: each account's balance at the start of the month, the money put in and taken out, the market (or other) change, the balance now, past months, and a six-month graph of the total. It keeps balances and the dates and amounts of money moving in and out, never the transactions themselves, merchant names, or holdings. Any bank or brokerage Plaid supports works; I use a Fidelity cash management account and brokerage, so Fidelity is the example below. Whether Plaid gives your brokerage its deposits and withdrawals depends on Investments (below); if it doesn't, a CSV import fills them in.

**Before you connect**

- Only the Plaid team's owner can do this part. In Plaid's Dashboard, check that **Investments** is enabled for production, and request it if it isn't. That's what gives the brokerage its deposits and withdrawals. Plaid doesn't publish which products every institution supports, so for a brokerage it's worth checking in the Dashboard that it offers Investments (and Transactions, for a cash account).
- Each bank or brokerage login uses one of the 10 Trial connections, the same count Spend uses. Some institutions' consent expires (Fidelity's lasts 12 months), so **Reconnect** comes around once a year for those.

**Connecting**

1. Turn the **Savings** panel on for the people who should see it (Admin, panel access). On an existing install it's off for everyone, admins included, until you do. Anyone with the panel sees the numbers; only admins see **Settings**.
2. Open **Savings → Settings** and press **Connect an account**. Plaid Link opens on its own page and offers checking, savings, cash management, and investment accounts only. Pick your bank or brokerage (Fidelity, say) and sign in. Connect each institution separately.
3. Back in Savings settings, choose which accounts to show and give each a nickname (up to 40 characters), then press **Save accounts**. An account you don't show isn't stored or fetched, and you can show it later with **Choose accounts**. Saving reads the first balances right away.
4. The first month starts from that first balance ("Since <date>"), so deposits and withdrawals count from the next day. Plaid has no past balances, so the graph starts on the day you link and fills in over six months.

**What Investments means here**

A checking, savings, or cash management account's deposits and withdrawals come from Plaid's Transactions product. The brokerage's come from Plaid's Investments product: cash deposits, contributions, withdrawals, and cash transfers. Dividends, interest, fees, buys, and sells aren't money put in or taken out, so they land in **Market change**. If Investments isn't available for the connection, Savings settings says why under it:

- "Investments isn't enabled for this Plaid account." The team's owner turns it on in the Plaid Dashboard. Nothing else changes: the next sync picks it up.
- The institution didn't share investment activity. Removing the connection and connecting again, allowing investments when the institution asks, may fix it.
- Couldn't read the brokerage's activity this time. A passing hiccup; the next sync tries again.

Until it works, the brokerage shows Start, Now, and the month's total change, with "Not available" for deposits and withdrawals.

**Keeping up to date**

- Savings updates every morning at 05:30 (family time), when Plaid says there's something new, and when you press **Refresh**. Plaid's balances are its cached ones (free, at least daily), so **Now** can lag the market by up to a day; each balance shows when it was read. The home card warns once the balances are more than a day old.
- **Hide** takes an account off the panel without stopping its sync, so showing it again leaves no gap. **Rename** changes its nickname.
- **Remove** ends the connection at Plaid, as for a bank. Its accounts keep their past months, marked "Connection removed", unless you tick **Also delete its data**, which deletes every balance, deposit, and withdrawal it kept. Removing doesn't give back a Trial connection, and connecting the institution again starts its numbers over from the new link.

## Savings: importing CSVs and adding accounts by hand

Plaid has no past balances, it may not give everything you want from your institution, and you may not use Plaid at all. Any bank's or brokerage's CSV export fills that in, and accounts you can't connect can be added by hand. Everything here is in **Savings → Settings**, for admins.

**Adding an account by hand.** Under **Accounts added by hand**, give it a nickname and pick Cash or Investment. A hand-added account has no Plaid link: you keep it current by importing its CSV, or with **Set balance** (an amount as of today or a past date; negative is fine for an overdrawn account). Set balance never overwrites a day Plaid has a balance for.

**Importing a CSV.** Press **Import a CSV** on an account and choose the file.

1. **Columns.** The importer finds the table in the file on its own (it skips preamble lines and footer text), then shows the column names and the first 8 rows. Pick which column is the **date**, the **amount** (one signed column, with a switch for banks where money in is negative, or separate **debit** and **credit** columns), an optional **running balance**, and an optional **description**. If every day in the file is 12 or under, it can't tell month-first from day-first and asks you. For a cash account the balance column becomes daily balances, which fills in the graph and past months right away. For an investment account, say whether it's the account's whole value; usually it isn't (Fidelity's "Cash Balance" is uninvested cash only), and then it's ignored.
2. **What rows mean.** Rows are grouped by the first two words of their description ("DIRECT DEPOSIT", "YOU SOLD", "INTEREST EARNED"). For each group, choose **Deposit**, **Withdrawal**, **By sign**, or **Not counted** (interest, dividends, trades, and fees, which land in Other or Market change). Sensible defaults are picked, and groups you haven't seen before are marked **New**.
3. **Results.** The date range, what it will add, and what's already there. Then **Import**.

Your column and group choices are saved on the account. The next file with the same columns goes straight to the results, unless it has a description wording you haven't decided on yet. Any institution's CSV works through these steps. A few formats are also **built in**, so their files skip the first two steps: today that's Fidelity's "History for Account" exports (cash management and brokerage). Built-in formats live in `src/server/panels/savings/importFormats.ts`, and adding one for another institution is a small, self-contained change.

Details:

- Only the date, amount, and deposit or withdrawal are stored for each row. Descriptions aren't, and nothing from the file is logged. The parsed rows are held for an hour while you work through the steps, then forgotten; closing the steps forgets them at once.
- Re-importing an overlapping file adds only the new rows, two identical charges on the same day included. When Plaid later reports a deposit or withdrawal you imported, Plaid's copy replaces it, and a Plaid balance always wins for its day.
- **Undo** on an import deletes exactly what it added. If a later import skipped rows because this one had them, it asks first.
- Interest counts as Other change, not as a deposit, whether it comes from a CSV or from Plaid.
- Files can be up to 5 MB, 20,000 rows, and 200 columns, in UTF-8. Decimal commas and dates with times aren't read; the file is refused with the line number.

## Spend: importing a credit card CSV

Without Plaid, Spend gets its transactions from CSV files an admin downloads from the card issuer and imports. With Plaid, CSV files bring in history from before the card was linked, or fill gaps in what Plaid sent.

**Today Spend reads one format, Bank of America's credit card export.** Cards from other issuers come in through Plaid. Spend's importer checks for that one header, unlike the Savings importer, which maps any file's columns; adding another issuer's format means adding a parser alongside `src/server/panels/spend/bofa.ts`. Contributions welcome.

For Bank of America (the bank doesn't document the file, so the format comes from other people's importers; see `docs/research/spend-plaid-csv.md` §1):

1. Sign in to Bank of America's website and open the credit card's account activity.
2. Choose **Download**, pick the **Transaction Period** (or the statement) you want, and pick **Microsoft Excel Format**. That gives a `.csv` file, whose name may end in the card's last 4 (such as `April2026_1234.csv`). Bank of America offers about 12 months of activity this way.
3. In the dashboard, open **Spend → Settings → Import a CSV**, pick the card, choose the file, and press **Preview**.
4. Check the preview: how many rows there are, the dates they cover, any possible duplicates (see below), and rows that can't be imported, with why (for example a row that's already imported, or a temporary credit that hasn't posted yet). Then press **Import**.

Details:

- Only the credit-card activity file works. The checking and savings export is refused with a message saying so, and so is any file whose first line isn't `Posted Date,Reference Number,Payee,Address,Amount`.
- Files can be up to 5 MB and 20,000 rows. The nginx example sets `client_max_body_size 6m`, a little more than the file limit, because nginx counts the whole upload. That way a file over 5 MB gets the dashboard's "The limit is 5 MB" message, not an error page from nginx. Real exports are far smaller.
- Importing the same file again, or a file that overlaps an earlier one, skips every row whose reference number is already stored. Those rows show as "Already imported".
- **Possible duplicates.** A row with a new reference number that otherwise looks like a stored transaction (the same card and amount, posted within 3 days, and a similar merchant) is still a new transaction, because Bank of America numbered it differently. The preview marks it "Possible duplicate (different reference number)" and names the stored transaction it looks like. Each stored transaction is named for at most one row. A few of these are normal, like two tolls a day apart, and they start ticked. When they're more than half of the file's new rows, the bank has probably renumbered transactions you already have, so they start unticked and the preview says why. Tick only the ones that are really new.
- A row that looks like a stored transaction with no reference number, which means one from the bank through Plaid, is listed as "Looks like one already here" and left out unless you tick it. Without Plaid that can't happen: every stored transaction comes from a CSV and has a reference number.
- **Undoing an import.** In **Spend → Settings → Cards**, press **Imports** on the card to see its recent imports, and **Undo this import** on one. It asks first, then deletes that import's transactions, so the right file can be imported again. It's refused if any of them has a category, person, or note set by hand, and says how many: undo those changes first. Rows a bank transaction already replaced aren't deleted or counted: they stay hidden, so importing the file again still skips them.
- Rules are applied to imported rows. The dashboard starts with one rule that puts credits whose payee contains `PAYMENT` in **Payments and transfers**, so card payments don't count as refunds. Bank of America's exact wording for payments isn't verified; change the rule if it doesn't catch yours.
- A preview lasts an hour and is never the file itself, only the rows read from it. Nothing from the file is written to the logs.
- Give each card its usual closing day, or the drill-down groups spending by calendar month. Closing dates for past statements can be added by hand in **Closing dates**, if the bank's differ.

## Backups

- The app writes a nightly copy to `DATA_DIR/backups/dashboard-YYYY-MM-DD.db` and keeps 14.
- Copy that folder off the server.
- Backups contain your data unencrypted, card transactions included, so store them somewhere private.
- **Restoring a backup means everyone reconnects Todoist.** Todoist's refresh tokens change every hour or so, and a backup holds old ones that Todoist no longer accepts. After a restore, each linked person sees a Reconnect prompt.
- A restore brings back the Google Calendar link as it was when the backup was taken. Whether it still works depends on Google still accepting that refresh token, which I haven't verified: if the calendar was disconnected since, its token was revoked, and if it was reconnected since, Google may have replaced the token. If it no longer works, the Integrations section says it needs reconnecting, and an admin connects it again.
- Backups hold the calendar's last fetched events (`calendar_cache`), as well as everything else.
- A restore brings back the bank links as they were when the backup was taken. Plaid's access tokens don't expire, so those keep working, and each bank syncs again from where it was then (I haven't verified that Plaid accepts an older sync position). A bank linked after the backup is still active at Plaid, but the restored dashboard doesn't know it: remove the dashboard for that login at the bank or at my.plaid.com, and link it again. A bank removed after the backup comes back in Spend settings but won't work, because removing it ended its connection at Plaid: once a sync fails, it says to remove it and connect it again. Remove it again (that's safe: Plaid already has no such connection), and link it again if you still want it. The Trial count goes back too, so check Plaid's Dashboard homepage for the real one.

## Turning Todoist off, or rolling back

Turning Todoist off (removing its settings) or rolling back to a version without it is only clean before anyone links Todoist. Once someone links, their to-dos live in Todoist, and the dashboard can only show them while Todoist is configured.

If you turn it off after people have linked, the app still starts, but their to-do lists look empty. The System section of the Admin page says how many people are affected, and the app logs an error at startup. Nothing is deleted: configure Todoist again and their lists come back.

To turn it off for good after people have linked, do one of these first:

- Have everyone disconnect Todoist in Settings. The open tasks in their Inbox, and their chore to-dos, become dashboard to-dos.
- Or restore the backup taken before the deploy that added Todoist. Anything changed since then is lost.

## Turning Plaid off, or rolling back

Turning Plaid off (removing `PLAID_CLIENT_ID` and `PLAID_SECRET`) after a bank is linked doesn't lose anything, but nothing syncs. The bank controls disappear, the Plaid pages and `/webhooks/plaid` answer 404, and Plaid gives up on its webhooks, since it doesn't retry a 404. The bank connections stay, as do their cards, transactions, and statement dates, and the home card soon says each linked card hasn't synced in over 12 hours. Put the settings back and restart, and each bank picks up where it stopped at the next 6-hourly sync, or at once with **Refresh**.

Rolling back to a version without Plaid is the same: the Plaid migration only added a table and columns, so an older version runs on the same database and leaves them alone. Transactions from the bank still show, and CSV rows they replaced stay hidden. I haven't run an older version against a database with linked banks, though.

Either way, the connections stay active at Plaid. And if the encryption key is ever lost while those logins are saved, **Reset links for a new key** refuses to run until Plaid is set up again. To stop for good, remove each connection in Spend and Savings settings first (and in each institution's own connected apps settings, if it has them), then take the settings out. Removing doesn't give back Trial connections.

## Development

Requires Node 22 or later.

```bash
npm install
cp .env.example .env           # BASE_URL=http://localhost:5173, DATA_DIR=./data
npm run dev:server             # API on :3000
npm run dev:web                # UI on :5173, proxying /api and /auth
npm test                       # unit and integration tests
npm run test:e2e               # Playwright smoke tests (resets e2e/.data itself)
```

For local Google sign-in, add `http://localhost:5173/auth/google/callback` as a redirect URI on your OAuth client.

For a local calendar link, also add `http://localhost:5173/connect/google-calendar/callback`.

If your dev install uses the same `GOOGLE_CLIENT_ID` as production, don't link the family's Google account there, and never disconnect a calendar there that's linked to an account production uses. Revoking ends every grant that account gave the whole Google project, for every OAuth client in it, so disconnecting in dev would also cut off production's calendar link (and that account's sign-in consent). A second OAuth client in the same project doesn't avoid this; a separate Google Cloud project for development does.

Don't link banks from a dev install with the production secret: each link uses one of the 10 Trial connections, for good. Sandbox has its own secret (`PLAID_ENV=sandbox`). I haven't tried linking a bank from a dev install.

The end-to-end tests run against a fake Google (`src/server/test/fakeGoogleCalendarServer.ts`, port 3102), a fake Todoist (`src/server/test/fakeTodoistServer.ts`), which Playwright starts on port 3101, and a fake Plaid (`src/server/test/fakePlaidServer.ts`, port 3103) with its own stand-in for Link's script. The bank tests run one at a time in the `spend` project, with the other Spend tests, since they share the family's categories and rules. The calendar tests share the one family calendar link, so they run one at a time in their own `calendar` project. To link a real Todoist account during development, use a separate Todoist app whose redirect URL is `http://localhost:5173/connect/todoist/callback`, if the console accepts it (Todoist's docs don't say whether console apps allow `http://localhost`). Webhooks can't reach a laptop, so local syncs come from the drill-down and the 10-minute job.
