# Family Dashboard — Design Specification

- **Status:** Draft for review
- **Date:** 2026-11-15

---

## 1. Overview

The Family Dashboard is a self-hosted web app for a single family. Its home page shows one summary card for each panel the signed-in person can access, and tapping a card opens a detailed drill-down view.

The v1 panels are **Calendar**, **To-do**, **Chores**, and **Spend**, and a later **Savings** panel (§21). The app integrates with three services:

- Google Calendar
- Todoist
- Bank of America credit cards, and for Savings Fidelity cash management and brokerage accounts, through Plaid

The examples in this spec use a family of three:

- Alex, admin
- Jordan, admin
- Riley, member

Nothing in the app is specific to them. Any family can run its own instance with its own Google, Todoist, and Plaid credentials.

### 1.1 Principles

- **One instance per family.** The app is never multi-tenant, and no family or tenant ID appears anywhere in the data model.
- **Manual provisioning.** Only admins create users, and there is no sign-up.
- **The server is the authority on permissions.** When the browser hides something, that is only cosmetic.
- **Linked services are the source of truth.** When a service is linked, the local database is a cache or mirror of it. The database is also the home of data that exists only internally.
- **Small and easy to self-host.** One process, one SQLite file, one container.

### 1.2 Non-goals (v1)

- A shared kiosk or wall-display mode with no person signed in
- Push or email notifications, and reminders
- Native mobile apps and offline mode
- Budgets or targets for spending categories
- Chore rotation, parental approval of chores, points or allowance, and streaks
- Personal calendar overlays, and linking more than one calendar
- Read-only panel access, and limiting which cards each user's Spend panel shows
- Self-service sign-up, and more than one family per instance
- Deleting users (deactivate them instead, so history stays intact)

---

## 2. Users and roles

- **User fields:**
  - Email address, which must be a Google account
  - Display name
  - Color, used for avatars and tags
  - Role
  - Active flag
  - Bound Google account ID (see §4)
- **Roles:** `admin` and `member`.
  - Any number of admins is allowed.
  - The system refuses to demote or deactivate the last active admin.
- **What admins can do:** everything in §5 (Administration), plus the admin-only actions noted in each panel's section.
- **Deactivating a user:**
  - Ends their sessions and blocks login.
  - Unlinks their Todoist account (converting their to-dos to internal ones) and revokes its token, after their chore to-dos have been removed.
  - Removes them from assignment pickers.
  - Puts their chores back on the chore board, unassigned (§11.4).
  - Keeps their past data, which still shows their name: chore history, transaction person assignments, and calendar event attribution.

---

## 3. Architecture

### 3.1 Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 24 LTS, TypeScript (strict) |
| HTTP server | Hono on `@hono/node-server` |
| Frontend | React 19 single-page app built with Vite. TanStack Router for routing and TanStack Query for data fetching and caching |
| Validation and shared types | zod schemas in a shared module used by server and client |
| Database | SQLite via `better-sqlite3`, with Drizzle ORM and Drizzle migrations, in WAL mode |
| Scheduler | In-process (`croner`) |
| Google | Calendar API v3 over plain `fetch`, with OpenID Connect and OAuth (sign-in, the calendar link's code grant and refresh) via `openid-client`. No `googleapis` or `google-auth-library` (docs/research/google-calendar-v3.md §9) |
| Todoist | Todoist API v1 (REST plus `/sync`) |
| Plaid | Plaid's API over plain `fetch`, pinned to version `2020-09-14`, with `jose` to verify webhook signatures. No `plaid` SDK (docs/research/plaid-6b.md §10). Plaid Link in the browser, loaded from `cdn.plaid.com` on two pages the server sends with their own CSP (§15) |
| Logging | `pino`, writing JSON lines to stdout |
| Tests | Vitest, Playwright |

### 3.2 Process model

One Node process serves all of the following:

- `/api/*`: the JSON API
- `/auth/*`: sign-in, sign-out, and the Google login callback
- `/connect/*`: OAuth flows for integrations
- `/webhooks/*`: Plaid and Todoist webhooks
- `/healthz`: health check
- Everything else: static files for the single-page app, falling back to `index.html`

Background jobs run in the same process (§3.5). Every job can safely run more than once with the same result. Only one copy of the app runs against a given database, so there is no clustering.

### 3.3 Code layout and module boundaries

```
src/
  shared/              zod schemas and types shared by server and web
  server/
    app.ts             Hono app wiring
    db/                Drizzle schema, migrations, backup
    auth/              Google sign-in, sessions, CSRF protection
    admin/             users, panel grants, family settings
    core/              Clock, event bus, token encryption, per-key lock, job scheduler
    integrations/
      connections.ts   the connections table: encrypted credentials and status (§8)
      google/          OAuth and the CalendarProvider implementation
      todoist/         OAuth, Todoist client, sync and mirror, webhook verifier
      plaid/           the Plaid client, Link tokens and Items, the Link pages and webhook route, webhook verifier
    panels/
      calendar/        routes and service
      todo/            routes and TodoService (internal and Todoist backends)
      chores/          routes, generator, occurrence service
      spend/           routes, Plaid sync and banks, billing cycles, categorization, CSV import
      savings/         routes, Plaid sync, the month and graph numbers, settings (§21)
  web/
    shell/             layout, sign-in gate, routing, freshness
    panels/<id>/       SummaryCard, DrillDown, components
    admin/
    settings/
```

Rules for the boundaries between modules:

- **Panels never call external APIs directly.** They go through provider interfaces: `CalendarProvider` and `TodoBackend`, each with a real implementation and an in-memory fake used in tests. Spend reaches Plaid only through the `Plaid` integration (`integrations/plaid/`), which holds the access tokens; tests give it an in-memory fake Plaid as its `fetch`.
- **Chores never talk to Todoist.**
  - Chores call `TodoService` to create or remove a to-do for a user.
  - Chores subscribe to `TodoService` events (`todo.completed`, `todo.uncompleted`, `todo.deleted`) on an in-process event bus.
  - `TodoService` decides, per user, whether to use the internal backend or the Todoist backend.
- **Time comes from an injectable `Clock`.** All logic that depends on "today" uses the family time zone from settings.

### 3.4 Configuration

Each instance is configured through environment variables.

| Variable | Required | Purpose |
|---|---|---|
| `BASE_URL` | yes | Public origin, e.g. `https://dashboard.example.com`. Used for OAuth redirect URIs, webhook URLs, and Origin checks |
| `HOST` / `PORT` | no (`127.0.0.1` / `3000`) | Listen address |
| `DATA_DIR` | no (`/data`) | Location of the SQLite database and backups |
| `SESSION_SECRET` | yes | HMAC key for cookies and OAuth `state` values |
| `TOKEN_ENCRYPTION_KEY` | yes | 32-byte base64 key for AES-256-GCM encryption of stored credentials. Always required: Google Calendar can be linked on every instance, since it uses the Google client every instance has |
| `BOOTSTRAP_ADMIN_EMAIL` | on first run | Becomes the first admin when the users table is empty |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | yes | Google sign-in and Calendar |
| `TODOIST_CLIENT_ID` / `TODOIST_CLIENT_SECRET` | no | Enables Todoist linking. Both or neither. If unset, every Todoist control is hidden and the Todoist routes return 404 |
| `TODOIST_API_BASE_URL` / `TODOIST_OAUTH_BASE_URL` | no | Test only: point the Todoist client at a fake. Startup is refused unless `NODE_ENV=test` and `BASE_URL` is localhost, the same rule as test sign-in (§16) |
| `GOOGLE_OAUTH_BASE_URL` / `GOOGLE_API_BASE_URL` | no | Test only: point the calendar link (consent page, token, revocation) and the Calendar API at a fake. Both or neither, same rule as above. Sign-in doesn't use them |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` | no | Enables bank linking. Both or neither. If unset, Spend works with CSV import only, every Plaid control is hidden, and the `/connect/plaid/*`, `/webhooks/plaid`, and Spend bank routes return 404. `PLAID_CLIENT_SECRET` isn't read (no alias): with `PLAID_CLIENT_ID` set and no `PLAID_SECRET`, startup is refused, and if `PLAID_CLIENT_SECRET` is set the message says to rename it |
| `PLAID_ENV` | no (`production`) | `sandbox` or `production`: which Plaid API host is used. The Plaid Trial plan uses `production`. Each environment has its own secret, so `PLAID_SECRET` must be the one for `PLAID_ENV`; startup can't check the pair |
| `PLAID_API_BASE_URL` / `PLAID_LINK_SCRIPT_URL` | no | Test only: point the Plaid API and Link's script at a fake. Same rule as the other test-only URLs |
| `LOG_LEVEL` | no (`info`) | Log verbosity |

**Proxy trust:** there is no `TRUST_PROXY` setting. The app trusts `X-Forwarded-For` only when the socket peer is a loopback or private address. The app must therefore be reachable only through the reverse proxy, never directly from an untrusted network.

Two settings are stored in the database and edited on the admin page:

- **Family name**
- **Family time zone** (IANA name). It defaults to the server's time zone when the first admin is created.

### 3.5 Background jobs

| Job | Schedule | Purpose |
|---|---|---|
| `chores.generate` | Every 15 min, plus 00:00 family time | Give assigned chores their next occurrence once it comes due (§11.3) |
| `todo.todoistSync` | On webhook, plus every 10 min for each linked user | Incremental Todoist `/sync` (§10.6) |
| `todo.retryPending` | Every 5 min | Retry failed attempts to put chores on Todoist (§11.5) |
| `calendar.refreshSummary` | Every 5 min, starting up to 75 s late (±25%, as Google's quota guide asks) | Refresh the cached 7-day window (§9.2); prune cached windows nobody fetched for 7 days, and calendar picks nobody finished |
| `calendar.revocations` | Hourly | Revoke a disconnected calendar's token that Google didn't confirm revoking; gives up after 12 tries with a job error and a lasting System warning naming the account (§9.1) |
| `spend.transactionsSync` | Every 6 h, starting up to 30 min late | `/transactions/sync` for each Spend Item, as the backup to webhooks, which sync an Item in the background as they arrive (§12.3). Skips Items waiting for the pick, needing a reconnect, or in backoff. With Plaid configured |
| `spend.statementsSync` | Daily 06:00 family time | `/liabilities/get` once per Spend Item, recording closing dates (§12.4). First, `/item/get` for each Spend Item that needs reconnecting, clearing the state when Plaid reports no error (§12.3). With Plaid configured |
| `savings.sync` | Daily 05:30 family time | Balances and flows for each Savings Item, checking one that needs reconnecting with `/item/get` first and not syncing it again when the check already did (§21.4). With Plaid configured |
| `spend.pruneRemoved` | Daily 04:15 family time | Hard-delete transactions Plaid removed more than 7 days ago (§12.3), and Link sessions nobody finished. Runs without Plaid too, so rows removed while it was configured still age out |
| `spend.plaidRevocations` | Hourly | `/item/remove` again for a removed bank Plaid didn't confirm removing; gives up after 12 tries with a job error and a lasting notice naming the bank (§12.2). With Plaid configured |
| `spend.pruneImports` | Every 15 min | Delete CSV import previews older than an hour (§12.13) |
| `db.backup` | Daily 03:00 family time | Database backup (§3.7) |
| `sessions.cleanup` | Daily | Delete expired sessions |

A Plaid job run in which some Items failed ends in one job error counting them; each bank's status in Spend settings (or each connection's in Savings settings) says which. Failure handling for jobs is in §14.

### 3.6 Deployment

- **Docker image:** a multi-stage build that runs as a non-root user and stores data in a `/data` volume. The repo includes an example `compose.yaml`.
- **Bare alternative:** `npm ci && npm run build && node dist/server/index.js` under systemd. The repo includes an example unit file.
- **Reverse proxy:** nginx terminates TLS in front of the app. The README includes an example `location` block that:
  - proxies to `127.0.0.1:3000`
  - passes `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto`
  - sets `client_max_body_size 5m` for CSV uploads
- **Health check:** `/healthz` returns 200 after checking the database. The container health check uses it.

### 3.7 Backups

- Every night, the app makes an online SQLite backup to `DATA_DIR/backups/dashboard-YYYY-MM-DD.db` and keeps the 14 most recent.
- `TOKEN_ENCRYPTION_KEY` is **not** stored in the database. The README tells operators to store it separately, for example in a password manager. Losing the key means re-linking every integration (see §14), but no data is lost.
- The database and backup files are readable only by the app's user (mode 600). The README warns that backups contain transaction data unencrypted.

---

## 4. Authentication and sessions

- **Sign-in:** Google OpenID Connect, using the authorization-code flow with PKCE, `state`, and `nonce`. The only scopes requested are `openid email profile`.
- **On callback:** Google must report `email_verified=true`. The app then looks up the user:
  1. By the bound Google account ID (`sub`), if one is bound.
  2. Otherwise, by email (case-insensitive) among users with no bound ID. On a match, the app binds this Google account ID to the user.
  3. If the email matches a user bound to a **different** Google account ID, sign-in is rejected.
  4. If there's no match, or the user is inactive, the person sees "You're not set up yet. Ask your admin." Nothing is created.
- **Changing a user's email** clears their Google account binding and ends their sessions, since the old Google account opened them. An admin changing their own email keeps the session they're using, so a typo can't lock them out; their other sessions end. They bind again at their next sign-in. Admin asks first, as for deactivating. A change only in letter case or surrounding spaces isn't a change.
- **Sessions:**
  - The session ID is a random 256-bit value. The `sessions` table stores it hashed.
  - The cookie is `__Host-session` with `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`.
  - Sessions last 30 days, extended when used (at most once an hour).
  - Signing out deletes the session. Deactivating a user deletes all of their sessions.
- **Bootstrap:** at startup, if the `users` table is empty and `BOOTSTRAP_ADMIN_EMAIL` is set, the app creates that user as an admin. The display name defaults to the part of the email before the `@`. The bootstrap admin is granted every panel. This is a deliberate exception to "admins need grants", so the first sign-in shows something.

---

## 5. Administration

Admins have an admin page at `/admin` with these sections:

- **Users:**
  - The user list shows each user's last sign-in.
  - Add a user with email, display name, color, role, and initial panel access. New users have no panels unless some are checked.
  - Edit, deactivate, or reactivate a user.
- **Panel access:** a grid of users against panels, with an on/off switch in each cell.
- **Integrations:**
  - Google Calendar: connect, reconnect, change calendar, or disconnect.
  - Bank connections through Plaid: each bank's or Savings connection's status, with a link to Spend settings or Savings settings, where they're connected, reconnected, refreshed, and removed, and the Trial count is shown (§12.2, §12.12, §21.3).
  - The status and last sync time of every connection, including each user's Todoist link. Admins can see Todoist status but can't link Todoist on someone else's behalf.
- **Family settings:** family name and time zone.
- **System:**
  - The 50 most recent job errors
  - Chore to-do changes that hit the retry cap (§11.5), with Retry and Dismiss
  - Warnings, such as a mismatched `TOKEN_ENCRYPTION_KEY` (§14), and bank removals Plaid never confirmed, each naming the bank, with Dismiss (§12.2)
  - App version
  - Time of the last backup

Some settings live inside panel drill-downs instead: Spend settings (§12.12), Savings settings (§21.3), and chore definitions (§11.9).

---

## 6. Panel framework and permissions

- **Registry:** panels are registered in code as `calendar`, `todo`, `chores`, `spend`, and `savings` (§21). Each panel provides:
  - An ID and a display name
  - A server router mounted at `/api/panels/<id>`
  - Its background jobs
  - A `SummaryCard` and a `DrillDown` component
- **Grants:** a row in `panel_grants(user_id, panel_id)` means the user has that panel.
- **Enforcement:**
  - Middleware on `/api/panels/<id>/*` returns 401 when there's no session and 403 when the user has no grant for the panel.
  - Admin-only endpoints within a panel also require the admin role.
- **Admins need grants too.** Admins don't get panels automatically. They can turn their own panels on in the panel-access grid.
- **`GET /api/me`** returns the user, their role, and their granted panels. The client renders cards only for those panels.
- **Effects across panels respect grants.** For example, a chore creates a to-do only if the assignee has the To-do panel (§11.5).
- **Access is on/off only.** Within a panel, every member has the same capabilities. Admins get the extra capabilities listed in each panel's section.

---

## 7. UI shell

- **Home (`/`):**
  - A header with the family name, today's date, a gear icon for admins (opens `/admin`), and an avatar menu with personal settings and sign out.
  - Below the header, one summary card per granted panel, always in the order Calendar, To-do, Chores, Spend, Savings.
- **Layout:** a CSS grid with `repeat(auto-fit, minmax(300px, 1fr))`. That gives one column on phones, two on laptops, and up to four on wide screens.
- **Drill-down:**
  - Tapping a card opens `/calendar`, `/todo`, `/chores`, `/spend`, or `/savings` (`?month=`, `?tab=settings`) as a full-screen view with a back button.
  - Each view can be linked to directly, and the browser's back button works.
  - The view's state goes in the query string, e.g. `/spend?card=…&cycle=…`.
- **Personal settings (`/settings`):** link or unlink Todoist, choose the chores project, and choose the to-do summary view.
- **Freshness:**
  - Visible panel data refreshes when the window regains focus and every 60 seconds.
  - Each card shows "Updated X ago," based on the server's last successful sync for that card's data.
  - A warning appears when data is stale (§8).
- **Appearance:** follows the system's light or dark setting.
- **Accessibility:** everything works by keyboard, controls are labeled, and touch targets on phones are at least 44 px.

---

## 8. Integrations framework

- **`connections` table fields:**
  - `kind`: `google_calendar`, `todoist`, or `plaid`
  - `scope`: `family` or `user`
  - `owner_user_id`: who linked it
  - Encrypted credentials
  - `status`: `ok`, `needs_reconnect`, or `error`
  - `last_success_at`, `last_error`, `last_error_at`
  - Metadata (JSON). For Plaid: Plaid's `item_id` (what its webhooks name) and the bank's name; the Item's own state, including its purpose (Spend or Savings, §21.3), is in `plaid_items` (§18)
- **Family connections:** one Google Calendar connection (a partial unique index enforces it) and any number of Plaid connections, one per Item. Admins link and manage them. Any admin can reconnect a family connection, not only the admin who linked it; `owner_user_id` then becomes that admin.
- **User connections:** each user can have at most one Todoist connection, and only that user can link it.
- **OAuth flows:** `POST /connect/<kind>/start` (behind the CSRF check, so another site can't start one) answers with the provider's URL, which the page visits; the provider returns to `GET /connect/<kind>/callback`. The `state` value is bound to the session, and PKCE is used wherever the provider supports it. Plaid isn't OAuth on our side: Link runs on our own page and hands back a public token, which the server exchanges (§12.2).
- **Credential storage:**
  - Encrypted with AES-256-GCM using `TOKEN_ENCRYPTION_KEY`.
  - Each value gets a random IV and a key-version prefix, so the key can be rotated.
  - The connection's kind and owner are bound in as additional authenticated data, so a value copied into another connection's row doesn't decrypt. A family connection is bound to its kind and its row id instead (`connections:<kind>:family:<id>`), so a reconnect by another admin, which changes the owner, never breaks it.
  - A check value encrypted with the key is stored in settings. If the key at startup doesn't match it, the app still starts, but integrations do nothing and write nothing, and the admin System page says why, so restoring the right key brings every connection back. With the right key, a single value that can't be decrypted sets its connection to `needs_reconnect`.
  - Credentials are never returned to the client and never logged.
- **Token refresh:** Plaid access tokens don't expire. Providers with expiring access tokens (Todoist's last an hour, with rotating refresh tokens; Google's last an hour, and its refresh tokens don't appear to rotate) are refreshed ahead of expiry and once after a 401, one at a time per connection. A refused refresh (`invalid_grant`) sets `needs_reconnect`. A failure is recorded only against the credentials the request used, so a request that started before a relink can't mark the new link broken.
- **Status changes:**
  - An authorization failure sets `needs_reconnect`. Examples: Google `invalid_grant`, a Google 401 after a fresh token, a Google 403 for a missing scope, Todoist 401 or 403, Plaid `ITEM_LOGIN_REQUIRED`. Google's rate-limit 403s back off instead, and other Google 403s count as ordinary failures (or, for one event, as a refused change).
  - For Plaid, `ITEM_LOGIN_REQUIRED`, `PASSWORD_RESET_REQUIRED`, `ITEM_LOCKED`, `ACCESS_NOT_GRANTED`, `NO_ACCOUNTS`, and the `USER_PERMISSION_REVOKED` webhook set `needs_reconnect`, fixed with Reconnect (update mode). After `USER_PERMISSION_REVOKED`, Spend settings offers both fixes, Reconnect, or removing the bank and connecting it again, since update mode may not work then. `ITEM_NOT_FOUND` and `INVALID_ACCESS_TOKEN` set it too, with "This bank connection no longer works at Plaid. Remove it and connect the bank again.", since update mode can't fix them. Transient Plaid failures (rate limits other than `TRIAL_CONNECTION_LIMIT`, `PRODUCT_NOT_READY`, institution errors, `API_ERROR`, 5xx, the network) also set the Item's backoff: 5 minutes after the first, doubling, at most an hour. Scheduled and webhook syncs skip an Item in backoff; Refresh doesn't.
  - Any other failure sets `error` after 3 failures in a row.
  - Any success sets `ok`, and clears a Plaid Item's backoff. For Plaid, only `/transactions/sync` counts: a liabilities call that works never resets the failure count or sets `ok`, and its transient failures neither count nor set the backoff. A login failure there still sets `needs_reconnect`.
  - A bank's last error shows in Spend settings while its status isn't `ok`, and also while it is, if the error came after the last success, so a first sync that failed once is visible.
- **Staleness:** a card shows a warning when its data is older than twice the data source's normal refresh interval. For a card on a linked bank that's 12 hours, twice the 6-hour sync, counted from the Item's last completed transaction sync (`plaid_items.last_sync_at`), not the connection's last success, which a reconnect or a liabilities call can set without bringing any transactions. The Savings card warns after 26 hours instead, from its balances' fetch time (§21.1).

---

## 9. Calendar panel

### 9.1 Linking

- An admin goes to **Integrations → Connect Google Calendar**. It uses the same OAuth client as sign-in, with PKCE, `state`, and a nonce in a signed flow cookie bound to the session and the admin.
- Google's consent screen asks for two scopes, with `access_type=offline` and `prompt=consent select_account`, so Google issues a long-lived refresh token and the admin picks which Google account to use:
  - `https://www.googleapis.com/auth/calendar.events`
  - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
  - plus `openid email`, already granted for sign-in, so the ID token says which Google account linked.
- Google lets the admin untick a scope (granular consent). The token response's `scope` is checked, and a link missing either calendar scope is refused with a plain message.
- The tokens are saved, encrypted, before the pick. The picker says first which Google account signed in ("Connected as X"), and, if that isn't the connected account, that picking replaces it. The admin then picks one calendar from their calendar list. Only calendars where they have `owner` or `writer` access are offered (`writerWithoutPrivateAccess` can't see or change private events, so it's left out). **Change calendar** offers the list again with the saved token, without the consent screen. A pick remembers which connection it came from, and is refused ("That calendar pick expired. Start again.") if that connection changed or was disconnected meanwhile; disconnecting deletes every waiting pick.
- The app stores the refresh token (encrypted), the Google account, the calendar's ID and name, and its time zone, which each read keeps current.
- Only admins can change the calendar or disconnect it.
- **Revoking:** Google ends every grant the account gave the project when any of its tokens is revoked, sign-in included. So reconnecting the same Google account, or picking another calendar, never revokes. Connecting a *different* Google account replaces the old one, and the old account's token is revoked like a disconnect (the Reconnect copy says so). Disconnecting revokes, best effort, and the confirmation says it also removes that account's consent for signing in (dashboard sessions aren't affected). A token Google didn't confirm revoking waits in `pending_revocations`, dropped if the same Google account links the calendar again, and kept for later while a pick for that account is waiting, for 15 minutes after any link starts, and, when its account isn't known, while any calendar link or pick exists. Only `invalid_token` and `invalid_grant` count as already revoked. After 12 tries the token is wiped and the System page shows a lasting warning naming the account to remove the dashboard's access from by hand, until an admin dismisses it. Whether a `prompt=consent` relink of the same account invalidates its earlier refresh token isn't documented (the phase 5 plan's "Verify on first real link").
- With no calendar linked, the Calendar card says "Calendar isn't connected yet." Admins also see a **Connect** link.

### 9.2 Reading

- The server fetches events from Google one time window at a time (`events.list` with `singleEvents=true`, `orderBy=startTime`, `timeZone` set to the family time zone, and every page followed).
- It asks for a day more on each side and filters back to the window, because Google places all-day events by the calendar's time zone, which can differ from the family's.
- Each window's result is cached for 5 minutes, in the `calendar_cache` table, so it survives a restart. Any change made through the dashboard marks every cached window stale (refetched next time, but still there to fall back on), and the drill-down's refresh button bypasses the cache. Callers asking for the same window at once share one request.
- **Summary window:** today through 6 days from now, in the family time zone. A background job refreshes it every 5 minutes so the card loads quickly.
- The last successful result for each window is kept. When Google is unreachable, the connection needs reconnecting, or the key doesn't match (§14), those events are shown read-only.
- A cached window is never a mirror: nothing is deleted or changed because a listing left it out.
- **What's shown:** working-location markers are left out. Birthdays, out of office, focus time, and other non-default event types are shown read-only, as are locked events and invitations organized elsewhere. Private and confidential events show only that they're there and when, as "Private event", because the dashboard can't tell which family members Google would show their details to.
- *Why this approach:* fetching by window avoids keeping track of Google's sync tokens and expanding repeating events locally. A family calendar is far too small to hit Google's quotas.

### 9.3 Summary card

- An agenda grouped by day, starting with today.
- Up to 6 events, followed by "+N more this week."
- All-day events come first within each day. Each event shows its time, or "All day," and its title.
- Clicking an event opens its detail over the home page, in the same dialog as the drill-down (§9.4): Edit, Delete, *This event* or *All events* for a repeating event, edit conflicts (§9.6), and the read-only cases all work the same way. The open event is in the query string as `/?calendarEvent=<id>`, so Back closes it and a link opens it. When it closes, focus goes back to the event, or to the card's title after a delete or an *All events* save. Opening or closing it leaves the page where it was scrolled to.

### 9.4 Drill-down

- **Views:** agenda (the default on phones), week, and month (the default on wider screens). There are controls for previous, next, and today.
- **Event detail:** title, time, location, description, a summary of the repeat rule, "Added by X" or "Edited by Y" when that's known (§9.5), and a link to open it in Google Calendar. A description Google keeps as HTML is shown as text and isn't edited here.
- **Create and edit fields:**
  - Title (required)
  - All-day toggle
  - Start and end date and time, in the family time zone
  - Location and description
  - Repeat: none, daily, weekly on chosen weekdays, monthly on the same day of the month, or yearly
  - Ends: never, on a date, or after N times
  - The repeat settings are stored as a standard RRULE.
- **Repeating events:** editing or deleting one asks whether to change **This event** or **All events**.
  - *This event* changes just that instance (a patch on its id). Deleting it sets it to `cancelled`. Google's guide changes and cancels instances with `events.update` (PUT); a patch on an instance id isn't documented, so the server patches first and, if Google refuses the patch, sends the whole instance with PUT, every field it read kept. A series opened by its own id offers only *All events*.
  - *All events* changes or deletes the whole series, with the series' own etag. A change to its text always goes to the series. A move is applied as a shift: the series moves by however far the person moved the instance (in days and minutes), never to the instance's date, worked out in the zone the series repeats in (its start's own zone).
    - The series moves, or its repeat changes, only when the repeat is one the editor can represent, has no dates skipped or added (`EXDATE`, `RDATE`), and no instance was changed or cancelled on its own (checked with `events.instances`, cancelled ones included). What Google does to such exceptions when their series moves isn't documented. Otherwise the form locks the dates, times, and repeat with the reason, and the server refuses with "Move this series in Google Calendar."
    - When the series' first day moves, its repeat is written again from the parsed rule: a weekly rule's weekdays move with it unless the person changed them, and a `BYMONTHDAY` or `BYMONTH` Google wrote is dropped so the rule follows the new start. An `UNTIL` whose date didn't change is written back exactly as Google had it.
    - Switching a series between all day and timed (judged by the series, not the instance), or stopping it from repeating, is left to Google Calendar.
  - Google's "this and following events" option isn't offered in v1.
- **Repeat rules:** "monthly" and "yearly" are written without a day (`FREQ=MONTHLY`), so they follow the series' start. RFC 5545 skips months without that day, so a repeat on the 29th to the 31st says "in months that have one", and one on February 29 says "in leap years only". `UNTIL` is a date for all-day events and UTC (the end of that day in the zone the series repeats in) for timed ones, as RFC 5545 requires.
- **Repeat rules this editor can't represent**, such as complex rules created in Google, or a rule with dates skipped or added (`EXDATE`, `RDATE`):
  - Title, location, and description can still be edited, for *This event* and *All events*, and *This event* can still be moved. *All events* can't move the series (above).
  - The repeat rule is shown read-only, with the note "Edit the repeat in Google Calendar."
- **Fields the dashboard doesn't manage** are neither shown nor edited, and edits leave them untouched because updates change only the dashboard's own fields. These fields are attendees, reminders, colors, and video-meeting links.
- **Guests aren't emailed.** Every create, edit, and delete sends `sendUpdates=none`, so Google never emails an event's guests about a change made from the dashboard. Google's default isn't clearly documented, so it's sent explicitly. Google warns that `none` can keep a change from reaching guests on other calendar systems; that's checked on the first real link, and changing it is an open question.

### 9.5 Attribution

- Every write goes through the admin's Google connection, so Google lists the admin as the creator.
- When an event is created, the app stores the creating user in the event's private extended properties as `dashboardCreatedBy`. When an event is updated, it stores the editing user as `dashboardUpdatedBy`. Each holds `<installId>:<userId>`, where the install id is a random value the app keeps in its settings, so another dashboard sharing the calendar never shows its user 3 as this one's.
- The app shows these as names, only when the install id is its own. Events without these properties, such as ones created directly in Google, show no attribution. Anyone who can change the calendar can change these properties, so attribution is informational.
- A new event's id is chosen by the browser when the New event form opens, and sent with the create. A Save sent again after a lost answer gets Google's 409 for that id, and the server reads the event back as long as this install and person made it, so a retry never makes a second event.

### 9.6 Edit conflicts

- Updates and deletes send the event's `etag` in an `If-Match` header.
- If Google responds 412 (the event changed since it was loaded), the client reloads the event and shows "This event changed. Review and save again."
- Whether Google honors `If-Match` on `events.patch` isn't documented, so the server also reads the event (and, for "All events", its series) fresh before each write and compares the etag the form was loaded with. Either way the person sees the same message.
- A 412 right after that check passed is read again. If the etag really changed, it's the conflict above. If it didn't, Google refused an etag it just gave out (possible for instances, not documented), so the server logs `etagRejected` and sends the write once more without `If-Match`.

### 9.7 Permissions

- Anyone with the Calendar panel can view, create, edit, and delete events.
- Only admins can link, change, or disconnect the calendar.

---

## 10. To-do panel

### 10.1 Item fields

- Title (required, up to 500 characters)
- Notes (optional)
- Due date (optional)
- Due time (optional, and only allowed with a due date)
- Completed time
- Owner and creator
- Linked chore occurrence (optional)

Items created from chores show a **Chore** tag that links to the chore.

### 10.2 Visibility

- Each person's list belongs to them, and members see only their own.
- Admins get a person picker in the drill-down and can view, add, edit, complete, reopen, and delete items on anyone's list, including other admins'. For someone linked to Todoist, these actions go through that person's Todoist connection.
- The picker lists only users who have the To-do panel.
- Personal settings and the Todoist link screen both say: "Admins can see and edit your to-do list."

### 10.3 Summary card

- Shows the signed-in person's own items, filtered by their chosen summary view:
  - **Overdue, today, and undated** (default)
  - **Overdue and today**
  - **Next 7 days** (includes overdue items)
  - **Everything**
- Up to 8 items, with overdue first, then by due date and time, then by when created. More items show as "+N more."
- **Quick add:** a text box that takes a title only. Dates aren't parsed. Set them in the drill-down.
- **Checkboxes** complete an item immediately in the UI, and the change is undone if saving fails.

### 10.4 Drill-down

- Items are grouped into **Overdue**, **Today**, **Upcoming**, and **No date**.
- Items completed in the last 7 days are in a collapsed group at the bottom, where they can be reopened.
- For someone linked to Todoist, a toggle switches to grouping by Todoist project. It only shows when the open items span more than one project, which happens when chore to-dos live outside the Inbox (§10.6).
- Add and edit cover title, notes, due date, and due time. Deleting asks for confirmation.
- **Chore to-dos have their own rules:**
  - In the dashboard, members can complete them but can't delete them. Admins can delete them, which skips the chore occurrence.
  - Deleting a chore task in Todoist can't be prevented, so it's treated as a skip (§11.5).

### 10.5 Internal backend

- For people not linked to Todoist, items are stored in the `todos` table.
- Completed items are hidden from the UI after 7 days but kept in the database. There's no purging in v1.

### 10.6 Todoist backend

- **Linking**, from **Personal settings → Connect Todoist**:
  - OAuth with the scopes `data:read_write,data:delete`.
  - The person then picks a chores project, which defaults to Inbox.
  - If the chores project is deleted or archived in Todoist, chore to-dos go back to Inbox, and `/settings` says so until the person picks a project again.
- **What syncs** (changed on 2026-11-16 at the owner's request; it used to be every active task in every project):
  - Only the person's Todoist **Inbox** (`user.inbox_project_id`, or the project with `inbox_project: true`), plus their **chore to-dos** wherever they are: in the chores project, or wherever the person moves them in Todoist. Checking off a chore to-do in Todoist completes the chore, whatever project it's in.
  - Tasks in any other project, including shared projects, aren't mirrored. Every project's name is still stored, for the person's own chores project picker. The to-do list and home card, which admins can read for anyone, name only the Inbox, the chores project, and the projects the list's items are in.
  - This narrows what's stored and shown, not what the app can access: the OAuth grant still covers the whole account (Todoist has no Inbox-only scope), and full syncs still receive every project's tasks, which the server doesn't keep.
  - **A task that leaves that scope** (a non-chore task moved out of the Inbox, seen in another project on a sync, or confirmed open or completed in another project by a lookup) is dropped from the mirror quietly. It's still in Todoist, so it isn't a deletion: no `todo.deleted` (or any other event) is emitted, and no chore occurrence is touched. If it moves back into the Inbox, it shows up again.
  - The drop is a hard delete of the mirror row, not a soft delete. A soft-deleted row would read as a to-do deleted on purpose wherever `deleted_at` is read, and nothing points at a row that isn't chore-linked, so nothing is lost.
  - Upgrading: every start drops the mirror rows an older version kept from other projects (open or completed), keeping chore-linked rows, and logs only counts. It runs every time, not once, so rows left by a rollback go too. A person whose stored Inbox id isn't known, or isn't one of their projects, is skipped.
  - A write whose response shows its task moved out of the Inbox still succeeds, and answers with the to-do as it was.
  - Relinking: rows kept from an earlier link whose task is now in another project disappear from the list (see "Relinking later").
- **Mirror:**
  - The server keeps a local copy of that person's Inbox tasks, chore to-dos, and project names, using Todoist API v1's incremental `/sync` with a stored sync token.
  - A sync runs when a Todoist webhook arrives for that person (`item:added`, `item:updated`, `item:completed`, `item:uncompleted`, `item:deleted`), every 10 minutes as a backup, and whenever the person opens the drill-down.
- **Changes go to Todoist first.** If Todoist accepts a change, the local copy is updated from Todoist's response. If it fails, the person sees an error and nothing changes.
- **Writes** are `/sync` commands sent in the same request as the incremental sync, each with a `uuid` that makes a retry safe. The mirror is updated from that response. Every operation on one person's account (syncs, writes, token refreshes, link, unlink) runs one at a time.
- **Field mapping:**
  - Todoist `content` maps to title, and `description` to notes.
  - `due.date` maps to due date and time, shown in the family time zone. It holds a date, a floating time (shown as written), or a UTC time with `due.timezone` set (converted to the family time zone). There is no `due.datetime`. A time set in the dashboard is sent as a floating time, and clearing the date sends `due: null`.
  - The project is shown read-only. New items go to Inbox, and editing an item never changes its project. If a write's response shows the task outside the Inbox (it was moved in Todoist meanwhile), the write still succeeds and the row is dropped quietly, unless it's a chore to-do.
  - Priority, labels, and sections aren't shown, and edits leave them untouched.
  - Subtasks appear as ordinary items.
  - A deleted task arrives with its fields blanked, so the mirror keeps the last known fields and only marks the row deleted.
- **Todoist's own repeating tasks** show their next due date. Completing one in the dashboard works the way it does in Todoist, which moves the due date forward; the item stays open with its new date. Their date can only be changed in Todoist, because sending a plain date would drop the repeat rule.
- **Chore to-dos** go into the chores project, without a Todoist repeat rule.
- **On linking:**
  - Each existing open internal item is created in Todoist. Chore items go into the chores project, and everything else into Inbox.
  - The internal rows become mirror rows tied to the new Todoist task IDs, converted in place one row at a time, so a crash part way through never creates duplicates. Completed internal items stay as they are.
- **On unlinking:**
  - Mirror rows are converted in place back to internal rows, never copied, so chore to-dos stay linked to their occurrences. Open ones keep their Todoist task ID.
  - The sync state and the connection are deleted, and the Todoist tokens are revoked.
- **Relinking later:** internal items whose Todoist task ID still belongs to an active task are matched to that task instead of being created again, but only when that task is in scope (in the Inbox, or the item is a chore to-do). An item whose task is now in another project isn't re-attached and isn't added to the Inbox again; it's dropped quietly, since the task is still in Todoist. This only applies when the person links the same Todoist account as before. Linking a different account clears the kept task IDs first, so those items move into the new account as new tasks and nothing is taken for deleted.
- **Reconciling:** a full sync runs at link time and at least daily as a safety net, always right after an incremental sync from the stored token, which reports completions and deletions. A full sync leaves out completed tasks, so an open mirror row it doesn't list is looked up by id: completed, deleted, or still open. A row is never removed just for being missing. A lookup that finds the task open, or completed, in another project means it left the Inbox: the row is dropped quietly, never taken for a deletion, and a completion there isn't reported, unless it's a chore to-do, which is updated (and completed) as usual. A reconnect to the same account picks up from the stored sync token.
- **Shared projects:** tasks in shared projects aren't mirrored, since only the Inbox syncs. The exception is a chore to-do in a shared chores project: it's on the list of the person it belongs to, and nobody else's. Completing or deleting it from that list does it in Todoist.
- **Tasks Todoist won't take:** an open item that Todoist refuses during the move on linking stays on the dashboard list, as an internal item.

### 10.7 Events

For any item linked to a chore occurrence, `TodoService` emits:

- `todo.completed`
- `todo.uncompleted`
- `todo.deleted`

Each event carries the item and who made the change: the acting user's ID, or `todoist` when the change arrived through sync.

---

## 11. Chores panel

The Chores panel is a board of the household's chores: every chore, how often it comes up, and who has it. A chore's assignment lives on the chore. Unassigned chores are never late. Once someone has a chore it's on their to-do list and keeps coming back on schedule until they hand it off. (Design: [chore board](2026-11-18-chore-board-design.md).)

### 11.1 Chores

- **Fields:** title, notes, who has it (a user, or **Unassigned**), frequency, start date, and status (`active`, `paused`, or `archived`).
- **Frequencies:**
  - Daily
  - **Every weekday:** Monday to Friday. It's a preset, not a schedule of its own: it's saved as weekly, every week, on Mon–Fri, so it follows the weekly rules (Saturday and Sunday are skipped, and it sorts right after daily at 7 / 5 = 1.4 days). The form offers it next to "Every day", and a chore saved as weekly, every week, on exactly Mon–Fri opens with it picked; switching to Weekly shows those five days ticked.
  - Weekly on chosen weekdays
  - Every N weeks on chosen weekdays, counted from the week of the start date
  - Monthly on day N (1–31; in shorter months, the last day) or on the last day of the month
  - Every N days or N weeks after the previous occurrence was completed or skipped
  - **As needed:** no frequency
- **Start date:** it only matters for "every N weeks" (which week counts as week one) and as the earliest date a chore can be due. The form shows it only for "every N weeks" (N > 1) and saves it only then. Otherwise a new chore starts today and an edit keeps the chore's own start date, so a date picked and then hidden by changing the frequency is never saved.
- Chores have a due date but no time of day. An occurrence is due from the start of its due date in the family time zone.
- **Who can do what:**
  - **Add:** anyone with the Chores panel. A member can leave it unassigned or take it themselves; an admin can also give it to anyone.
  - **Edit, pause, resume, archive:** admins only. An edit changes the title, notes, frequency, and start date, never who has the chore; that changes on the board.

### 11.2 Occurrences

An occurrence is one time a chore is due. An assigned chore has at most one open occurrence, which carries the to-do; an unassigned chore has none. Its fields:

- The chore, plus a copy of the chore's title at the time
- Due date, or none for an as-needed chore
- Assignee
- How it was assigned: `claimed` or `admin`. `default` remains only on occurrences from before the board.
- State: `open`, `done`, or `skipped`
- When it was completed or skipped, and who did that
- Who gets credit
- The linked to-do item
- Whether the to-do exists: `ok`, `pending`, or `not_applicable`

How it was assigned:

- Claiming or taking over a chore marks its occurrence `claimed`; an admin assigning it marks it `admin`.
- A chore added already assigned is `claimed` when the person adding it took it, and `admin` otherwise.
- An occurrence made by generation copies the chore's latest occurrence when that one was the same person's and wasn't `default`, and is `admin` otherwise.

Each chore can have at most one occurrence per due date (a unique key on chore and due date).

### 11.3 Next due date and generation

All dates are family-local.

- **From date F**, the next due date of a repeating chore is:
  - Fixed frequencies: the first scheduled date on or after F (and on or after the start date).
  - After completion: the later of F and the last close date plus the interval; with no close yet, the later of F and the start date.
- **On assignment,** F is today, but never on or before a due date the chore already has. So if someone does a Friday chore early on Wednesday and releases it, and someone else claims it on Thursday, it's due the Friday after.
- **After an occurrence closes,** F is the day after its due date or the day it closed, whichever is later. So a chore done early waits for its due date to pass, and one done late comes back right away.
- **Generation** runs every 15 minutes and at 00:00 family time. For each active, assigned chore with no open occurrence: a repeating chore gets its occurrence once today has reached F, due on the next due date from F (or from today, if the run comes late after downtime); an as-needed chore gets its undated occurrence (after it's resumed, for example). It's safe to repeat and creates at most one occurrence per chore per run.
- **Pausing or archiving a chore:** its open occurrence and unfinished to-do are removed. Pausing keeps who has it, so resuming puts it back on their list; archiving clears it. Archived chores are never deleted, so history still refers to them.

### 11.4 The board and assignment

- **The board** lists every active chore (paused and archived ones aren't on it), most often first: each frequency has a period in days (daily 1; k weekdays every N weeks 7N / k; monthly 30; every N days or weeks after completion N or 7N; as needed last), then by title. Each row shows the title, the frequency ("Every day", "Every weekday", "Fridays", "Every week on Mon, Thu", "Every 2 weeks on Mon", "Monthly on the 1st", "Every 10 days after it's done", "As needed"), who has it (avatar and name, "You", or Unassigned), and its state:
  - Assigned with an open occurrence: "Due today", or "Overdue since yesterday" in the danger color (with the word, never color alone). An open occurrence due after today isn't due yet, so it reads "Next: Wed, Nov 18" (or "Next: Tomorrow").
  - Assigned, nothing due yet: "Next: Fri, Nov 27".
  - Assigned, as needed: "On your list" or "On their list".
  - Unassigned: nothing. Unassigned chores have no due date and are never late.
  - The board and the summary card (§11.8) word these the same way.
- **Who has it** is its own column on screens 600px and wider, after the title, under a "Who has it" heading (the actions sit under the row until 960px, then get a column of their own): the person's avatar in their color and their name ("You" for yours), or an empty dashed circle and "Unassigned". On phones it's part of the line under the title, after the frequency, and the row leads with the avatar.
- **The Who has it filter** above the list: Everyone (the default), Mine, Unassigned, and each active person other than you who has a chore on the board, by name (a picked person stays offered while picked). It's `?who=` in the URL (`mine`, `unassigned`, or a user id; anything else is Everyone), so it survives reloads and back and forward. It only hides rows on the page, keeping the board's order. While it's on, the heading says "Chores (4 of 10)", and when nothing matches it says why ("You don't have any chores right now.", "Every chore has someone.", or "Riley doesn't have any chores right now."). An action that takes its row out of the filter adds "It no longer matches the filter, so it is hidden." to the status line, and focus goes to the Chores heading.
- **Claim:** anyone with the Chores panel can claim an unassigned chore, or take a chore from another person (**Take over**).
- **Release:** whoever has a chore can put it back on the board, unassigned.
- **Admins** can also assign any active chore to any active user, reassign it, or unassign it. On the board this is an **Assign…** button that opens a picker under the row. Changing the picker only selects, so moving through its options by keyboard doesn't reassign at each step; **Assign** (or **Unassign**) applies it, and Cancel or Escape closes it.
- **Only active chores** can be claimed, released, or assigned. A paused chore is refused with "Resume the chore first."; an archived one with "Archived chores can't be changed."
- **What assigning does:**
  - If the chore has an open occurrence (a take-over or reassign), it moves to the new person with its due date unchanged, overdue or not. The old person's to-do is deleted and the new person gets one.
  - Otherwise an occurrence is created right away: due on the next due date for a repeating chore, with no due date for an as-needed one.
  - Releasing or unassigning deletes the open occurrence (it isn't history, since it wasn't done or skipped) and its to-do.
- **Who can be assigned:** any active user. The UI warns if the assignee has neither the Chores panel nor the To-do panel, because they'd never see the chore. In the Assign picker the warning shows as soon as that person is picked, before Assign is pressed.
- **Deactivating a user** puts their chores back on the board, paused ones included (and one paused while that was happening), and removes their open occurrences and to-dos.

### 11.5 Linked to-do items

- **Creating the to-do:** when an occurrence gets an assignee who has the To-do panel, `TodoService` creates a to-do on that person's list. Its title and notes come from the chore, its due date from the occurrence (none for an as-needed chore, so it shows under "No date"), and it carries the Chore tag. For someone linked to Todoist, it goes into their chores project.
- **If creation fails** (for example, Todoist is down):
  - The occurrence's to-do status becomes `pending`.
  - `todo.retryPending` retries with backoff.
  - The Chores panel shows "Not on to-do list yet."
  - After 12 failed attempts (about 9 hours) the change is "stuck": it's no longer retried, and admins see it on the System page, where they can retry or dismiss it. Dismissing a stuck creation sets the to-do status to `not_applicable`. Removals and completions of chore to-dos follow the same rules.
  - While the assignee's Todoist link needs reconnecting, their changes wait without using up attempts.
  - Each run of `todo.retryPending` also catches up any open occurrence whose to-do was completed or deleted without the event being handled, following the same rules as the events.
- **Assignee without the To-do panel:** no to-do is created (status `not_applicable`). The occurrence is completed from the Chores panel.
- **How chore changes affect the to-do:**

  | Change | Effect on the to-do |
  |---|---|
  | Completed on the Chores panel | Marked complete |
  | Skipped, released, unassigned, taken over or reassigned away, or its chore paused or archived | Deleted, if not already completed |

- **How to-do events affect the occurrence:**

  | To-do event | Effect on the occurrence |
  |---|---|
  | `todo.completed` | Marked done. Credit goes to the assignee. "Checked off by" is the acting user, or the assignee if the change came from Todoist |
  | `todo.uncompleted` | Reopened under the same rule as History's Reopen (§11.7), as long as it goes back to the to-do's owner. Otherwise the to-do is completed again, so nobody is left with an open chore to-do they can't delete |
  | `todo.deleted` | Skipped. "Skipped by" is the acting user, or the assignee if the change came from Todoist |

- **After a close** (from either side), the chore moves on: an as-needed chore goes back on the board, unassigned; a repeating chore closed late gets its next occurrence right away (§11.3). For a change that came from Todoist sync, that occurrence's to-do is created by `todo.retryPending` rather than during the sync. A close found by the catch-up in `todo.retryPending` puts an as-needed chore back on the board at once, but leaves a late repeating chore's next occurrence to the next `chores.generate` run.

### 11.6 Completing and skipping on the Chores panel

- **Members** mark their own open occurrences done.
- **Admins** can mark any open occurrence done, with credit to the assignee, and can skip any open occurrence. Members can't skip from the Chores panel. The board shows a done checkbox only on your own rows; the API still lets an admin complete anyone's.
- A skip counts like a completion for scheduling. History records it as skipped.

### 11.7 Completion history

- **What's recorded:** every occurrence that is done or skipped. History shows:
  - Chore title (the copy stored on the occurrence)
  - Due date, or "As needed"
  - When it was completed or skipped
  - Who gets credit
  - Who checked it off, when that's someone other than the credited person, e.g. "Riley · checked off by Alex"
  - How it was assigned: default (only before the board), claimed, or by an admin
  - Whether it was late, meaning completed on a date (family time zone) after its due date. As-needed completions are never late.
- **Filters:**
  - Person: defaults to the viewer, with an **Everyone** option
  - Date range: this week, this month, last 30 days (the default), or a custom range
  - Chore
  - Show or hide skipped occurrences
- **Totals:** the top of the view shows the number completed, late, and skipped for the current filter.
- **Visibility:** anyone with the Chores panel can see everyone's history.
- **Corrections (admins only):**
  - Change who gets credit for a completion.
  - Reopen the most recent occurrence of a chore (the one created last), but only if the chore is active and no newer occurrence exists.
    - One exception undoes an accidental tick on an overdue chore. If this one was closed late (its family-local close date is after its due date) and the only newer occurrence is the one that close brought (still open, the same person's, and created within a minute of the close), reopening deletes that newer occurrence and its to-do and reopens this one. As-needed occurrences have no due date and never qualify.
    - Any other newer occurrence (closed, someone else's, or one the generation job made later, as after an on-time or early close) blocks the reopen, and unchecking the to-do completes it again.
    - It goes to whoever has the chore or, for a chore back on the board, to whoever had the occurrence if they're still active, and the chore is theirs again. With neither, it's refused: "Assign the chore before reopening it."
    - Reopening restores its to-do, either by reopening it or by creating it again.
- **Retention:** forever. History of archived chores stays.

### 11.8 Summary card

In this order, up to 6 rows in total:

1. **Yours:** your chores with an open occurrence, overdue ones first and highlighted, each with a checkbox to complete it. These always show, even past 6.
2. **Coming up:** chores you have with nothing due yet, muted, with "Next: …".
3. **Up for grabs:** the top unassigned chores in board order, each with a **Claim** button, filling whatever rows are left.

Under Yours, the card says "Nothing due right now." when only Coming up has something of yours, and "Nothing on your plate." when you have nothing.

### 11.9 Drill-down

The view is `?tab=` in the URL. An unknown or old value (`?tab=open`, `?tab=chores`) shows the Board.

- **Board** (the default tab): the board (§11.4), with the Who has it filter, Claim, Take over, Release, and done checkboxes on your own due rows; admins also get Skip on any row with an open occurrence, and Assign…. An **Add chore** button opens the add form at the top, for everyone.
- **History:** as described in §11.7.
- **Manage** (admins only): edit, pause, resume, archive, and the paused and archived lists.

---

## 12. Spend panel

### 12.1 Data sources

There are two data sources. Either one, or both, can be used.

- **Plaid** is the primary source.
- **CSV import** is the fallback, and also brings in older history.

### 12.2 Linking banks (admins only)

Spend's banks are Items with `purpose` `spend`; the Savings panel links its own (§21.3).

- **Starting the link:** an admin presses **Connect bank** in Spend settings (§12.12). That's a full page load of `/connect/plaid/link`, a small page of its own (no React, no inline script) that the server sends with the Link CSP (§15). The page asks the server for a Link token (`POST /connect/plaid/link-token`), created with:
  - `products: ["transactions"]` and `required_if_supported_products: ["liabilities"]`, so a Liabilities hiccup at the bank can't block a card whose transactions are fine
  - `transactions.days_requested=730`, the maximum of about 24 months of history, which can't be raised later
  - `account_filters` for credit cards only, so Link never offers checking or savings, and nothing else is ever shared
  - Webhook URL `BASE_URL/webhooks/plaid`. It's set per link, not in Plaid's dashboard, and `/item/webhook/update` isn't used, so changing `BASE_URL` after linking means removing each bank and linking it again
  - Redirect URI `BASE_URL/connect/plaid/oauth-return`, which must be in Plaid's Allowed redirect URIs, so banks that sign in with OAuth also work from phones and in-app browsers
  - `client_name` "Family Dashboard", `language` `en`, `country_codes` `["US"]`, and `user.client_user_id`, a random 16-byte value kept in settings (`plaid_client_user_id`), never a user id or anything personal

  The page then loads Plaid's `link-initialize.js` and opens Link.
- **The link session:** the token is saved in `plaid_link_pending`, one row per admin, bound to them and a hash of their session, for 30 minutes (shorter than Plaid's 4 hours, and enough for a bank's OAuth pages). It's stored in plain text, not encrypted: it can open Link for this client but can't read any data, and it's single-use. After a bank's OAuth pages, Plaid returns to `/connect/plaid/oauth-return`, the same page, which asks for the same token again (`POST /connect/plaid/resume`) and finishes in Link. `resume`, `exchange`, `updated`, and `exit` all need the same admin in the same session (the hashes compared in constant time), and each of the last three deletes the row. A refused call says where the page goes next: Spend settings with `?bank_error=<code>`, which shows a plain message (or `/` when signed out). The calls are limited to 10 a minute per admin.
- **The duplicate check:** before exchanging, the server compares Link's `onSuccess` metadata with the Items that aren't removed. A duplicate is an Item at the same institution with an account of the same name and mask (Plaid's own test). It's refused with "That bank login is already connected as <name>. Nothing new was connected.", and the public token is never exchanged: a duplicate costs a Trial connection, and at some OAuth banks it can break the older Item. A different login at the same bank (a spouse's cards) has other accounts, so it's allowed. With no institution in the metadata there's nothing to compare, and the link goes ahead. The metadata comes from the browser, so it only decides whether to exchange; what's stored comes from Plaid.
- **The exchange:** `/item/public_token/exchange`, then the Trial counter goes up in its own write, then the family connection (the access token, encrypted and bound to its row, §8) and the `plaid_items` row in one transaction, then `/item/get` (the bank's name, the consent end) and `/accounts/get` (the accounts, stored on the Item). If storing the Item fails, or `/item/get` or `/accounts/get` fails with an error that isn't transient, the Item is removed at Plaid, or its removal queued, and nothing else is kept. A transient failure of either (Plaid or the bank briefly down) keeps the Item, with its accounts not loaded yet: undoing it would spend a Trial Item for nothing. Spend settings then shows "Load accounts from <bank>" instead of the pick, which runs `/item/get` and `/accounts/get` again under the Item's lock (`POST /api/panels/spend/banks/:id/load-accounts`, 10 a minute per admin); the pick is refused until the accounts are loaded.
- **Items and cards:**
  - Each bank login is one Plaid **Item**.
  - **The pick.** After the exchange the page goes to Spend settings, which opens the bank's **Choose cards** (`?bank=<id>`). The Item isn't synced until every account is decided, since a transaction needs a card (and webhooks don't start before the first sync anyway). Closing the tab is fine: **Choose cards** waits there. For each account, the admin picks:
    - an existing card that isn't archived and isn't on another linked bank account. The one with the same last 4 is suggested, but never chosen for the admin, since Plaid's mask may not match the bank's;
    - a new card, named from Plaid's name for the account, with its last 4. Like every new card it starts out excluded, and the admin chooses whether to include it and names it;
    - or skip. A skipped account's transactions are dropped by every sync. The mark is kept on the Item's stored account, through a reconnect too.

    Every waiting account is decided in one request, and nothing is saved if any choice is refused. Saving runs the first sync in the request, bounded by a 40-second deadline for the lock wait and the pages together; past it nothing is applied, the sync carries on in the background, and the answer says "Saved. Syncing in the background." Attaching an account later (a skipped one, or a new one) marks the Item for a full resync (`full_resync_at`), so the next sync fetches its whole history again; upserts by `plaid_transaction_id` make that harmless. The cursor is never reset without first applying what Plaid queued since it: that sync first catches up from the stored cursor and saves it, so removals queued meanwhile are applied, and only then asks for the whole history with no cursor, clearing the marker in the same transaction as that pass's cursor. If the catch-up fails, nothing is reset. On a full resync of a bank that has synced before, a live pending row of an attached account that the whole history doesn't list is soft-deleted as removed; a posted row missing from it is left alone.
  - **An account id that changed.** Plaid can give an account a new id. The old id's card then shows as one the bank didn't share, and the new id waits for the pick, which may attach it to one of the Item's own cards whose account the bank stopped sharing (suggested when the last 4 match). The card moves to the new id; the old id stays on the Item's stored list, marked as no longer listed, so its rows are still the Item's own; and the full resync that follows replaces the old id's rows like an old bank's (§12.13), so the history isn't doubled.
  - Before Plaid is linked, admins create cards by hand in Spend settings (a nickname, optionally the last 4, included or not, and the usual closing day) and fill them with CSV imports. Attaching the bank's account to that card (above) puts the CSV history and the Plaid transactions on one card, so the duplicate test in §12.13 can match them.
  - A card with transactions can be archived but not deleted. An archived card isn't on the home card and can't take imports or new rules, but its history stays in the drill-down. An excluded card's transactions are kept but not shown or editable until it's included.
  - Link offers credit cards only (`account_filters`), so other accounts are never shared.
- **Trial limit:**
  - Spend settings shows "N of 10 Plaid Trial connections used. Removed banks still count.", from `settings.plaid_items_created`, raised on every successful exchange and never lowered. An exchange that was sent and timed out (its own timeout, or the request's deadline) is counted too, since Plaid may have made the connection and overstating the count is the safe side; Spend settings then says "Plaid may have made this connection. Check Spend settings in a minute before linking again."
  - Under Trial rules, removed Items still count toward the 10.
  - At 10 or more it adds "Plaid's Trial allows 10. If you're still on the Trial, linking another will fail." It doesn't refuse: the counter can drift from Plaid's own (the Dashboard homepage is the truth), and a paid plan has no limit. Plaid's `TRIAL_CONNECTION_LIMIT` is the real stop, never retried, and shown as "Plaid's Trial plan allows 10 bank connections, and they've all been used. Removing a bank doesn't free one."
- **Reconnecting** uses Plaid Link's update mode on the existing Item (`/connect/plaid/link?item=<id>`), so it doesn't use up a new Item. The access token doesn't change, so there's no exchange: `/item/get` and `/accounts/get` refresh the consent date and the account list, and the status goes back to `ok`. That completion waits at most 40 seconds for the Item's lock (a sync may hold it), then sends the page back to Spend settings with "That bank is busy syncing. Try again in a minute." A card whose account the bank didn't share this time keeps its history and its attachment, and Spend settings says so. A new account waits for the pick, which pauses syncing until it's decided.
  - When Plaid says the login has new accounts (`NEW_ACCOUNTS_AVAILABLE`), or a sync sees transactions for an account the Item's list doesn't have (§12.3), Spend settings offers **Load accounts** first, which picks up an account the login already shares (an id that changed, say), and **Add accounts** (`&accounts=1`) beside it: update mode with Account Select. The notice stays until a reconnect, or a load that finds a new account.
  - Spend settings shows the consent end, and once `PENDING_DISCONNECT` arrives, "Reconnect <bank> before <date>, or it stops syncing."
- **Removing a bank** (**Remove**, after a confirmation):
  - Waits at most 40 seconds for the Item's lock (a sync may hold it), then says "That bank is busy syncing. Try again in a minute." and changes nothing.
  - Calls `/item/remove` first. An Item Plaid already doesn't have counts as removed. A removal Plaid didn't confirm waits in `pending_revocations` and is tried again hourly, 12 times, then given up on with a lasting notice naming the bank (in Spend settings and on the System page, dismissed there), saying to remove the dashboard in the bank's connected apps settings or at my.plaid.com.
  - Then one transaction deletes the connection and any link session for the Item, and marks the Item and its cards removed.
  - Keeps past transactions, on cards marked "bank connection removed", unless the admin ticks **Also delete its transactions**. Kept, they lose only the Item's pending rows, which are soft-deleted (`removed_at` set, so the prune takes them), since the Item will never post them.
  - **Also delete its transactions** hard-deletes only the Item's own rows: `source = 'plaid'` and `plaid_account_id` among the Item's account ids (its stored list, accounts it no longer lists included, and its cards' attachments), never another Item's rows on the same cards. Before that, in the same transaction, the rows they had replaced come back: a CSV row, or a posted row of an earlier, removed Item, is restored (`replaced_by_id` and `deleted_at` cleared), with the replacing row's note (or, when both rows have a note and they differ, its own note, then the replacing row's on a new line, cut at the note limit), and its category and person when they were set by hand; a CSV row whose import was undone is hard-deleted instead, which frees its reference number; an earlier Item's pending rows stay deleted, with `removed_at` set. The confirmation and the status line after it say so.
  - The confirmation also says that removing doesn't give back a Trial connection, and that the bank may still list the dashboard as a connected app (Plaid says some OAuth banks do), to remove there too.
  - Removed banks are listed under **Removed banks** with their cards and how they went (`removed_reason`): removed keeping the transactions, removed with them (so the list never says the cards kept their history), or forgotten by the key reset (§14).

### 12.3 Transaction sync

- **Mechanism:** `/transactions/sync`, with a stored cursor for each Item, `count: 500`, and PFC v2 (`personal_finance_category_version: "v2"`), applying the added, modified, and removed lists.
  - A run follows `has_more` from the stored cursor, keeping every page, then applies them and saves the new cursor in one database transaction. A failure part way through applies nothing, and the next run starts from the same cursor.
  - `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` restarts the run from the stored cursor with the kept pages thrown away, at most 3 times.
  - A `next_cursor` of `""` (no data yet) is stored as null, so `""` is never sent.
  - Each run stores Plaid's `transactions_update_status` and the time (`last_sync_at`).
  - Every call to Plaid for an Item goes through one lock per Item, so a sync, the pick, a reconnect, and a removal never interleave.
- **When it runs:**
  - When a `SYNC_UPDATES_AVAILABLE` webhook arrives. Webhook syncs run in the background, at most one at a time per Item, and a webhook that arrives during a run makes one more run after it, so a burst folds together.
  - Every 6 hours as a backup, starting up to 30 minutes late
  - When an admin saves the pick, or clicks **Refresh** in Spend settings. Both run inside the request with a 40-second deadline, checked while waiting for the lock and before each page; past it nothing is applied or recorded, the sync carries on in the background, and the answer says "Saved. Syncing in the background." or "Syncing in the background." Refresh is "sync now": it gets what Plaid already has, ignores the backoff (§8), and is limited to 10 a minute per admin. It isn't `/transactions/refresh` (a forced bank pull), which costs per request after the Trial and needs an access request.
  - Never for an Item that's removed, waiting for the pick, or needing a reconnect. Scheduled and webhook runs also skip one in backoff.
- **Applying a run:**
  - Added and modified are one upsert by `plaid_transaction_id`, so a full resync is harmless. Categories go through the rules and the mapping with the stored row as the current value, so a manual edit stays and re-evaluation never erases history (§12.8). A row whose values didn't change isn't written at all, so a stale draft in the drill-down doesn't see a false conflict (§12.12).
  - Transactions on a skipped account, or one with no card, are dropped and counted.
  - Transactions for an account the Item's list doesn't have at all (a new account, or an id Plaid changed) aren't applied: they're counted, and they set `new_accounts_at`, so Spend settings offers Load accounts and Add accounts (§12.2). Nothing is lost past the cursor: attaching an account after the first pick asks for a full resync (after catching up from the cursor), and that resync is idempotent.
  - Currency: Plaid's `iso_currency_code`, null when Plaid sends an `unofficial_currency_code` instead, which is kept too. The column's `USD` default never applies to a Plaid row.
  - Merchant text: Plaid's `merchant_name` as the merchant and its `name` as the raw description, with runs of spaces collapsed; plus the PFC primary, detailed code, confidence, and version.
- **Amounts** are stored as whole cents. Positive means money spent, which is Plaid's convention. Negative means refunds, credits, or payments. A Plaid amount with more than two decimal places is rounded to the nearest cent and counted in the sync's log line, never silently. One past the limit in §12.10 is dropped and counted.
- **When a pending transaction posts:**
  - The posted transaction arrives with a `pending_transaction_id` pointing to the pending one. When Plaid sends none, a pending Plaid row on the same card that Plaid removed in the last 7 days, hasn't been carried over, and passes the duplicate test (merchant, then raw name) is taken instead, before churn is tried.
  - If the pending one had a manual category, a manual person, or a note, those are copied to the posted transaction. The pending row gets `replaced_by_id`, so it's never carried over twice, and is soft-deleted if it's still there.
  - Removed pending transactions are soft-deleted and kept for 7 days. That way the carry-over still works if the removal arrives before the posted version, in the same run or a later one.
- **Removed transactions,** pending or posted, are soft-deleted (`removed_at` and `deleted_at`), and `spend.pruneRemoved` hard-deletes them after 7 days. Removed posted ones are counted in the log line.
- **Churn:** Plaid can remove a posted transaction and add it again under a new id when the bank changes it a lot. A new posted row with no pending version is matched by the duplicate test (§12.13) against posted Plaid rows on its card that were removed in the last 7 days and haven't been carried over yet, and takes the match's manual fields. Whatever pointed at the churned row (a CSV row it had replaced, say) is pointed at the new row, since the churned row is pruned after 7 days.
- **Replacing CSV rows,** and an old Item's rows after a bank is linked again: §12.13.
- **Webhooks** (verified as in §15): `TRANSACTIONS` `SYNC_UPDATES_AVAILABLE` syncs. `LIABILITIES` `DEFAULT_UPDATE` reads statements (§12.4). `ITEM` `ERROR` with a login code isn't trusted as it is, since webhooks can come late and out of order: `/item/get` is asked first, and `needs_reconnect` is set only if the Item's error still says so, so a `LOGIN_REPAIRED` that arrived first wins. The daily 06:00 job asks `/item/get` the same way about every Item that needs reconnecting and clears the state when Plaid reports no error, except after `USER_PERMISSION_REVOKED`, which `/item/get` isn't documented to report. `USER_PERMISSION_REVOKED` sets `needs_reconnect` (both fixes offered, §8); other `ERROR` codes wait for the next sync to record them. `LOGIN_REPAIRED` clears `needs_reconnect` and syncs. `NEW_ACCOUNTS_AVAILABLE` shows **Load accounts** and **Add accounts**. `PENDING_DISCONNECT` stores the date to reconnect by, or a week from now when it has no `disconnect_time`. `CONSENT_UPDATED` stores the new consent end. The legacy transaction codes (`INITIAL_UPDATE`, `HISTORICAL_UPDATE`, `DEFAULT_UPDATE`, `TRANSACTIONS_REMOVED`) and `WEBHOOK_UPDATE_ACKNOWLEDGED` are acknowledged and ignored. A webhook for an unknown or removed Item, or with an `environment` that isn't `PLAID_ENV`, is logged and ignored. A Savings Item's webhooks: §21.4.
- **Logs** (`plaid link`, `plaid exchange`, `plaid sync`, `plaid webhook`, `plaid liabilities`) carry ids, counts, and Plaid's `error_code`, never a token, a webhook body, a Plaid response body, or merchant text.

### 12.4 Statements and billing cycles

- **Closing dates** are stored as `statements(card_id, closing_date, source)`, where the source is `plaid`, `inferred`, or `manual`.
- **From Plaid:**
  - Each day at 06:00 family time, and when a `LIABILITIES` `DEFAULT_UPDATE` webhook arrives, `/liabilities/get` runs once per Item (Plaid refreshes liabilities about once a day), and the entries for the Item's attached cards, included or not, are used.
  - When `last_statement_issue_date` is new, it's recorded with source `plaid`, with the statement balance, payment due date, and minimum payment. A Plaid date already stored is refreshed. A date within 15 days (inclusive) of a manual date is skipped: the admin's date wins, rather than two statements for one cycle. A new date within 15 days (inclusive) of a Plaid date already stored for the card (the bank moved it by a day, say) replaces that row, its date and fields, rather than adding a second one.
  - When that date is the card's latest known one, it also updates the card's **usual closing day**, its day of the month.
  - `NO_LIABILITY_ACCOUNTS` and `ACCESS_NOT_GRANTED` from `/liabilities/get` aren't connection failures, and an entry with no statement date is skipped: those cards keep their inferred dates (whether BofA fills the date is §19 item 1).
- **Inferred dates:**
  - One each month on the usual closing day, clamped to the length of the month (the 31st is February 28 or 29, April 30).
  - They're worked out whenever they're needed and never stored, so they always follow the usual closing day: changing it moves every inferred date, past ones included. To keep a past statement's real date, add it as a manual date.
  - Each known date (manual or Plaid) replaces the one inferred date nearest it, if that's within 15 days, since that statement is already known. Only one, so a known date never swallows two statements. So inferred dates fill the period before the earliest known statement (back to the earliest transaction), any gaps between known statements, and the time since the latest one, through two months past the later of today and the latest transaction (so a transaction dated after today still has a cycle).
  - With no usual closing day set, the day of the latest known date is used.
- **Manual dates:**
  - Admins can add, edit, or delete closing dates for each card in Spend settings, up to two months ahead.
  - Manual dates override inferred ones, and inference never overwrites them. A manual and a Plaid date on the same day count once, as manual.
  - Editing a date that came from Plaid turns it into a manual date. Plaid dates can't be deleted, since the next sync would bring them back.
- **Cards with no closing day and no known date** (CSV-only cards): until the admin sets the usual closing day, the drill-down groups by calendar month and shows a notice.
- **Cycle definition:**
  - A cycle runs from the day after one closing date through the next closing date, inclusive.
  - The **current cycle** is the one that contains today: from the day after the latest closing date, through the next one (shown as the cycle's range, with its total "so far"). If known dates leave no closing date after today, it runs through today.
- **Assigning transactions to cycles:** a transaction belongs to the cycle that contains its date. That's Plaid's posted date for posted transactions, the transaction date for pending ones, and the Posted Date for CSV rows.

### 12.5 Categories

- **Admins manage the category list.** Each category has a name, a sort order, and an archived flag.
- **Default categories:**
  - Groceries
  - Dining
  - Gas and auto
  - Shopping
  - Home
  - Utilities
  - Subscriptions
  - Entertainment
  - Travel
  - Health
  - Kids
  - Gifts and donations
  - Fees and interest
  - Other
- **Two special categories** can't be deleted:
  - **Payments and transfers**, which is excluded from spend totals
  - **Uncategorized**
- **Archiving a category:** transactions keep it, and it shows as archived, but it can't be chosen for new assignments, and rules and the Plaid mapping that name it skip it.
- **Ordering:** admins move categories up and down with buttons (no dragging), which work from the keyboard. New categories go at the end.
- **Deleting a category:** only a normal category nothing uses. One used by a transaction (deleted ones included), a rule, or the Plaid mapping can be archived instead. The special categories can be renamed and moved, but not archived or deleted. Names are unique, ignoring case.

### 12.6 Person assignment

- **Every transaction is assigned to Household or to one family member.** A new transaction is **Household** until a manual edit or a rule assigns someone.
- **Any active user can be assigned**, including users without the Spend panel.
- **Deactivated users** keep their past assignments, which still show their name, but can't be assigned to new transactions.

### 12.7 Mapping Plaid categories

- A table maps Plaid's `personal_finance_category` to family categories. The detailed Plaid category is checked first, then the primary one. A mapping to an archived category is skipped.
- The defaults are Plaid's current taxonomy, PFCv2 (teams enabled after 2025-12-03 get only v2): all 18 primaries, and the detailed codes whose answer differs from their primary's (docs/research/spend-plaid-csv.md §2.4). Codes don't clash between v1 and v2, so one table holds both, and each row records the taxonomy version its code comes from.
- Admins edit the mapping in Spend settings' **Bank categories**: each row's code, whether it's a primary or a detailed code, its taxonomy version, its category (an archived one is flagged), and how many transactions have it, plus the codes seen on transactions that have no row, with what they fall back to. A code with a row, or one seen on a transaction, can be set to any usable category. A detailed code's row can be deleted, so it falls back to its primary; a primary's can't, since its detailed codes fall back to it. A change applies from then on, and to past transactions with **Apply to past transactions**, which also applies the rules (manual values stay). The editor works without Plaid's keys, since the codes are worth seeing either way, but it's hidden while Plaid isn't configured and no transaction has a Plaid code. CSV rows have none. Examples:
  - `FOOD_AND_DRINK_GROCERIES` → Groceries
  - `FOOD_AND_DRINK` → Dining
  - `TRANSPORTATION_GAS` → Gas and auto
  - `LOAN_PAYMENTS`, `TRANSFER_IN`, `TRANSFER_OUT` → Payments and transfers
- **One Save for the whole editor** (the owner's rule from 6a: one Save that saves every field edited by hand):
  - Changing a code's select makes a draft and saves nothing. Each changed row says "Changed, not saved". A bar at the end of the section counts the drafts ("Save 3 changes", with how many are in the folded list of every code) and offers **Discard changes**, which asks first when there's more than one.
  - Save sends every draft in one `PATCH /api/panels/spend/mappings`, which saves all of them or none. Each change carries what the code held when it was picked. If someone else has changed one since, the whole Save is refused with a 409, that row is flagged with what it holds now ("Someone else changed this to X. Your pick isn't saved yet."), and saving again uses the pick. A refusal about one code (an archived category, say) is shown beside its row. A code that's gone is dropped, and the bar says so.
  - The drafts are kept in the browser's session storage under the drafts prefix, so a reload keeps them, and signing out clears them. A fresh view drops drafts that now match what's saved, and flags codes someone else changed.
  - While there are drafts, leaving Spend settings asks first: another page in the app (the router's guard), signing out, the full page loads of Connect bank, Reconnect and Add accounts, and closing or reloading the tab (the browser's own prompt). Agreeing drops them. A click that opens a link in a new tab doesn't ask.
  - Focus: after a Save, on Save when drafts made meanwhile are left, else on the section's heading. A refusal focuses the select of the row it's about, opening the folded list first when the code is in it, else the message in the bar. After Discard, on the heading.
  - A Save whose answer never came is checked against the mapping fetched again: what was sent and now shows saved goes, a pick made since stays, a code someone else changed is flagged, and the message says what's left.

### 12.8 Rules (admins only)

- **Rules form an ordered list.** Admins reorder them with move up and move down buttons, which work from the keyboard. New rules go at the end, except one made with **Add rule** on a transaction, which goes first so it wins for that merchant.
- **A rule matches on:**
  - Text, with a match type of `contains` or `exact`, case-insensitive. The text is compared against the merchant name, or the raw description when there's no merchant name.
  - Optionally, a specific card.
  - Optionally, an amount range (minimum and/or maximum).
- **A rule's actions:**
  - Set the category
  - Set the person, to a user or to Household
  - A rule must have at least one of these actions.
- **Category and person are evaluated separately.** For each field, the first matching rule in order that sets that field wins. For example, a rule that only sets the person doesn't stop a later rule from setting the category.
- **Rules naming a deactivated user or an archived category** stop applying that action until they're edited (their other action still applies). Spend settings flags these rules, and rules on an archived card. Saving a flagged rule without changing the flagged value is allowed; it stays flagged.
- **Creating a rule from a transaction:** **Add rule** fills in a new rule from the transaction. It matches text containing the merchant name and uses the category and person the row shows, including ones picked but not saved yet. Household fills in only when it was picked or set on purpose, not when it's just the default. An archived category or a deactivated person is left out. The admin can change any of it before saving, and it's applied to past transactions unless the admin unticks that.
- **The default rule:** the app starts with one rule, which puts a credit (an amount of -$0.01 or less) whose text contains `PAYMENT` in Payments and transfers. CSV rows have no Plaid category, so without it every card payment would count as a refund. Bank of America's exact wording for payments is unverified; admins can edit or delete the rule.
- **Applying rules:**
  - When saving any rule, the admin can choose **Apply to past transactions**. That re-evaluates every transaction except fields someone set by hand, and fields whose value can no longer be assigned (an archived category, a deactivated person): re-evaluating never erases history.
  - Rule text is compared after Unicode compatibility normalization (NFKC) and lowercasing on both sides, so full-width letters and differently encoded accents match.
  - Spend settings also has **Apply rules to past transactions** on its own, for after a rule is deleted or reordered: a deleted rule's work stays on past transactions until then.
  - Rules apply automatically to new and modified transactions.

### 12.9 Precedence

Each transaction's category and person are decided by these rules, in order:

| Field | Precedence |
|---|---|
| Category | Manual edit → first matching rule → Plaid mapping → Uncategorized |
| Person | Manual edit → first matching rule → Household |

- Each field records where its value came from: `manual`, `rule`, `mapping`, or `default`.
- **Remove rule** (on a transaction row) resets a field to automatic: it clears a manual edit and re-evaluates the field. It's the only thing that re-decides a field whose value can no longer be assigned; every other re-evaluation keeps it.

### 12.10 Totals

- **Spend** for a set of transactions is the sum of their amounts, excluding **Payments and transfers**.
- Refunds are negative, so they reduce the total for their category and person.
- The current cycle's totals include pending transactions, which are labeled as pending.
- Amounts are whole cents, with a currency (USD for CSV rows; for Plaid rows the official code, or else the unofficial one). One transaction is at most $10,000,000 either way. A total adds only the card's own currency, and is shown in it; transactions in another currency are left out and the drill-down says how many.
- A negative total (more refunds and payments than spending, outside Payments and transfers) reads as an amount "in credits", not a negative amount spent.

### 12.11 Summary card

- For each included card: its nickname, the current cycle's date range, and the cycle's total so far.
- Under the total, where the cycle is headed: "On track for $X by <end date>" (§12.12, the same rule).
- The last 8 transactions across all included cards. Each shows its date, merchant, and amount, plus a pending label when relevant and a person tag when it isn't Household.
- "Updated X ago" for each card. For a card with only CSV data, that's when a CSV was last imported into it. For a card on a linked bank, it's the later of its Item's last completed transaction sync (`plaid_items.last_sync_at`) and the card's last import, by the server's clock. Such a card warns when that's more than 12 hours ago (§8), and when its bank needs reconnecting it says so instead, with a **Reconnect** link for admins. A card whose bank was removed is like a CSV-only card.

### 12.12 Drill-down

- **Pickers:**
  - Card picker
  - Cycle picker covering the current cycle and every past cycle with data, labeled with dates
- **Totals:** the cycle total, compared with the previous cycle.
- **On track (current cycle only):** under the total, "On track for $X by Dec 15", in tabular numerals. X is the total shown (so the same exclusions: Payments and transfers, removed duplicates, other currencies; pending counts) ÷ the days elapsed, today included, on the family's calendar (the family time zone, by the server's clock) × the days in the cycle (start and end both count). Rounded to the cent. It isn't shown for a past cycle, on the cycle's first day (one day times thirty is noise), or while the total is zero or in credits (there's no rate). On the last day it equals the total. Pure helper: `projection.ts`.
- **Charts:** each breakdown (By category, By person) is a donut beside a table that is both its legend and its data. Drawn as inline SVG (no chart library, so it fits the CSP), colored from the `chart-1` to `chart-8` tokens in fixed order (largest slice first) plus a neutral `chart-other`, each validated for color-vision separation and at least 3:1 against `surface` in both themes. A 2px surface gap separates slices. Slices come from a pure helper (`pie.ts`):
  - Only rows that spent something this cycle (more than zero) are drawn; a row at zero (only last cycle) or in credits (refunds) stays in the table, last, marked "Not in the chart" for screen readers. The shares are of the drawn total, so they add up to 100% even with refunds.
  - Largest first; equal amounts keep the server's order, so the donut and the table agree.
  - The smallest slices whose combined share is at most 5% become one **Other** slice, unless only one would go in it: then it's shown on its own. Equal amounts are never split across that line (both stay named).
  - At most 8 slices get a color; with more, the 7 largest keep theirs and the rest join Other (so Other always holds at least 2).
  - Other's row in the table shows its count ("3 smaller"), combined amount, and share, and its members are always listed under it (with the Other swatch), each its own filter button. Other itself isn't a filter, so pressing its slice does nothing.
  - The SVG is one image to assistive tech, named with a one-line summary ("Spending by category, this cycle: Groceries 54%, ... Other 5%."); the table (name, this cycle, share, last cycle) carries every number. Pressing a named slice filters the table exactly as its name's toggle button does (the button stays the keyboard's way in; slices aren't tab stops). When a filter is on, the other slices fade. Hovering or touching a slice names it, its amount, and its share in the donut's middle.
- **By category:** a donut (Charts, above) and its table, sorted by amount, with each one's share and the previous cycle's amount. Clicking a name or its slice filters the table; each name is a toggle button.
- **By person:** Household and each person, as a donut and its table like By category, with the previous cycle alongside. Clicking one filters the table.
- **Filters:** person, category, and merchant search.
- **Transaction table:**
  - Columns: date, merchant, category (editable inline), person (editable inline), amount, pending label, and a note icon.
  - **Sorting:** by date (the default, newest first), by name (the merchant, or the raw description when there's none, ignoring case), or by amount, each either way. The Date, Merchant, and Amount headers are buttons: clicking the sorted column turns it around, and clicking another sorts by it, starting newest first, A to Z, or largest first. The sorted header has `aria-sort` and a chevron. Phones, which show the table as a list, get a **Sort by** select beside the filters instead. Ties break newest first, then by id, so the order is stable and twins (below) sit together when sorted by amount. The sort is in the query string (`?sort=name|amount`, `?dir=asc|desc`, each left out at its default) and applies to every row the filters keep: the drill-down has the whole cycle, so sorting is done in the browser. Re-sorting leaves drafts, the Save bar, and each control's name as they were (rows are named in date order, so "1 of 2" doesn't change with the sort).
  - **Twins and Remove duplicate (admins):** two live transactions (not deleted, not removed by the bank) on the same card with the same date and the same amount, whatever their names, are twins. The transaction list's rows say which they have (`twinIds`, found with one self-join per 500 rows). Many twins are real repeat purchases, so nothing removes one by itself: an admin sees **Remove duplicate** on each row that has a twin, which acts at once (no confirmation, since Undo is right there). While the row has unsaved picks the button waits (`aria-disabled`), saying "Save or discard its changes to remove it." (visibly, and as its accessible description), so picks are never dropped with the row.
    - The server (`POST /transactions/:id/remove-duplicate`, admins) refuses (409) a row that's already deleted or has no live twin. Otherwise it soft-deletes the row (`deleted_at`, `deleted_reason` 'duplicate', and `duplicate_of_id` naming the twin, the lowest id when there are several). With exactly one twin, the row's manual category, manual person, and note are copied to the twin where it has none of its own yet (as a replacement copies a CSV row's, §12.13), and what was copied is kept (`duplicate_carry`). All in one transaction.
    - The row leaves the list, the totals and breakdowns refresh, a twin left with none loses its button, focus moves to the next row's category picker (or the Transactions heading), and the status line says "Removed duplicate: <merchant, date, amount>." with **Undo**.
    - **Undo** (`POST /transactions/:id/restore-duplicate`, admins) brings the row back and takes back each field it copied to its twin, only where the twin still holds exactly the copied value (a category or person is decided again, as Remove rule does; a note is cleared). A field someone has changed on the twin since stays. It's refused (409) for a row that isn't a removed duplicate, that the bank has removed since, or (a CSV row) whose import was undone since (nothing could remove it again; importing the file again is the way back). While Undo is out it stays in place, focused and `aria-disabled`; then focus goes to the row's Remove duplicate button. A failed Undo stays offered, with focus on it.
    - **It stays removed.** It's left out of totals, breakdowns, cycles' dates with data, the home card, and rules or the mapping applied to past transactions, like any deleted row. A CSV row keeps its reference number, so importing its file again skips it. A Plaid row isn't brought back by a sync: a modified or re-added entry updates its fields and leaves it deleted (one Plaid removed and lists again gets `removed_at` cleared, not `deleted_at`). When a row removed as a duplicate posts, or churns under a new id, the new row takes its place removed as well, but only while it still has a live twin: a new amount or date (a tip, a fuel hold) makes it a real charge, left live. What was removed as the duplicate of a pending or churned row follows it to the new row while that's still its twin; otherwise it points at another live twin, or comes back.
    - **Losing the twin brings it back.** When its twin goes for good (hard-deleted by an import's undo, by **Also delete its transactions**, or by the prune after the bank removed it; or a posted row the bank removed that nothing took the place of), the row removed as its duplicate comes back, unless it still has another live twin, which it then points at. A CSV row whose import was undone isn't brought back (there'd be no import to undo it with): it's hard-deleted instead, which frees its reference number for the file's re-import, as with a replaced row (§12.13). Two copies someone can fix by hand beat one that's silently hidden.
    - **Undoing an import** keeps the import's own rows removed as duplicates, like its replaced ones: still deleted, `csv_import_id` cleared, holding their reference numbers, so a re-import skips them.
  - Picking a category or person only changes a draft for that row, so moving through a picker's options with the keyboard never saves. An edited picker is marked and says "Changed, not saved" (also its accessible description). Picking the saved value again clears that field's draft.
  - A draft is made against the value saved when it was picked. If fresh rows show someone else has since saved a third value, the draft stays and the picker says "Someone else changed this to C. Your pick isn't saved yet." A pick whose category was archived, or whose person was deactivated, since it was made stays shown as such and says so. Either way the mark is visible and in the accessible description.
  - While there are drafts, one bar offers **Save N changes** (N counts edited fields, not rows, with "(M not shown)" when some are on rows a filter, search, or another cycle hides) and **Discard changes** (which asks "Discard N changes?" when N is more than 1). It's held to the bottom of the screen wherever the page is scrolled, sits after the last row once that's reached, and a live region announces the count and "Saving…". While it shows, the page's scroll padding is its height, so a control that gets focus is scrolled clear of it. A **Go to Save (N changes)** button by the Transactions heading moves focus to Save.
  - Save sends every draft in one request that saves all of them or none (`PATCH /transactions`). Each change says what the page last saw saved in each field, and the server refuses (409) a field someone else has changed since. One save takes changes on up to 500 transactions; past that, the bar says how many to undo first. After a save, the status line says "Saved N changes.", adding "M transactions no longer match the filter, so they're hidden." when saved rows that were showing are now hidden, and focus moves to the Transactions heading.
  - If the server refuses, nothing is saved and every draft stays, except drafts for transactions that no longer exist, which are dropped ("1 change was for a transaction that no longer exists and was removed."), so Save works for the rest. A transaction a bank sync replaced (a pending one that posted, a churned one, or a CSV row a Plaid row took over) isn't lost that way: the 404 names the row that took its place (`replacedBy`, following a chain of replacements), and its drafts move onto that row ("1 change was for a transaction a bank sync replaced, so it was moved to the new one."), keeping what the page last saw saved, so the next Save gets the usual 409 if the new row holds something else. Fields someone else changed are flagged as above. A refusal about one row names it by merchant, date, and amount, and focus goes to its picker when it's shown (the message is then an alert), or else to the message.
  - Drafts are kept by transaction, so a filter, a search, or another cycle of the same card keeps them, and a hidden row's drafts still count and are still saved. They survive a reload: they're kept in the tab's session storage by person and card (ids and picks only), and cleared by Save, Discard, agreeing to leave, and signing out. Drafts that fresh rows show are already saved, or that are for a transaction gone from its cycle, are dropped, and the page says why. Switching card, opening Spend settings, leaving the page, or signing out asks "Discard N unsaved changes?" first ("Your changes are still saving. Leave anyway?" while a save is out); closing or reloading the tab gets the browser's own leave prompt, whose wording the page can't set. A card that stops being shown (excluded meanwhile) drops its drafts, and the page says so.
  - Notes, Add rule, Remove rule, and Remove duplicate act at once. Remove rule also clears the drafts of the fields it resets, unless they were picked again while it was out, and the status line says "Rule removed: <merchant>." Add rule starts from the row's drafted category and person when it has them. When Remove rule or a new rule takes a row out of the current filter, the status line says so and focus moves to the next row (or the Transactions heading).
  - Each control's name includes the transaction's merchant, date, and amount.
  - Row actions: add or edit a note, **Add rule** (admins; its dialog is titled Add rule, and saving says "Rule added."), **Remove duplicate** (admins, on a row with a twin), and **Remove rule** (shown when the category or person was set by hand, or keeps a value that can't be assigned any more; it resets each such field).
  - Each picker says where its value came from: set by hand, by a rule, or from the bank.
  - On phones the table is a list.
- **Spend settings (admins only):**
  - Banks, with Plaid configured (§12.2): **Connect bank** and the Trial count; each bank's status, last sync, and last error; **Choose cards** (or **Load accounts** while the accounts aren't loaded), **Refresh**, **Reconnect** (after `USER_PERMISSION_REVOKED`, with a line saying that removing the bank and connecting it again works too), **Load accounts** and **Add accounts** for new accounts, and **Remove**; notices for new accounts, the date to reconnect by, cards the bank stopped sharing, and removals Plaid never confirmed; and the removed banks, each by how it was removed. A sync that ran past the request's deadline shows "Saved. Syncing in the background." or "Syncing in the background." beside the bank. `?bank=<id>` opens that bank's pick, and `?bank_error=<code>` shows why a link didn't finish, with focus on the message.
  - CSV import
  - Cards: nickname, last 4, included or not, usual closing day, closing dates, archive, and delete (only without transactions). A card whose bank was removed says "bank connection removed".
  - Categories
  - Rules
  - Bank categories: the Plaid category mapping (§12.7)

### 12.13 CSV import (admins only)

- **Upload:** the admin picks a card (not an archived one) and uploads a Bank of America credit-card activity CSV, up to 5 MB and 20,000 rows, as a form upload behind the CSRF check. The browser checks the size first too.
- **Expected format** (docs/research/spend-plaid-csv.md §1, from community importers; still to check against a real export, §19):
  - The first line is exactly `Posted Date,Reference Number,Payee,Address,Amount` (after trimming each cell). Only the first non-blank line is checked: a file whose header is further down is refused.
  - UTF-8, a byte order mark allowed; lines end in CRLF, LF, or CR. Every field is trimmed (BofA pads them). Dates are `MM/DD/YYYY`. Amounts have no currency symbol, with or without thousands separators.
  - BofA exports purchases as negative amounts. The importer flips the sign to match the app's convention (positive means money spent).
  - Reference numbers are stored as text: they're 23 digits, too long for an integer.
  - Bank of America's checking and savings export is recognized and refused with a message saying only credit-card activity can be imported. Any other header is refused with a message naming the expected one; one that has `Posted Date` but other columns also names the columns found (the header only, never row data).
  - The parser is a small strict RFC 4180 parser: a malformed row fails on its own, with its line number. For this file a quoted value may not span lines (BofA's never do), so a quote still open at the end of its line fails that row, and a file of stray quotes stays quick to read. Empty lines are skipped.
  - A payee or address over 200 characters, a reference number over 40, or a posted date before 2000 or more than 31 days after today makes the row unreadable.
- **Preview before saving:**
  - The server reads the file and keeps only the rows, for an hour, under a random id, bound to the admin who uploaded it (a new upload replaces their earlier preview).
  - Number of rows, date range, rows flagged as likely duplicates, and the rows that can't be imported, with why: unreadable (wrong number of values, a bad date or amount, no reference number or payee, a stray quote), a reference number already stored, one repeated in the file, or a temporary credit that hasn't posted (an empty date, or `TEMPRET` as the reference; `TEMPRET` is never stored).
  - Warnings, which don't block saving: most rows are credits after the sign flip (the sign convention may have changed), or the file name ends in last 4 digits that don't match the card's. A row that passes the duplicate test in everything but the reference number (both have one, and they differ) isn't a duplicate, but it's shown with "Possible duplicate (different reference number)" and the transaction it looks like, still ticked, so a bank that renumbers transactions between downloads gets noticed.
  - The admin can include or exclude individual rows. Likely duplicates start out excluded. Saving imports the rows that are ticked.
- **Duplicate test.** A row is a duplicate of an existing transaction when all of these hold:
  - Same card
  - Same amount
  - Dates no more than 3 days apart
  - The bank hasn't said they differ: if both have a reference number, it's the same one. (So a CSV row is only ever a likely duplicate of a row without one, such as a Plaid transaction.)
  - Similar merchant text. Normalize both strings: uppercase, turn anything that isn't a letter or digit into a space, collapse runs of spaces, and trim. They're similar if one starts with the other's first 8 characters, with the spaces kept or with them all removed (so "CVS/PHARMACY" matches "CVSPHARMACY"), or if at least half of the larger set of words is shared. These thresholds are constants that can be tuned.
  - A stored row with both a merchant name and a raw description (a Plaid row) is similar when either one is. Plaid sometimes cleans a merchant name past recognizing ("Tinynonsens" for the bank's "PAYPAL *TINYNONSENS 207-200-") while its raw description keeps the bank's text. This is the import's side of the test; a Plaid row tested against CSV rows likewise tries its merchant name, then its raw description.
  - Matching is one to one: rows are matched in file order, each to the nearest-date transaction still unmatched, so two same-amount tolls a day apart don't both match one stored toll.
- **Imported rows:**
  - Get source `csv` and keep their reference number.
  - Have rules applied. They have no Plaid category, so a row that no rule matches is Uncategorized.
- **Importing the same file again:** rows whose reference number is already stored for that card are skipped, including deleted rows (a CSV row that a Plaid transaction replaced, or one removed as a duplicate, never comes back).
- **Each saved import is recorded** (card, file name, a SHA-256 of the file, who, when, and counts), never the file itself. Nothing from the file is ever logged: log lines carry counts only.
- **When Plaid later delivers a transaction that matches a CSV row** by the duplicate test:
  - Only posted Plaid transactions replace CSV rows. A CSV row is a posted transaction, and a pending amount can still change (a fuel hold, a tip), so a pending row shows beside its CSV twin until it posts.
  - Each new posted Plaid row is tested against the live CSV rows on its card, with its merchant name, then its raw description.
  - The Plaid transaction is kept.
  - The CSV row's manual category, manual person, and note are copied to it, where it has none of its own yet.
  - The CSV row is soft-deleted, with `replaced_by_id` naming the Plaid row, so it's never matched again. It keeps its reference number, so importing the file again skips it.
  - A new Plaid row that a CSV or old-bank row already points at (it took one over from churn) takes no other.
  - Matching is greedy and one to one, like the import's: the new rows are taken in a fixed order (card, amount, date, Plaid id), whatever order Plaid sent them in, each to the nearest-date candidate still free. That's deterministic but not always the most matches: two same-amount CSV rows 4 days apart against two Plaid rows can leave one pair unmatched, which then shows twice until an admin deals with it by hand. Maximum matching is deferred until it's seen.
- **Undoing an import after a replacement:** the undo hard-deletes only the import's live rows. Replaced ones (and ones removed as duplicates, §12.12) are kept, with `csv_import_id` cleared, so a re-import still skips them and the CSV row never comes back beside its Plaid twin. The check for values set by hand counts live rows only: a replaced row's manual fields already moved to its Plaid row.
- **A bank linked again:** after a Remove that kept the transactions, or a key reset (§14), the new Item sends up to 730 days again under new transaction ids, and on the same card that would double the history. So the same pass also takes the card's live Plaid rows whose account isn't attached to any linked Item (in practice the old Item's, pending ones included, since that Item will never post them, or an account id the bank changed, §12.2) and replaces them like CSV rows, with the same rule for a new row already pointed at. Rows of a linked Item, the current one's included, are never candidates.

### 12.14 Permissions

- **Anyone with the Spend panel** can view everything, change a transaction's category or person, add notes, and reset fields to automatic.
- **Admins only:**
  - Remove duplicate and its Undo
  - Bank connections
  - Card settings and closing dates
  - Categories and the Plaid mapping
  - Rules
  - CSV import

---

## 13. API conventions

- **Format:** JSON over HTTPS. Every request and response is validated with the zod schemas in `src/shared`.
- **Endpoint groups:**
  - `/api/me`
  - `/api/admin/…`
  - `/api/panels/<id>/…`
  - `/auth/…`
  - `/connect/…`
  - `/webhooks/plaid`, `/webhooks/todoist`
- **Requests that change data** must include the header `X-Requested-With: dashboard` (§15).
- **Errors** look like `{ "error": { "code": "...", "message": "..." } }`. Codes include `unauthenticated`, `forbidden`, `not_found`, `validation`, `conflict`, and `integration_unavailable` (HTTP 503).
- The full list of endpoints is produced during implementation planning.

---

## 14. Error handling

- **Connection status:** each connection reports its status as described in §8.
  - Cards always show "Updated X ago," and a warning when the data is stale.
  - When a login expires or is revoked, whoever owns that connection sees a **Reconnect** prompt on the affected card and on the Integrations page. That's an admin for family connections and the user for Todoist.
  - For Plaid, **Reconnect** is on the card and in Spend settings (Integrations shows the status and links there), and opens Plaid Link's update mode on the existing Item. A connection Plaid no longer has (`ITEM_NOT_FOUND`, `INVALID_ACCESS_TOKEN`) says to remove the bank and connect it again instead, since update mode can't fix it.
- **Background job failures:**
  - Jobs retry with exponential backoff, up to one hour between attempts.
  - The most recent error appears on the admin page's System section.
  - Every job run is logged as structured JSON, readable with `journalctl` or `docker logs`.
- **Changes a user makes:** changes that go to Google, Todoist, or Plaid are sent immediately while the user waits. If one fails, the user sees an inline error and nothing changes locally. There's no hidden offline queue. Two Plaid exceptions: removing a bank completes here even when Plaid doesn't confirm, and the removal at Plaid is retried (§12.2); a saved pick stays saved when the sync after it fails, which the bank's status shows; and a pick's or Refresh's sync that runs past 40 seconds carries on in the background, which the page says.
- **Changes the app makes in the background:** for example, putting a chore on a Todoist list. These are retried (§11.5), and their pending state is shown in the UI.
- **Incoming webhooks:**
  - The signature is verified (§15). For Plaid, a bad signature gets 401, which Plaid doesn't retry, and a verification key that can't be fetched gets 503, which Plaid retries for up to 24 hours.
  - A sync is queued, and the app responds 200 right away.
  - A missed webhook costs only time: the 6-hourly Plaid sync and the 10-minute Todoist sync catch up.
  - Duplicate webhooks do no harm, because syncs pick up from a cursor or sync token.
- **Calendar unreachable:** the panel shows the last events it fetched, read-only (§9.2).
- **Lost or changed `TOKEN_ENCRYPTION_KEY`:** the key check fails at startup while tokens are saved. Integrations stop, linking is refused with a plain message, and the System page says why; the calendar shows its last fetched events read-only. Putting the original key back restores every connection. If the key is lost, an admin sets a new key and presses "Reset links for a new key" on the System page, after a confirmation. That disconnects Google Calendar, turns every linked person's to-dos back into dashboard to-dos in place, deletes the saved tokens (they can't be read, so they can't be revoked; each account can remove the app's access in its own settings), and stores a check for the new key. Each bank it forgets, and each bank removal still waiting for Plaid to confirm, gets the lasting notice in Spend settings and on the System page saying to remove the dashboard at the bank or at my.plaid.com, until an admin dismisses it. Then an admin connects the calendar again, and each person connects Todoist again. With no tokens saved at all, a new key simply replaces the old check. All other data is unaffected.
  - **With Plaid,** a mismatched key also stops bank syncing, linking, Refresh, and Remove; Spend still shows every transaction. The reset also forgets every bank: its connection and any waiting removal are deleted, the Item and its cards are marked removed (`key_reset`, listed under **Removed banks**), any link session is dropped, and every transaction is kept but the Items' pending ones, which are soft-deleted for the prune, since they'll never post. The access tokens can't be read, so the old Items can't be removed at Plaid and stay active there until they expire, and each bank linked again uses another Trial connection; the confirmation says both. Linking a bank again doesn't double its history (§12.13). Refusing instead would leave a family with a lost key no way back but deleting the database.
  - Plaid or Todoist connections saved while that integration was configured, if it no longer is, refuse the reset before anything is changed, since nothing is there to forget them: put the original key back, or configure the integration again.
- **Error messages users see** say what happened and what to do next. Raw exception text is never shown.

---

## 15. Security

The site is reachable from the public internet.

- **Sign-in and sessions:**
  - Only provisioned users can sign in, each bound to their Google account ID (§4).
  - Sessions are stored on the server, and the session cookie uses the `__Host-` prefix.
- **Protection against cross-site request forgery:**
  - The session cookie is `SameSite=Lax`.
  - Every request that changes data must include `X-Requested-With: dashboard`.
  - Every request that changes data must have an `Origin` header matching `BASE_URL`.
- **Security headers:**
  - A strict Content-Security-Policy (`default-src 'self'`) on every response, errors, 404s, and the single-page app's fallback included.
  - The only exception is the two Plaid Link pages, `/connect/plaid/link` and `/connect/plaid/oauth-return`, and only when Plaid is configured. They're full page loads the server sends (never routes of the single-page app), so their policy comes with their own HTML and never reaches another page. Theirs is computed from the config: scripts `'self'` and the exact `link-initialize.js` URL (the page has no inline script, so no nonce is needed); `frame-src`, plus `default-src` and `img-src` beside `'self'`, for that script's origin (`cdn.plaid.com`); `connect-src` adding the Plaid API's origin for `PLAID_ENV`; and styles with `'unsafe-inline'`, because Link injects styles and a nonce for them isn't documented, while those pages render no user data. Everything else (`object-src 'none'`, `base-uri`, `form-action`, `frame-ancestors 'none'`) is as strict as everywhere else. Those two pages also send `Cross-Origin-Opener-Policy: same-origin-allow-popups`, since Link opens the bank's OAuth pages in a pop-up and needs to keep its handle on it; every other response keeps `same-origin`. The phase 6b plan's "Verify on first real link" has the check for CSP violations in a real link.
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, and `frame-ancestors 'none'`.
  - HSTS is set by nginx.
- **Webhook verification:**
  - Plaid webhooks: verify the `Plaid-Verification` JWT with `jose`, in this order:
    - its `alg` must be `ES256` (`none` or an HMAC `alg` is refused before any key is fetched);
    - the key for its `kid`, from `/webhook_verification_key/get`, cached in memory by `kid` and imported once, and not used past its `expired_at`. A cached key used more than 24 hours after it was fetched is fetched again, so an `expired_at` Plaid sets later is honored; a failed refetch keeps the cached key and tries again 10 minutes later;
    - the signature;
    - `iat`, checked by hand: no more than 5 minutes old, and no more than 30 seconds ahead (`jose`'s `maxTokenAge` can't allow skew ahead without stretching the age limit);
    - the SHA-256 of the exact request bytes must match the token's `request_body_sha256`.
  - A bad, missing, or stale signature, a wrong `alg`, a hash mismatch, or a `kid` Plaid doesn't know gets 401. A key that can't be fetched now gets 503, so Plaid retries: Plaid or the network is down, the fetch took more than 5 seconds (Plaid waits 10 for an answer), or the miss budget is spent. A `kid` Plaid doesn't know is remembered for 10 minutes (the map is swept on each insert and capped at 256 entries, oldest dropped first). `kid`s that aren't cached are fetched at most 10 times a minute in all and once a minute per client IP, so forged `kid`s can't run up calls to Plaid, spend the whole budget from one address, or make a real webhook signed with a new key be refused for good.
  - Replays: an accepted `Plaid-Verification` JWT is remembered (by its SHA-256) for 5.5 minutes, as long as it could verify (5 minutes, plus the 30 seconds of skew). The same JWT again in that time gets 200 and isn't processed twice. It's keyed on the JWT, not the body: two genuine deliveries can carry the same bytes, and each is signed on its own. A retry Plaid signs afresh is processed again, which is harmless, since syncs are idempotent and the other webhooks set state. A verified webhook gets 200 at once and is handled after; one for another `environment` or an unknown Item is logged and ignored. The route takes 600 requests a minute per IP, then a 256 KiB body limit, then reads the raw bytes once, then verifies. It has no session or CSRF check: the signature is its authentication. Plaid's published source addresses are "subject to change", so they're at most an extra nginx filter, never the check.
  - Todoist webhooks: verify the `X-Todoist-Hmac-SHA256` header (HMAC-SHA256 of the request body, keyed with the client secret).
- **Rate limits:** sign-in endpoints allow 10 requests per minute per IP, integration OAuth endpoints and Plaid's Link calls (`/connect/*`) 10 per minute per signed-in user, Refresh from Plaid 10 per minute per admin, and webhook endpoints 600 per minute per IP (the signature is checked after the limit).
- **Stored data:**
  - Credentials are encrypted (§8).
  - The database and backups have file mode 600.
  - Logs never contain tokens or full card or account numbers. Only the last 4 digits from Plaid are ever stored.
  - Plaid's access tokens are encrypted like every credential. The link token in `plaid_link_pending` is plain text: it can open Link for this client but can't read any data, and it's single-use, expires in 30 minutes, and is bound to one admin's session, so it isn't in the key check.
  - Plaid's `client_id` and secret go in request headers, never a body, and nothing logs request headers. Plaid logs carry ids, counts, and Plaid's `error_code`: never an access, public, or link token, a webhook body, or a Plaid response body. Plaid's `user.client_user_id` is a random value kept in settings, not a user id.
- **OAuth flows** use a `state` value bound to the session and PKCE wherever the provider supports it. Redirect URIs are fixed paths under `BASE_URL`.
- **Plaid Link** pages are for admins only: a signed-out visitor is sent to `/`, anyone else gets a plain 403. Their JSON calls are POSTs behind the CSRF checks above, admin only, and bound to the session that started the link (§12.2).

---

## 16. Testing

- **Unit tests (Vitest):**
  - Chore scheduling for every frequency: the next due date on assignment, after an early and a late close, with a future start date, and across month ends; time zone and daylight-saving changes; catching up after downtime; the board's order
  - Billing cycles, covering Plaid, inferred, and manual dates, gaps between statements, and clamping to month length
  - Category and person precedence, including evaluating rules separately for each field
  - The CSV parser and duplicate detection
  - Carrying fields over from pending to posted transactions, and from CSV rows to Plaid transactions
  - Applying a Plaid sync run: the same run twice changes nothing, carry-over whichever order the removal and the posted version come in, churn carried over once (and what pointed at the churned row re-pointed), CSV replacement giving the same result whatever order Plaid sends rows in, and transactions for an unknown account held back
  - Removing a bank with its transactions: only its own rows go, and what they had replaced comes back
  - The Plaid client's error classes (`TRIAL_CONNECTION_LIMIT` before other rate limits) and retries (idempotent reads only), and amounts
  - Plaid webhook verification: `alg`, unknown, rotated, and expired keys, the cache, its daily refetch, and the miss limits (overall and per IP), `iat` both ways, a one-byte body change, a replayed JWT, and a key that can't be fetched
  - Permission checks for every route group
  - The rules for linking chores and to-dos (§11.5)
  - The Savings month breakdown (the first partial month, the held current month, gap months, the total's mixed start), the six-month series with carry-forward and joins, and flow classification for each Plaid kind (§21)
- **Integration tests:**
  - `CalendarProvider` and `TodoBackend` each have an in-memory fake. Plaid has `FakePlaid` (`src/server/test/fakePlaid.ts`), an in-memory Plaid given to the integration as its `fetch`: link tokens, the exchange, Items and accounts, `/transactions/sync` with cursors, pages, mutations, pending to posted, removals, and churn, liabilities, balances, `/investments/transactions/get` with Investments supported or not per Item, removal, injectable errors, and webhooks signed with a real ES256 key that can be rotated. Its data is synthetic.
  - API tests run against a temporary SQLite database using those fakes.
  - They cover the full two-way flows between chores and to-dos, linking and unlinking Todoist, CSV import, and linking, picking, syncing, reconnecting, and removing banks, the webhook route's order and status codes, the CSP on exactly the two Link pages, and the key reset with banks. For Savings: linking and the pick, the daily sync's idempotency, a passing or refused Investments, the no-Investments fallback, removal with and without its data, and panel access.
- **Provider tests:**
  - A Plaid Sandbox test is deferred: it needs keys in CI and network access. The fake covers the flows, and the phase 6b plan's "Verify on first real link" lists what to check against the real Plaid.
  - The Google and Todoist clients are tested against recorded API responses.
- **End-to-end tests (Playwright):**
  - Smoke tests run at phone and desktop sizes.
  - They use a test-only sign-in. The app refuses to start with test sign-in enabled unless `NODE_ENV=test` and `BASE_URL` is on localhost.
  - Google, Todoist, and Plaid are fakes served over HTTP. The fake Plaid (port 3103) also serves a stand-in `link-initialize.js`, so the real Link page runs: connecting a bank, the pick, the first sync replacing CSV rows, a webhook driving syncs, reconnecting, and removing (with its transactions, bringing a replaced CSV row back), and the Link pages' opener policy, at both sizes. For Savings, a fake Fidelity Item with a cash and a brokerage account: the pick, the home card, the breakdown with deposits, withdrawals and market change, the graph, the no-Investments fallback, rename, hide, removal with its data, and that a member without the grant can't see the panel (`e2e/savings.spec.ts`, in the Spend project since it shares the fake Plaid). Plaid has no past balances, so the history those tests need is written straight into the e2e database.
- **Time in tests:** every test that depends on the date or time uses the injectable `Clock`.

---

## 17. Setting up a new instance

The README turns this into a step-by-step guide.

1. **Google Cloud:**
   - Create a project and enable the Google Calendar API.
   - Configure the OAuth consent screen as External, and **publish it as "In production."** In Testing mode, Google refresh tokens expire after 7 days. The app can stay unverified.
     - Unverified apps show a warning only when sensitive scopes are requested. That happens only when an admin connects the calendar.
     - Unverified apps are limited to 100 users, which is plenty for a family.
   - Create a Web OAuth client with these redirect URIs:
     - `BASE_URL/auth/google/callback`
     - `BASE_URL/connect/google-calendar/callback`
2. **Todoist** (optional):
   - Create an app in Todoist's App Management Console.
   - Set the OAuth redirect to `BASE_URL/connect/todoist/callback`.
   - Set the webhook callback to `BASE_URL/webhooks/todoist`, subscribe to the `item:*` events, and activate webhooks.
   - The account that owns the app gets webhooks only after it links through the app's OAuth flow, like every other user.
3. **Plaid** (optional):
   - Create a Plaid team. Teams in the US or Canada created on or after 2026-04-15 qualify for the free Trial plan of 10 Items, which uses the production environment.
   - Apply for the Trial plan and get the production keys: the client ID and the production secret, set as `PLAID_CLIENT_ID` and `PLAID_SECRET` (not `PLAID_CLIENT_SECRET`) with `PLAID_ENV=production`. Each environment has its own secret, so `PLAID_ENV` must match it.
   - Add `BASE_URL/connect/plaid/oauth-return` to the Allowed redirect URIs.
   - Nothing to set for webhooks: `BASE_URL/webhooks/plaid` is sent with each link (§12.2), so changing `BASE_URL` later means linking each bank again. nginx needs nothing new; Plaid's webhook source addresses can be an extra filter there, never the only check.
   - For Savings, Investments must be enabled for the team in Plaid's Dashboard (a request may be needed, and only the account owner can see or ask). Without it, Savings still links and the brokerage shows its total change only (§21.4). It's a monthly subscription per Item after the Trial.
4. **Secrets:** generate `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` (always required, see §3) with `openssl rand -base64 32`. Store the encryption key outside the server.
5. **Deploy:**
   - Run the container (or the systemd service) and configure nginx.
   - Set `BOOTSTRAP_ADMIN_EMAIL` and start the app.
   - Sign in, set the family name and time zone, add users and grant their panels, then connect the calendar, and any banks in Spend settings.

---

## 18. Data model (sketch)

All timestamps are stored in UTC. Date-only values, such as due dates, closing dates, and transaction dates, are local dates in the family time zone.

| Table | Key columns |
|---|---|
| `users` | id, email, google_sub, display_name, color, role, active, last_login_at |
| `sessions` | id_hash, user_id, created_at, expires_at, last_seen_at |
| `panel_grants` | user_id, panel_id |
| `settings` | key, value (family_name, time_zone, plaid_items_created: the Trial counter, raised on each exchange and never lowered, plaid_client_user_id: the random `user.client_user_id` sent to Plaid, token_key_check: a value encrypted with `TOKEN_ENCRYPTION_KEY`, see §14) |
| `connections` | id, kind, scope, owner_user_id, credentials_enc, status, consecutive_failures, last_success_at, last_error, last_error_at, meta |
| `pending_revocations` | id, kind, owner_user_id, credentials_enc (the tokens an unlink or a bank removal couldn't revoke yet), account_id (the Todoist user id, the Google account's `sub`, or Plaid's `item_id`, they belong to; if that Todoist or Google account is linked again, the row is dropped instead of revoked), account_email (Google only, for the warning), attempts, last_error, last_attempt_at, gave_up_at (Google and Plaid: retrying stopped and the token was wiped; the row stays for the notice until an admin dismisses it). A Google row whose account has a pick waiting is kept for later rather than revoked |
| `calendar_cache` | calendar_id, time_zone, window_start, window_end (the key), fetched_at, stale, events (only the fields the panel shows) |
| `calendar_link_pending` | user_id, session_hash, credentials_enc, account_id, account, calendars, source_connection_id and source_fingerprint (for a **Change calendar** pick: the connection it came from and a hash of its refresh token, so a pick from a connection that changed is refused), created_at, expires_at: a calendar link waiting for its admin to pick a calendar, for 15 minutes |
| `plaid_link_pending` | user_id (one per admin), session_hash, link_token (plain text, §15), mode (new / update), plaid_item_id (the local Item being reconnected), add_accounts, purpose (spend / savings), created_at, expires_at: a Plaid Link session, kept so the OAuth return page can open Link with the same token, for 30 minutes |
| `todos` | id, owner_user_id, backend (internal / todoist), title, notes, due_date, due_time, completed_at, created_by_user_id, chore_occurrence_id, todoist_task_id, todoist_account_id (the Todoist user id the task id belongs to; a link to a different account clears both on internal rows), todoist_project_id, todoist_recurring, todoist_due_timezone, todoist_move_error, todoist_move_attempted_at, todoist_move_replays, deleted_at |
| `todoist_state` | user_id, todoist_user_id, sync_token, inbox_project_id, chores_project_id, chores_project_lost, projects (cached names), last_sync_at, last_full_sync_at, lookups_snapshot_at, pending_lookups, uuid_seed, create_attempts |
| `user_prefs` | user_id, todo_summary_view |
| `chores` | id, title, notes, assignee_user_id (who has it; null is Unassigned), schedule_type (fixed / after_completion / as_needed), schedule (JSON), start_date, status |
| `chore_occurrences` | id, chore_id, title_snapshot, due_date (null for as needed), assignee_user_id, assignment_source, state, completed_at, actor_user_id, credited_user_id, todo_id, todo_sync_status, todo_attempts, todo_retry_at, todo_stuck_at, todo_last_error |
| `chore_todo_actions` | todo_id, owner_user_id, action (remove / complete), even_if_completed, attempts, retry_at, stuck_at, last_error |
| `plaid_items` | id, connection_id (nullable, so a removed Item's row outlives its connection), plaid_item_id, institution_id, institution_name, cursor (null until Plaid has one), consent_expiration_time, last_webhook_code, accounts (JSON, null until loaded: what `/accounts/get` last listed, each account's id, name, official name, mask, type, subtype, and currencies, `skipped` when the admin skipped it, and `listed: false` for one the bank no longer shares, kept so the Item's rows are still known as its own), picked_at (null until every account is decided; the Item isn't synced before), backoff_until, new_accounts_at, disconnect_at (from `PENDING_DISCONNECT`), transactions_status (Plaid's `transactions_update_status`), last_sync_at, removed_at, removed_reason (removed / removed_with_transactions / key_reset), purpose (spend / savings, §21.3), investments_status (null until tried, available / unavailable), investments_error_code (Plaid's code for a refusal or a passing failure, or `NO_ANSWER`), investments_through (the last day the brokerage window was read completely) |
| `cards` | id, nickname, mask (2 to 4 characters, not unique), included, usual_closing_day (1 to 31), archived_at, plaid_item_id, plaid_account_id (unique when set), plaid_name, plaid_official_name, plaid_type, plaid_subtype, iso_currency_code, removed_at. The Plaid columns stay null for a card made by hand until an account is attached |
| `statements` | id, card_id, closing_date (unique per card), source (plaid / manual; inferred dates are computed, not stored), statement_balance_cents, payment_due_date, minimum_payment_cents, fetched_at |
| `transactions` | id, card_id, source (plaid / csv), plaid_transaction_id (unique when set), plaid_account_id, pending, pending_transaction_id, date, authorized_date, amount_cents, iso_currency_code (USD for CSV rows), unofficial_currency_code, merchant, raw_name, original_description, csv_address, plaid_pfc_primary, plaid_pfc_detailed, plaid_pfc_confidence, plaid_pfc_version, merchant_entity_id, logo_url, counterparties, category_id, category_source, person_user_id (null = Household), person_source, note, csv_reference (text, unique per card when set, deleted rows included), csv_import_id, replaced_by_id (the row that took this one's place: a pending row's posted version, a churned row's new id, or the Plaid row that replaced a CSV row or an old Item's row; no foreign key, since the prune and "delete its transactions" hard-delete rows), removed_at, deleted_at |
| `categories` | id, name (unique ignoring case), kind (normal / excluded / uncategorized; one row of each special kind), sort_order, archived |
| `category_mappings` | plaid_pfc, taxonomy_version (v1 / v2), category_id |
| `rules` | id, position, match_text, match_type, card_id, min_cents, max_cents, set_category_id, set_person (household / user / null), set_person_user_id |
| `csv_imports` | id, card_id, file_name, file_sha256, uploaded_by_user_id, uploaded_at, row_count, imported_count, skipped_count |
| `csv_import_previews` | id (random), user_id, card_id, file_name, file_sha256, rows (the parsed rows, never the file), created_at, expires_at (an hour) |
| `savings_accounts` | id, source (plaid / manual), plaid_item_id and plaid_account_id (set exactly when source is plaid; plaid_account_id unique when set), nickname, kind (cash / investment), mask, iso_currency_code, hidden_at, removed_at |
| `savings_balances` | id, account_id, date (unique per account), current_cents, available_cents, fetched_at, source (plaid / csv / manual), import_id (set exactly for csv) |
| `savings_flows` | id, account_id, source (transactions / investments / csv), plaid_id (Plaid's id, or a csv flow's occurrence-key hash; unique per source), date, amount_cents (positive), kind (deposit / withdrawal), import_id (set exactly for csv) |
| `savings_imports` | id, account_id, file_name, file_sha256, layout (the format id: fidelity_cash / fidelity_brokerage / custom), uploaded_by_user_id, uploaded_at, deposits_added, withdrawals_added, balances_added, skipped, first_date and last_date (the file's own first and last day; null before 0014). Its flows and balances are deleted with it (Undo) |
| `savings_import_previews` | id (random), user_id, account_id, file_name, file_sha256, layout (format id), plan (the table's header and cells, the mapping, the choices so far, where they were filled in from, and whether the groups step is pending; never the file), created_at, expires_at (an hour) |
| `savings_import_profiles` | id, account_id (unique), header (column names), format, mapping (column indexes, date format, sign setting, balance meaning), choices (short group labels and what each counts as), updated_by_user_id, created_at, updated_at |
| `job_errors` | id, job, message, occurred_at |

---

## 19. To verify during implementation

These are assumptions to confirm early, because each one affects the design:

1. **Plaid Trial and BofA:** confirm that BofA connects through Link on a Trial team, and that `/liabilities/get` returns `last_statement_issue_date` for BofA credit cards. *Researched 2026-11-16* (docs/research/plaid-6b.md §3.5, §6): that BofA works on a Trial is inferred from Plaid's general Trial rule, not stated for BofA, and whether BofA fills the statement date is unverified. Both are in the phase 6b plan's "Verify on first real link", which says what to check. *If it doesn't:* billing cycles fall back to the usual closing day (§12.4), which is already designed in.
2. **BofA CSV format:** confirm the column layout and sign convention against a real export. *Researched 2026-11-16* (docs/research/spend-plaid-csv.md §1): seven community sources agree on the header and sign; encoding, line endings, thousands separators, and the payment wording are unverified. The phase 6a plan's "Verify with a real export" lists what to check.
3. **Google scope:** confirm `calendar.calendarlist.readonly` is available. *Verified 2026-11-16* (docs/research/google-calendar-v3.md §2): it exists and `calendarList.list` accepts it. The research's other open questions are in the phase 5 plan's "Verify on first real link".
4. **Todoist API v1:** confirm three things:
   - How `/sync` behaves with incremental sync tokens. *Verified 2026-11-16* (docs/research/todoist-api-v1.md, "Verified live"): commands and an incremental sync work in one request, and deleted and completed items come back in incremental results.
   - Whether webhooks fire for the account that owns the Todoist app. The docs say only after it links through OAuth; still to confirm on the first real link.
   - Whether deleting tasks requires `data:delete`. The app requests it either way.

   *If webhooks don't fire for the owner's account:* the 10-minute polling still covers it.
5. **Plaid Link on phones:** confirm whether banks that use OAuth login need the redirect URI on phone browsers. *Researched 2026-11-16* (docs/research/plaid-6b.md §3.4): desktop and phone browsers open the bank's pages in a pop-up or a new tab either way, and in-app browsers (webviews) need the redirect URI, so it's always sent (§12.2). The phone and webview check is in the phase 6b plan's "Verify on first real link".
6. **Savings and Fidelity:** Fidelity's Plaid products, Investments on this team, and how Fidelity types and labels its accounts and cash movements. *Researched 2026-11-19* (docs/research/plaid-savings.md): not public; checked on the first real link (§21.7).

---

## 20. Suggested delivery phases

The spec covers one product, but it should be built in phases. Each phase can be deployed on its own:

1. **Platform:** sign-in, sessions, admin page (users, panel grants, settings), panel framework, UI shell, backups, deployment files.
2. **To-do (internal):** lists, summary and drill-down, admin person picker.
3. **Chores:** definitions, generation, assignment and claiming, linked to-dos, history.
4. **Todoist:** linking, mirror and sync, webhooks, chores project, link and unlink migration.
5. **Calendar:** linking, windowed reads, agenda, week and month views, create, edit and delete, attribution.
6. **Spend:** categories, rules, person assignment, cycles, and CSV import first, then Plaid linking, sync, and statements.
7. **Savings:** the panel, its Plaid link and sync, the graph (§21).

---

## 21. Savings panel

Designed in docs/specs/2026-11-19-savings-panel-design.md (approved 2026-11-19), researched in docs/research/plaid-savings.md, and built from that design. Hand-added accounts and CSV import were designed in docs/specs/2026-11-20-savings-csv-import-design.md (§21.8). This section describes what was built. Where it differs from those designs, the code and this section win.

### 21.1 What it shows

- The family's Fidelity cash management (checking) and brokerage accounts, as summary numbers only: balances, and money in and out. No transaction list, no merchant names, no holdings.
- **The month's breakdown**, for each account and a calendar month:
  - **Start:** the last snapshot dated before the month. In the first month after linking there's none, so it's the first snapshot in the month, shown as "Since <date>", and only flows dated after that day count (one on that day may already be in the first balance).
  - **Deposits** and **Withdrawals:** the flows dated in the month. When the start snapshot is older than the previous month (the months between have no snapshot, so no breakdown counted their flows), every flow dated after the start's day counts instead, so a gap month's deposits don't land in the change line.
  - **Market change** (brokerage) or **Other change** (cash account): `now − start − deposits + withdrawals`.
  - **Now** (the current month) or **End** (a past month): the last snapshot dated in the month, with "As of <day>, <time>", when it was fetched. A balance that didn't come from Plaid says where it did instead: "Imported balance for <day>" or "Set by hand for <day>", and a total whose accounts' ends mix sources says "Some balances imported or set by hand, the latest for <day>".
  - **The current month before its first snapshot** (the 1st before the daily job, or a connection that needs reconnecting) holds at the last snapshot before it: start and now are both that snapshot, the month's flows so far still count against it, and the Now cell says "No balance read in <Month> yet". A past month with no snapshot is empty.
- **The total row** (shown with two or more accounts) adds start, now, and the total change over the accounts with data that month. It adds deposits, withdrawals, and change only when every one of them has flows; otherwise those cells say "Not available", with a note, and the change cell is the total change. When any account started that month, the total's start is "since" the latest of those first snapshots. When some accounts start from last month's end and others only this month, the total's Start says so: "Mixed: <account> since <date>, the rest from the end of last month". The total's "as of" is the oldest of the accounts' fetch times.
- **Without Investments** for the connection (outside months a CSV import covers, §21.8), the brokerage shows Start, Now, and the total change, with "Deposits and withdrawals aren't available for this account, so this is the month's total change." Linked cash accounts always have flows. A hand-added account has deposits and withdrawals only in months an import's file reaches (§21.8); in any other month it shows the total change, with "No import covers this month, so this is the month's total change."
- **The month picker** lists the current month and every past month with a snapshot, newest first. A past month lists only the accounts with a balance in it. The overview refuses a month that hasn't started ("That month hasn't started yet.") or one before the earliest month with data ("There are no savings numbers for that month. Pick a later one."), and the page then offers **Show this month**.
- **The graph** (the current month only): the total of the accounts shown now (not hidden, not removed), one point a day from six months before today (the same day, clamped to the month's length) through today. A day with no snapshot carries an account's last balance forward, never before its first. Days before every account's first snapshot aren't drawn; while the line starts after the range's start, it says "The graph starts on <date>, the first day with a balance, and fills in over six months." An account whose first snapshot comes after the line's first day gets a ringed marker on the line and a sentence under it: "<nickname> was added on <date>, so the total steps up there." (several are listed in one sentence).
  - Inline SVG, no chart library (§15), colors from the panel's tokens. Hover, a tap, or the arrow keys (the frame takes focus; Shift moves a week, Home and End jump) show a day's total; the keys' readout goes to a live region.
  - For screen readers the SVG is hidden. The latest total is text above it ("Total now"), and the month-end totals are a table behind **Show as a table** (the current month's marked "so far").
  - **Deposit and withdrawal lines**, so money moving in and out is told apart from market moves: behind the balance line, one full-height vertical line for each day with a deposit (green, chart slot 3, with a ▲ above it) or a withdrawal (the danger red, with a ▼ above it). A day with both draws both, a little apart, deposit on the left. Each line's opacity follows its amount against the largest single day's deposit or withdrawal in the window (by the square root of the share, from 0.25 to full; a marker never under half), so paychecks and big transfers stand out and small bills stay faint. The flows are the series' own: each day's totals over the shown accounts, only in months whose flows are known (the same rules as the breakdown's Deposits and Withdrawals, so a brokerage without Investments or a hand-added account outside its imports adds none), only after an account's first balance. A **transfer between shown accounts** isn't money in or out of the total: a withdrawal from one and a deposit of the same amount into another within two days are paired, one to one, nearest dates first, and left out of both (pairing looks two days past the window's edges, so half a transfer isn't drawn). A transfer to a hidden or removed account, or to one whose flows aren't known, isn't paired. Under the graph: "Green ▲ deposits, red ▼ withdrawals; transfers between your accounts aren't shown." The tooltip and the keys' readout add the day's "Deposits $X · Withdrawals $Y" (only the parts it has), a visually hidden line totals the window's deposits and withdrawals and their days, and in forced colors both kinds are one system color, told apart by ▲ and ▼.
- **Home card:** each shown account's nickname with its last 4, its balance ("Not synced yet" before the first sync), and this month's change; the total, with its change; "Updated <time> ago" from the oldest latest snapshot; and "These balances are more than a day old, so they may be out of date." once the oldest is more than 26 hours old (a day, plus the daily job's slack), by the server's clock. A connection that needs reconnecting says so instead of the stale line ("<name> needs to be reconnected, so these balances aren't updating."), with **Reconnect** for admins, or that it needs removing and connecting again. With no accounts, admins get a **Connect an account** link. "Updated" and the stale note come only from linked accounts' Plaid reads: a hand-set or imported balance doesn't make a linked account look fresh, and nothing makes a hand-added account stale. An account whose latest balance didn't come from Plaid says where it did ("Imported balance for <day>", "Set by hand for <day>"), and a hand-added one with none says "No balance yet". Under the total, **the last month's graph**: the same total of the shown accounts from the same day one month before today (clamped to the month's length) through today, with the same carry-forward and joins as the six-month graph and the same deposit and withdrawal lines, compact, with no axes (the first and last day under it; the latest value is the card's Total). It isn't interactive; its caption is its text: "Last month: from $A to $B; deposits $X, withdrawals $Y." (the flows only when there are some), with a small ▲ in ▼ out key. It's left out until the month has two days of balances.

### 21.2 Access

- Panel id `savings`, granted per person like the others (§6). Anyone with it sees the home card and Overview. The bootstrap admin of a new install gets it like every panel; on an existing install an admin grants it in Admin.
- Admins only, and checked on the server: the **Settings** tab, connecting, the pick, renaming, hiding, Refresh, Load accounts, removing, adding an account by hand, Set balance, CSV import and its Undo, and saved import settings. A member's `/savings?tab=settings` shows Overview, and the settings routes answer 403.

### 21.3 Linking

- A second kind of Plaid Item: `plaid_items.purpose` is `spend` (every bank, and the default) or `savings`. The link session carries the purpose (`plaid_link_pending.purpose`) from Connect to the exchange. Spend never lists, syncs, picks, refreshes, or reads statements for a Savings Item, and its bank routes answer 404 for one; Savings does the same the other way. The Trial count is shared and shown in both settings pages.
- **Connect an account** in Savings settings opens `/connect/plaid/link?for=savings`. Its link token asks for `products: ["transactions"]` and `required_if_supported_products: ["investments"]` (so a missing Investments product never hides Fidelity or fails the link), `account_filters` for depository and investment accounts (all subtypes; never credit cards), the same webhook, redirect URI, and client fields as §12.2, and no `transactions.days_requested`. If Plaid refuses the token with `INVALID_PRODUCT`, it's asked once more without Investments.
- The duplicate check, the exchange, the Trial counter, reconnecting (update mode, which takes the purpose from the Item), Load accounts, Add accounts, and removal with its retries are §12.2's, and the key reset is §14's. Every link step for a Savings Item returns to Savings settings (`/savings?tab=settings`, with `bank` and `bank_error` as in Spend settings), and the Link page's texts name Savings.
- **The pick:** every waiting account is decided in one request: **Show** with a nickname (1 to 40 characters, starting from Plaid's name for it) or not shown (skipped: never stored or fetched). Savings shows depository accounts as **cash** accounts and investment accounts as **investment** accounts, and refuses any other type. An account id already shown from an earlier connection is refused, and the pick saves nothing. The first pick runs the first sync in the request (40 seconds, then "Saved. Syncing in the background."). A skipped account shown later asks for a full Transactions resync, as §12.2's late attach does.
- **Hide** is display only: a hidden account keeps syncing, so showing it again leaves no gap. It's off the home card, Overview, and the graph while hidden. **Rename** changes the nickname. Both are local, no Plaid call.
- **Removing** is §12.2's (revoke first, the hourly retries, the lasting notice). With **Also delete its data**, the connection's accounts are deleted with their balances and flows. Otherwise they're kept, marked removed: off the home card, the graph, and the current month, still in past months that have their data, labelled "Connection removed". Linking Fidelity again makes new accounts (Plaid's account ids are per Item), whose numbers start again from the new link. The key reset marks Savings accounts removed the same way.
- **Notices** for a removal Plaid never confirmed are per purpose: Savings settings shows only Savings', Spend settings only Spend's, and the System page all of them. Dismiss in Savings settings uses the System page's route (`POST /api/admin/integrations/revocations/:id/dismiss`).

### 21.4 Sync

- **When:** `savings.sync`, daily at 05:30 family time, for every Savings Item (with Plaid configured); Refresh (10 a minute per admin, 40-second budget, then the background); the pick's first sync; and webhooks.
- **A connection that needs reconnecting** is checked first by the daily job with `/item/get` (§12.3's check). When the check finds it repaired, the check has already asked for a sync, so the job doesn't run a second one for it. Refresh and webhooks never sync it.
- Under the Item's lock, as every Plaid call (§12.3):
  - **Balances:** `/accounts/get` (Plaid's cached balance, free), one snapshot per shown or hidden account per family-time day, `current` and `available` in cents, replaced by a later fetch that day, and replacing an imported or hand-set balance for that day. `/accounts/balance/get` isn't used. An account Plaid lists that the Item doesn't know sets `new_accounts_at`, for Load accounts.
  - **Cash account flows:** `/transactions/sync` from the Item's cursor, every page buffered and applied with the cursor in one transaction, restarting on a mutation, as §12.3. Posted transactions only; negative amounts are deposits, positive withdrawals; zero is skipped; a removed transaction deletes its flow; another currency is skipped and counted. Interest isn't a flow (it lands in Other change): Plaid's docs don't confirm its category for interest, so a transaction counts as interest when its personal finance category's detailed value starts with `INCOME_INTEREST`, or its name starts with `INTEREST EARNED` or `INTEREST PAID`, ignoring case. The name is read at sync time only and never stored, and the sync log counts these (`interest`). A modified transaction that now matches has its flow removed; interest flows stored before this change are corrected only when Plaid sends them again. A new flow (not an updated one) replaces the imported flow it matches: same account, kind, and amount, within 3 days, the nearest first.
  - **Brokerage flows:** `/investments/transactions/get` from the earlier of 30 days ago and 7 days before the last day read through (`investments_through`), at most 729 days back, to today, 500 a page. Flows are `cash` / `deposit`, `cash` / `contribution`, `cash` / `withdrawal`, and `transfer` / `transfer` without a security, the direction from the sign of the amount. Everything else (dividends, interest, fees, buys, sells, pending) is market change. A new flow replaces its imported twin the same way as a cash flow.
  - **Cancelled brokerage flows:** a stored flow in the window that Plaid no longer lists is deleted only after a complete read: paging reached Plaid's total, the total didn't change between pages, and every entry parsed. An answer with no entries at all while flows are stored in the window deletes nothing either (more likely a hiccup than every flow cancelled at once), and is logged. An incomplete read deletes nothing and doesn't move `investments_through`, so the next run reads the same window.
- **Investments that isn't there:** `PRODUCTS_NOT_SUPPORTED`, `NO_INVESTMENT_ACCOUNTS`, `INVALID_PRODUCT`, and `ADDITIONAL_CONSENT_REQUIRED` from `/investments/transactions/get` aren't connection failures. The Item's `investments_status` becomes `unavailable` with the code in `investments_error_code`, and each sync asks again, so turning the product on later needs no code change.
- **A passing Investments failure** (`PRODUCT_NOT_READY`, Plaid or the institution briefly down, no answer) doesn't fail the run either: the balances and cash flows are kept, the connection isn't backed off, and `investments_error_code` gets Plaid's code, or the app's own `NO_ANSWER` when there was none. An Item already `unavailable` keeps its code. Only the request's deadline still defers the whole run.
- **Savings settings says which**, under the connection: for `INVALID_PRODUCT`, "Investments isn't enabled for this Plaid account. The Plaid account's owner can turn it on in the Plaid Dashboard."; for the other refusals, that the institution didn't share investment activity and that removing and connecting again, allowing investments, may fix it; for a passing failure, "Couldn't read the brokerage's activity this time. It's tried again at the next sync."
- **Webhooks** for a Savings Item: `TRANSACTIONS` `SYNC_UPDATES_AVAILABLE`, `HOLDINGS` `DEFAULT_UPDATE`, and `INVESTMENTS_TRANSACTIONS` `DEFAULT_UPDATE` ask for a background Savings sync, folded per Item (a replayed one still asks); `ITEM` codes are §12.3's; anything else (`LIABILITIES`) is ignored.
- **Savings settings polls** the connection list (as Spend's banks do) after a pick or Refresh that went to the background, and while a picked connection hasn't synced yet.
- Errors, status, backoff, and the System page are §8's and §14's. Logs carry ids, counts, and Plaid's `type:subtype` values (the `savings sync` line's `byType`), never names, amounts, or tokens.

### 21.5 Data

- `savings_accounts`, `savings_balances`, `savings_flows`, `savings_imports`, `savings_import_previews`, and `savings_import_profiles` (§18). Kept forever, like Spend history, unless deleted with the connection or the hand-added account.
- **Migrations.** 0012 made `savings_accounts`' Plaid ids nullable and added `source`, so SQLite needed a table rebuild. Drizzle runs each migration inside one transaction, where `PRAGMA foreign_keys` can't be turned off, so a plain rebuild of the parent would cascade-delete every balance and flow. 0012 is hand-written instead: it rebuilds the parent and both child tables in an order that keeps every row and every AUTOINCREMENT counter (`sqlite_sequence`), and adds `savings_imports` and `savings_import_previews`. The migration guard has a reviewed exception pinned to 0012, as for 0009. 0013 added `savings_import_profiles` and 0014 added `first_date` and `last_date` to `savings_imports`; both only add, and need no exception.
- Flows are keyed by source (`transactions`, `investments`, or `csv`) and Plaid's id or the occurrence key's hash (§21.8), so re-reading is harmless. Amounts are positive cents with a `kind`.
- Plaid's name, mask, type, and subtype for each account stay on the Item's account list, as for Spend. No transaction names, merchants, securities, or holdings are stored or logged.

### 21.6 Routes

`/api/panels/savings`: `GET /summary` and `GET /overview?month=YYYY-MM` for anyone with the panel. Admin-only, behind the CSRF check, with or without Plaid: `GET /settings`; `POST /accounts` (`{ nickname, kind }`); `PATCH /accounts/:id` (`{ nickname?, hidden? }`); `POST /accounts/:id/balance` (`{ amount, date? }`); `POST /accounts/:id/remove` (`{ deleteData }`, hand-added accounts only); `POST /accounts/:id/imports` (multipart `file`, 5 MB, 20 a minute per admin; answers 201 with the draft); `PUT /imports/:id` (`{ mapping, choices? }`, 512 KB; answers the draft); `POST /imports/:id/commit`; `DELETE /imports/:id` (cancel, 204); `DELETE /accounts/:id/imports/:importId` (Undo); `PATCH /accounts/:id/import-profile` (`{ choices }`, 512 KB) and `DELETE /accounts/:id/import-profile`. With Plaid configured (a 404 otherwise): `POST /connections/:id/accounts`, `/refresh` and `/load-accounts` (10 a minute per admin each), and `/remove` (`{ deleteData }`). Every settings route answers the whole settings view, with `message` after Import and Undo. Account and import ids are plain digits and draft ids 22 base64url characters; anything else is a 404. Jobs: `savings.sync` (with Plaid) and `savings.pruneImports` (always, every 15 minutes).

### 21.7 To verify on the first real link

Fidelity's products (`/institutions/get_by_id` or `/institutions/search`), whether this Plaid team has Investments enabled in production (the Dashboard; only the account owner can check), how Fidelity types the cash management account, and which `type:subtype` pairs its deposits and transfers arrive as. The plan's "Verify on first real link" says how.

### 21.8 Hand-added accounts and CSV import

**Hand-added accounts.**
- **Accounts added by hand** in Savings settings adds one with a nickname (1 to 40 characters) and a kind, cash or investment, with no Plaid link. It's renamed, hidden, and removed like a linked account. Removed, it keeps its history for past months and is listed by name only, with no Set balance or Import. With **Also delete its data**, its balances, flows, imports, saved import settings, and any draft go too. Linking Fidelity later makes separate accounts; the two are never merged.
- The section is always there, with or without Plaid. Without Plaid, Settings shows only it, with a note that connecting needs Plaid.

**Set balance** (every account that isn't removed, linked or added by hand):
- An amount as typed ("25,000.00", "$1,000", "-40.00"), for today or a chosen day from 2000-01-01 through today, family time. Negative is allowed (an overdrawn account). The limit is its own, $1,000,000,000.00 either way, not Spend's per-transaction one.
- It's stored as that day's balance with source `manual`, replacing an imported or earlier hand-set one. A day that already has a Plaid balance is refused ("Plaid has a balance for that day, and it always wins. Pick another day."), and a later Plaid balance for the day replaces it.

**Where a balance came from** is said wherever it shows: "Imported balance for <day>", "Set by hand for <day>", or "Some balances imported or set by hand, the latest for <day>" for a total (§21.1). A month's end carries its source (`plaid`, `csv`, `manual`, or `mixed`).

**Flows per month.** A month one of an account's imports covers has its deposits and withdrawals: from the file's first to its last day, recorded at Import (`first_date` and `last_date`, every mapped row in the file, stored or not). An import from before 0014 covers from its first to its last row still stored. An undone import covers nothing. A hand-added account counts flows only in those months. A linked account counts them as in §21.4 and also in any month an import covers, so a brokerage whose connection doesn't share Investments shows deposits and withdrawals for the months a CSV fills in, and the no-Investments note elsewhere.

**Import a CSV** (every account that isn't removed) works in steps. The server answers each one with the draft.
1. **Upload.** The browser refuses a file over 5 MB before sending it; the server refuses one too (413), and a request over 5 MB plus 64 KB is cut off with the same message. The server finds the table and keeps its header and cells for an hour, under a random id, bound to the admin. One draft per admin: a new upload replaces the last. Nothing from the file is logged.
2. **Columns.** The column names and the first 8 rows (in a box that scrolls sideways on its own, so the page never does), and a column for each role:
   - **Date**, with the formats every value fits: `YYYY-MM-DD`, `M/D/YYYY`, or `D/M/YYYY`, padded or not, from 2000-01-01 to tomorrow. When the column fits both M/D and D/M (every day is 12 or under), the format starts blank and the admin chooses, whatever the server suggested; a mapping already saved or built in keeps its format.
   - **Amount**: one signed column, with "Money in is negative in this file" for banks that flip the sign, or separate **Debit** and **Credit** columns, both read as positive.
   - **Balance** (optional). For a cash account it's the daily balances. For an investment account it's ignored unless ticked as the account's whole value.
   - **Description** (optional, recommended).
   The account's kind for these is the server's, from the draft.
3. **What rows mean.** Rows are grouped by a short label: the description uppercased, everything that isn't a letter or space dropped, then its first two words, at most 100 characters ("YOU SOLD", "DIRECT DEPOSIT"). A file can have up to 1,000 groups to choose for; the request bodies that carry the choices allow 512 KB, enough for 1,000 labels of 100 characters. Rows with no description (or no letters) form one group, shown as "No description". Each group is **Deposit**, **Withdrawal** (the amount's size, whatever its sign), **By sign** (money in a deposit, money out a withdrawal), or **Not counted** (it lands in Other change or Market change). A zero or empty amount is never a flow. Defaults:
   - cash: By sign, except labels that contain INTEREST, which are Not counted;
   - investment: Not counted, except labels with a word starting TRANSFER, DEPOSIT, WITHDRAWAL, CHECK, ACH, EFT, CONTRIBUTION, or DISTRIBUTION, which are By sign (so "LEFT" doesn't match EFT).
   A group with no saved choice is marked **New**, with its default (or the built-in format's rule) picked, and its select's name says "new".
4. **Results.** The rows and date range, how many deposits, withdrawals, and daily balances Import adds, how many it skips as already here or Plaid's, each group with what it counts as ("YOU SOLD … (12): not counted"), and warnings, with **Change the columns**, **Change what rows mean**, and **Cancel**. Import is disabled when there's nothing new.
5. **Import** re-checks everything in one transaction, records the import (account, file name, SHA-256 of the file, format, who, when, counts, first and last day), and saves the account's settings. Never the file.

**When steps are skipped or repeated.** At upload, the account's saved settings apply when the file's header matches theirs exactly and their mapping reads this file; otherwise a built-in format applies when the header is exactly its; otherwise the server suggests a mapping from the column names. When the mapping fits and every group is decided, the upload goes straight to the results. A saved mapping that no longer fits isn't applied: the columns step opens with it filled in and says why, with a line number. After any change to the columns the draft is groups-pending: the groups step always shows again, and there are no results and no Import until the choices are sent. Choices already made for groups still in the file are kept across a columns change. The note saying where the steps were filled in from ("Filled in from this account's saved import settings…", "This looks like a Fidelity brokerage file…", "The columns are a guess…") shows only with the upload's answer.

**Closing.** Closing the steps any way but Import (Cancel, opening Set balance or Edit instead, toggling Import a CSV shut, or leaving the page) cancels the draft, so the server forgets its cells at once; one the browser misses is pruned within the hour. An expired draft sends the admin back to the upload step with focus on the file field. Cancel on any of these forms puts focus back on the button that opened it.

**Undo** deletes the import's record, and its flows and balances go with it. A balance Plaid or Set balance has since replaced isn't the import's any more and stays. Each account lists its 10 newest imports with what Undo would delete now ("statement.csv, Nov 15, by Alex: 7 deposits and withdrawals and 7 daily balances"). When a later import of the account skipped rows as already here, Undo asks first ("Undoing this also removes days a later import relied on; import that file again afterwards.") with **Undo anyway** and **Keep it**. That check is conservative: imports don't keep which rows they skipped or why, so it can ask when the skips were Plaid's. Undo's buttons are named by file and upload day, with the time when the same file was imported more than once that day, so each name is its own.

**Saved per account.** The header's names, the format id, the mapping (by column index, which the exact header match makes unambiguous), and each group label's choice. Saved on Import, never before: the same header merges this file's choices over the saved ones, so labels from older files stay decided; a different header replaces them. **Edit** changes the choices of labels already saved (future imports only); **Clear** deletes them, and the next import starts from a built-in format or a guess.

**Built-in formats** (data in `importFormats.ts`), matched by exact header, decide every group:
- Fidelity cash management: Run Date (M/D/YYYY), Amount ($), Cash Balance ($) as the account's value, Action as the description; INTEREST EARNED Not counted, the rest By sign.
- Fidelity brokerage: Run Date, Amount, Cash Balance not the value (ignored), Action; TRANSFERRED FROM, DIRECT DEPOSIT, CHECK RECEIVED, ELECTRONIC FUNDS, TRANSFERRED TO, and DIRECT DEBIT By sign, the rest Not counted.
- Warnings (never blocking): a Fidelity format on the other kind of account, and a `History_for_Account_<number>.csv` file whose number doesn't end in the account's mask.

**Finding the table.** The header is the first row with at least two filled cells, every one of them with a letter, followed by a non-blank row with the same number of fields, within the first 200 non-blank lines. The table ends at a blank line, at a footer right after the rows (a row with a different field count and no fitting rows after it), or at the end of the file. A row that doesn't fit, with fitting rows after it, refuses the file with its line number. Strict UTF-8 with or without a byte order mark, CRLF or LF, quoted fields, one record per line; at most 20,000 rows and 200 columns.

**Values.** Amounts may have a currency sign (`$ € £ ¥`), a leading `+` or `-` (or U+2212), parentheses for a negative, thousands separators, quotes, and may be empty; decimal commas aren't read. A bad date or amount refuses the file with its line number and the role ("Line 5's date isn't a date written as M/D/YYYY…"), never the cell. A balance cell that isn't a number (Fidelity's `Processing`) means that row has no balance.

**Daily balances.** For each date, the newest row's balance. The file's order comes from consecutive dates: more decreases than increases (or a tie) means newest first.

**Overlap.**
- A flow's key is `sha256("savings-csv-v1\n" + JSON.stringify([account, date, kind, cents, description]) + "\n" + n)`, where the description is the full text with white space collapsed (never stored) and `n` counts identical rows that day in file order, so two identical charges the same day stay two. A key already stored is skipped. A bank that rewords a row between downloads makes a duplicate; Undo the newer import.
- A Plaid flow on the account with the same kind and amount within 3 days covers a CSV flow, one to one, nearest first; Plaid's later copy replaces an imported one the same way (§21.4).
- Imported balances only fill days before the account's first Plaid balance that have no balance yet. An imported balance never replaces a Plaid or hand-set one.

**Without Plaid.** Savings settings, hand-added accounts, rename and hide, Set balance, CSV import, and saved settings all work. The settings view lists imports and saved settings for hand-added accounts only, and the routes refuse a linked account's upload, draft steps, Import, Undo, and Edit or Clear the same way (404, "That account is linked through Plaid, which isn't set up on this server…"). Only the connection routes need Plaid.

**Security notes.**
- A draft holds the file's table (descriptions included) for up to an hour, bound to the admin who uploaded it; another admin's request for it is a 404. The preamble, the footer, and the file itself are never kept.
- Saved settings hold column names and two-word labels; imports hold the file name and its SHA-256.
- The occurrence key's SHA-256 is unkeyed on purpose (a keyed hash would need a secret that survives key rotation), so someone with the database could confirm a guessed description for a row whose date and amount are already stored.
- Nothing from a file reaches the logs: lines carry ids, counts, the format id, and where the draft was filled in from. Errors carry line numbers and role names, never cell contents. A test pins this.
