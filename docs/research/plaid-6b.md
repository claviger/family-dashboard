# Plaid API reference for phase 6b (linking BofA cards)

Researched 2026-11-16, for phase 6b (spec §12.2 to §12.4, §15). Builds on [spend-plaid-csv.md](spend-plaid-csv.md), which already covers the transaction object, the `/liabilities/get` credit object, the PFC taxonomy, pending to posted, and the Trial limit. I don't repeat those here.

**How I checked**

- Plaid publishes every docs page as raw Markdown at `<page>/index.html.md`. I downloaded those with `curl` into my scratchpad (not the repo) and grepped them, so quotes below are verbatim, not run through a summarizer like the earlier research. Links below are the canonical page URLs.
- OpenAPI: `2020-09-14.yml` from [plaid/plaid-openapi](https://github.com/plaid/plaid-openapi/blob/5c3745cf0256b2928288a8fde7cf4b7b8461f058/2020-09-14.yml) at commit `5c3745c` (spec `info.version` `2020-09-14_1.799.0`).
- `plaid` npm package: registry metadata from `registry.npmjs.org/plaid`, and the 51.0.0 tarball unpacked in the scratchpad and read, never installed or run.
- `jose`: the copy already in this repo's `node_modules` (a dependency of `openid-client`) and its docs on GitHub. Node `crypto`: the v22 docs source.
- Tags: **UNVERIFIED** means no source I found states it. **INFERRED** means I'm reasoning from sources, not quoting them. **JUDGMENT** is my own recommendation.
- No accounts created, no Plaid API calls, nothing sent anywhere except docs downloads and `gh api` reads of public repo metadata.

---

## 1. Environments and keys

| Question | Answer | Source |
|---|---|---|
| Base URLs | `https://sandbox.plaid.com` and `https://production.plaid.com`. "Plaid has two environments: Sandbox and Production. Items cannot be moved between environments." | [API overview](https://plaid.com/docs/api/), OpenAPI `servers` |
| Does Trial use Production? | Yes. "Using a Trial plan, you can use Plaid with real production data for free." and "You can create 10 Production Items on a Trial plan." Trial is for "new Plaid teams (US/Canada only) created on or after April 15, 2026." | [Billing, Trial plans](https://plaid.com/docs/account/billing/#trial-plans) |
| Secrets per environment? | Yes. One `client_id` for the team; the `secret` is "Private key, one for each of the two environments". So `PLAID_SECRET` must match `PLAID_ENV`. | [Quickstart](https://plaid.com/docs/quickstart/) |
| Secret rotation | Dashboard **Rotate** makes a new secret; "The old secret will still remain active until you delete it". So rotation can be zero-downtime. | [Account security](https://plaid.com/docs/account/security/) |
| Auth | "Almost all Plaid API endpoints require a `client_id` and `secret`. These may be sent either in the request body or in the headers `PLAID-CLIENT-ID` and `PLAID-SECRET`." The OpenAPI security schemes are header API keys with exactly those names. | [API overview](https://plaid.com/docs/api/), OpenAPI `components.securitySchemes` |
| Protocol | JSON over HTTPS, all POST, `Content-Type: application/json`. Use `error_code`/`error_type` "in preference to HTTP status codes". TLS 1.2; "certificate pinning should never be used". | [API overview](https://plaid.com/docs/api/) |
| `Plaid-Version` | Optional header. Without it, the default version set in the Dashboard is used. | [Versioning](https://plaid.com/docs/api/versioning/) |
| Current version | `2020-09-14`. The `plaid` 51.0.0 README: "This release only supports the latest Plaid API version, `2020-09-14`". The OpenAPI repo has only `2020-09-14.yml`, and the v51 client sends `Plaid-Version: 2020-09-14` by default. This closes the earlier research's open question. | [plaid-node README](https://github.com/plaid/plaid-node), OpenAPI repo, `dist/cjs/BaseClient.js` in the tarball |
| Money | "Plaid returns all currency values as decimal values in dollars ... rather than as integers." It "may be possible ... to have more than two digits of precision" (crypto is the example). | [API overview](https://plaid.com/docs/api/) |

**JUDGMENT:** send credentials in the headers, not the body, and always send `Plaid-Version: 2020-09-14`. Headers keep the secret out of any request-body logging, and pinning the version means a Dashboard default change can't change response shapes under us.

---

## 2. `/link/token/create`

Source unless noted: [Link API reference](https://plaid.com/docs/api/link/#linktokencreate).

### 2.1 Fields we use

| Field | Required? | Notes |
|---|---|---|
| `client_name` | yes | "Maximum length of 30 characters. If a value longer than 30 characters is provided, Link will display "This Application" instead." |
| `language` | yes | `en` |
| `country_codes` | yes | `["US"]` |
| `user.client_user_id` | yes (when `user_id` isn't sent) | "Personally identifiable information, such as an email address or phone number, should not be used". `user_id` (from `/user/create`) is only required for Protect, Multi-Item Link, Consumer Report, and a few payment products, none of which we use. |
| `products` | yes, except update mode | "If launching Link in update mode, should be omitted". "Only institutions that support _all_ requested products can be selected". "a product cannot be removed from an Item once the Item has been initialized with that product." |
| `transactions.days_requested` | no | **Max 730, default 90.** "Once Transactions has been added to an Item, this value cannot be updated." |
| `webhook` | no | "In update mode, this field will not have an effect; to update the webhook receiver endpoint for an existing Item, use `/item/webhook/update` instead." The URL must be `http(s)://...` and, if https, have a valid certificate ([Webhooks](https://plaid.com/docs/api/webhooks/)). |
| `redirect_uri` | no | "should not contain any query parameters. When used in Production, must be an https URI. ... must also be added to the Allowed redirect URIs list in the developer dashboard." No `#` and no wildcard in the request ([OAuth guide](https://plaid.com/docs/link/oauth/#create-and-register-a-redirect-uri)). |
| `access_token` | update mode only | Puts Link in update mode for that Item. |
| `account_filters` | no | See 2.3. |
| `update.account_selection_enabled` | update mode only | See 2.4. |

Response: `link_token`, `expiration`, `request_id`.

### 2.2 Can `liabilities` sit in `products` next to `transactions`?

Yes. `liabilities` is a listed value of `products`, and also of `required_if_supported_products`, `optional_products` and `additional_consented_products`. Plaid's own guidance for this combination is different from the spec, though:

> "For personal finance use cases, initialize Link with Transactions, with Liabilities and Investments in the Additional Consented Products array. Then call Liabilities or Investments endpoints after the Item has been linked" ([Choosing when to initialize products](https://plaid.com/docs/link/initializing-products/#transactions-with-liabilities-andor-investments))

The trade-offs, from the table on the same page:

| Where `liabilities` goes | Link restricts institutions? | Item creation fails if Liabilities fails? | Data extracted at Link? |
|---|---|---|---|
| `products` | yes | yes ("Item creation will fail if ... experiences an extraction error") | yes |
| `required_if_supported_products` | no | yes, if supported and an applicable account is chosen | yes |
| `optional_products` | no | no | best effort |
| `additional_consented_products` | no | no | no; consent only, billed "When you call the product endpoint for the first time" |

On OAuth institutions there's a consent angle: "Initializing both products during Link will make it easier to obtain the consent required at institutions that use OAuth, because the user will be prompted to fix their selections during the OAuth flow if they do not grant the required consent for all products" (same page). If the user doesn't share liabilities data, `/liabilities/get` returns `ACCESS_NOT_GRANTED` or `NO_LIABILITY_ACCOUNTS` ([OAuth, scoped consent](https://plaid.com/docs/link/oauth/#scoped-consent)).

**JUDGMENT:** `products: ["transactions"]` and `required_if_supported_products: ["liabilities"]`. BofA credit cards support both, so in practice it behaves like the spec's version, but a Liabilities extraction hiccup can't block the link of a card whose transactions are fine. The spec's `products: ["transactions", "liabilities"]` is valid too; it's stricter. Either way, Trial has no per-product cost (Trial includes Liabilities and Transactions, [Billing](https://plaid.com/docs/account/billing/#trial-plans)), but after an upgrade both are subscription-billed per Item.

### 2.3 `account_filters` for credit cards only

```json
"account_filters": { "credit": { "account_subtypes": ["credit card"] } }
```

- "If the `account_filters` filter is used, any account type for which a filter is not specified will be entirely omitted from Link." So that one entry drops checking, savings, loans and investments.
- `credit` subtypes are `credit card`, `paypal`, `all`.
- OAuth caveat: "The filter may or may not impact the list of accounts shown by the institution in the OAuth account selection flow ... If the user selects excluded account subtypes in the OAuth flow, these accounts will not be added to the Item. If the user selects only excluded account subtypes, the link attempt will fail and the user will be prompted to try again." And the filter "will only be applied after the OAuth flow has been completed and will not affect the permission selection interface" ([OAuth, scoped consent](https://plaid.com/docs/link/oauth/#scoped-consent)). BofA has "its own hosted account select screen" ([OAuth, Bank of America](https://plaid.com/docs/link/oauth/#bank-of-america)), so expect BofA's screen to list checking accounts anyway.
- In update mode, `account_filters` "can only be set ... if `update.account_selection_enabled` is set to `true`" ([Update mode](https://plaid.com/docs/link/update-mode/#using-update-mode-to-request-new-accounts)).

Security note: the filter means Plaid never adds a checking account to our Item, so its data never reaches us. That's better than ignoring it after the fact (spec §12.2 "Accounts that aren't credit cards ... are ignored").

### 2.4 Update mode

- Pass `access_token`; omit `products` ("No products should be added to the `products` array and no product-specific request parameters should be specified" unless adding credit products or using Product Validations) ([Update mode](https://plaid.com/docs/link/update-mode/#using-update-mode)).
- Still pass `redirect_uri`: "When using Link in update mode ..., be sure to specify your redirect URI" ([OAuth, consent revocation](https://plaid.com/docs/link/oauth/#managing-consent-revocation)).
- No exchange afterward: "An Item's `access_token` does not change when using Link in update mode, so there is no need to repeat the exchange token process." (same page)
- Account Select in update mode is "always enabled" for US institutions with their own OAuth account selection flow, "regardless of the value" of `update.account_selection_enabled` ([Link API](https://plaid.com/docs/api/link/#link-token-create-request-update-account-selection-enabled)). "Any de-selected accounts will no longer be shared with you." So a BofA reconnect can drop a card, and the app should compare `onSuccess` `accounts` with the cards it has.
- Consent clock: "Whenever an Item is successfully sent through update mode, the Item consent expiration date will be updated as though the Item were newly created" ([Update mode](https://plaid.com/docs/link/update-mode/#refreshing-item-expiration-dates)).
- After repair: "the next webhook fired for the Item will include data for all missed information", and if the Item was broken for over 24 hours, "Plaid will check for new transactions immediately after update mode is complete" (same page).

### 2.5 Lifetimes

- Link token: "a `link_token` created to generate a `public_token` that will be exchanged for a new `access_token` expires after 4 hours, and a `link_token` created for an existing Item (such as when updating ... in update mode) expires after 30 minutes" (`expiration` response field).
- Link Web calls it "a short lived, one-time use token that should be unique for each Link session" ([Link Web, create()](https://plaid.com/docs/link/web/#create)). Reusing it for the OAuth return is the same session (3.3).
- Public token: "ephemeral and expires after 30 minutes" ([Items API, exchange](https://plaid.com/docs/api/items/#itempublic_tokenexchange)).

### 2.6 Example request (new Item)

```json
{
  "client_name": "Family Dashboard",
  "language": "en",
  "country_codes": ["US"],
  "user": { "client_user_id": "<opaque stable id, no PII>" },
  "products": ["transactions"],
  "required_if_supported_products": ["liabilities"],
  "transactions": { "days_requested": 730 },
  "account_filters": { "credit": { "account_subtypes": ["credit card"] } },
  "webhook": "https://<BASE_URL>/webhooks/plaid",
  "redirect_uri": "https://<BASE_URL>/connect/plaid/oauth-return"
}
```

Update mode: drop `products`, `required_if_supported_products`, `transactions` and `webhook`; add `access_token`; keep `redirect_uri`; add `update.account_selection_enabled: true` plus the same `account_filters` if you want the filter applied there too.

---

## 3. Plaid Link in the browser

Source unless noted: [Link Web](https://plaid.com/docs/link/web/).

### 3.1 Script

- `<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>`. **Confirmed.**
- "It must always be loaded directly from `https://cdn.plaid.com`, rather than included in a bundle or hosted yourself. ... the JavaScript web SDK is not versioned; `cdn.plaid.com` will automatically provide the latest available SDK." So no SRI hash is possible, and the script can change under us. **INFERRED** consequence: treat the connect pages as running third-party code you don't pin.
- Plaid says to "Include the Plaid Link initialize script on each page of your site." It doesn't say why. The spec's choice to load it only on the connect pages is a deliberate departure; nothing I read says Link fails without it. **UNVERIFIED** whether anything (conversion, fraud signals) depends on site-wide loading.

### 3.2 `Plaid.create`

```js
const handler = Plaid.create({
  token,                               // link_token
  onSuccess: (public_token, metadata) => {},
  onExit: (err, metadata) => {},       // err is nullable
  onEvent: (eventName, metadata) => {},
  onLoad: () => {},
  receivedRedirectUri,                 // only when re-launching after an OAuth redirect
});
handler.open(); handler.exit(); handler.destroy();
```

- `receivedRedirectUri`: "required to support OAuth authentication flows when re-launching Link on a mobile device."
- `onSuccess` metadata: `institution` (`name`, `institution_id`, nullable), `accounts[]` (`id`, `name`, `mask`, `type`, `subtype`, `verification_status`), `link_session_id`. Mask: "The last 2-4 alphanumeric characters ... may be non-unique between an Item's accounts. It may also not match the mask that the bank displays to the user." If Account Select is on, `accounts` "will only include selected accounts".
- Stable `onEvent` names for logic include `OPEN`, `EXIT`, `HANDOFF`, `SELECT_INSTITUTION`, `ERROR`. OAuth adds `CLOSE_OAUTH` and `FAIL_OAUTH`, which fire only in the pop-up flow ([OAuth](https://plaid.com/docs/link/oauth/#handling-link-events)). "Callback ordering is not guaranteed".

### 3.3 CSP

Plaid's published directives:

```
default-src https://cdn.plaid.com/;
script-src 'unsafe-inline' https://cdn.plaid.com/link/v2/stable/link-initialize.js;
style-src 'unsafe-inline';
style-src-elem 'unsafe-inline';
style-src-attr 'unsafe-inline';
frame-src https://cdn.plaid.com/;
connect-src https://production.plaid.com/;
```

"If using Sandbox ... update the `connect-src` directive to point to ... `https://sandbox.plaid.com`." There's also a nonce variant: `script-src 'nonce-...'`, `style-src 'nonce-...'`, `style-src-elem 'nonce-...'`, and `style-src-attr 'unsafe-inline'` (no nonce possible for attributes).

**Is `cdn.plaid.com` alone enough (spec §15)? No.** Compared with the current header in `src/server/app.ts` (`script-src 'self'`, `style-src 'self'`, `connect-src 'self'`, no `frame-src`), the connect pages need:

| Directive | Add | Why |
|---|---|---|
| `script-src` | `https://cdn.plaid.com/link/v2/stable/link-initialize.js` | The script. Plaid's list also has `'unsafe-inline'`; the nonce variant drops it. Whether our page needs inline script at all depends on how we call `Plaid.create` (from our bundle, it doesn't). |
| `frame-src` | `https://cdn.plaid.com/` | Link runs in an iframe |
| `connect-src` | `https://production.plaid.com/` (or sandbox) | Plaid lists it; **UNVERIFIED** what the parent page fetches |
| `style-src` / `-elem` / `-attr` | `'unsafe-inline'`, or a nonce plus `style-src-attr 'unsafe-inline'` | Link injects styles into our page |
| `default-src` | Plaid lists `https://cdn.plaid.com/` | **UNVERIFIED** which fetch type falls back to it (images or fonts, maybe). Safer to add it only on these pages. |

Plaid doesn't document a minimal set, so the only real test is a Sandbox Link session with CSP violation reporting on. **JUDGMENT:** start from Plaid's nonce variant, scoped to the two pages below, and tighten only what the violation reports prove unused.

Two structural points:

- **Two pages, not one.** On a redirect OAuth flow Link is re-initialized on the `redirect_uri` page (3.4), so `/connect/plaid/oauth-return` needs the same exception as the connect page.
- **The app is an SPA.** CSP comes from the HTML document response. A client-side route change to "Connect bank" keeps the CSP the shell was served with. **INFERRED:** either the connect and OAuth-return pages are full page loads whose HTML response carries the relaxed CSP, or the relaxed CSP ends up on every route. The first matches the spec's intent.

`frame-ancestors 'none'` is unaffected; it controls who can frame us, not what we frame.

### 3.4 OAuth redirect flow

Source: [OAuth guide](https://plaid.com/docs/link/oauth/).

| Platform | Re-initialize Link at `redirect_uri`? |
|---|---|
| Desktop web | No |
| Mobile web | "Not required, but recommended in order to maximize Link conversion" |
| Webview (in-app browser from Mail, Facebook, etc.) | Yes |

- Desktop and mobile web "will always try to open the OAuth bank's website in a new pop-up window if possible (or in a new tab on mobile web), regardless of whether a `redirect_uri` is provided." Without one, webview users can't complete OAuth because those browsers "often do not support pop-ups". "All environments, including Sandbox, use the pop-up flow on desktop and mobile web, unless the page is accessed through a mobile webview." This answers spec §19 item 5 again, with the full text.
- Register the URI in the Dashboard's Allowed redirect URIs. HTTPS only, except localhost over HTTP in Sandbox. Subdomain wildcards are allowed in the allowlist, never in the request.
- On return: "configure it using the same Link token you used when initializing Link the first time", with `receivedRedirectUri: window.location.href`. That URL is the redirect URI plus `?oauth_state_id=<uuid>`, and "must not contain any extra query parameters or fragments other than what is provided upon redirect."
- Where to keep the token: "If Link is reinitialized in the _same_ browser session ..., you can store the Link token in a cookie or local storage" (the Quickstart uses `localStorage`). For a different browser session, "store a mapping of the Link token associated with the user (server-side) ..., authenticate the user, fetch the corresponding Link token from the server". A webview return can easily be a different session, so **JUDGMENT:** keep it server-side, bound to the admin's session, like `calendar_link_pending`.
- iFrames: "Launching Link from within an iFrame is not recommended" and "you'll be unable to maintain user state."

### 3.5 BofA and Trial

- "If you are on a Trial plan, you do not need to complete these requirements until you upgrade to a paid plan" (app profile, company info, MSA, security questionnaire) ([OAuth prerequisites](https://plaid.com/docs/link/oauth/#prerequisites-for-adding-oauth-support)). "Access to Production (via either a paid plan or a trial) is a prerequisite for supporting OAuth."
- The BofA section doesn't mention Trial. The Chase and PNC sections each say "Unless you are on a Trial plan, you must ...", so Plaid calls out Trial exceptions per bank, and BofA has no extra requirement listed. That BofA works on Trial is **INFERRED** from the general rule; **UNVERIFIED** for BofA specifically (still spec §19 item 1).
- `INSTITUTION_REGISTRATION_REQUIRED`: "If your account was recently enabled for full Production access or a Trial plan, it may take up to 1-2 days to get access to certain institutions." ([Institution errors](https://plaid.com/docs/errors/institution/)). Expect this if the first link happens the day Trial is approved.
- BofA: "The migration to the new Bank of America API ended on October 15, 2026." New-API Items have "a 12-month consent expiration policy" and BofA's "own hosted account select screen" ([OAuth, Bank of America](https://plaid.com/docs/link/oauth/#bank-of-america)).
- Consent expiry: `PENDING_DISCONNECT` (US) arrives "one week before" expiry. Without a refresh "the Item will enter the `ITEM_LOGIN_REQUIRED` error state" ([OAuth, refreshing consent](https://plaid.com/docs/link/oauth/#refreshing-item-consent)).
- User revocation at the bank: the Item enters `ITEM_LOGIN_REQUIRED` "after approximately 24-48 hours" ([OAuth, consent revocation](https://plaid.com/docs/link/oauth/#managing-consent-revocation)).

---

## 4. `/item/public_token/exchange`, `/item/get`, `/accounts/get`

### 4.1 Exchange

Request: `public_token`. Response: `access_token`, `item_id`, `request_id`. "An `access_token` does not expire, but can be revoked by calling `/item/remove`." Store `item_id` with the token: "The `item_id` is used to identify an Item in a webhook" ([Items API](https://plaid.com/docs/api/items/#itempublic_tokenexchange)).

**Duplicates cost a Trial slot.** "A duplicate Item will be created if the end user logs into the same institution with the same credentials a second time ... and if an access token is requested for the Item." Plaid's advice: compare `onSuccess` metadata (`institution_id`, account `name`, `mask`) with existing Items, and "Do not exchange a public token for an access token if you detect a duplicate Item" ([Preventing duplicate Items](https://plaid.com/docs/link/duplicate-items/)). Also, one cause of `ITEM_LOGIN_REQUIRED` is: "The institution uses an OAuth-based connection that does not allow duplicate Items, but the user connected a duplicate Item" ([Item errors](https://plaid.com/docs/errors/item/#item_login_required)). Whether BofA is one of those is **UNVERIFIED**. **INFERRED:** a public token that's never exchanged doesn't use a Trial Item, since billing counts "All access tokens created in Production". No page says it outright.

### 4.2 `/item/get` (needed, not in the question list)

The exchange doesn't return the consent date. `/item/get` returns `item.consent_expiration_time` ("`null`" if none is scheduled), `institution_id`, `institution_name`, `error`, `products`, `consented_products`, `billed_products`, `update_type`, `created_at`, and `status.transactions.last_successful_update` ([Items API](https://plaid.com/docs/api/items/#itemget)). Call it after the exchange and after each update mode to fill `plaid_items.consent_expiration_time` and the institution columns. Rate limit: 15 per minute per Item ([Rate limits](https://plaid.com/docs/errors/rate-limit-exceeded/)).

### 4.3 `/accounts/get`

Source: [Accounts API](https://plaid.com/docs/api/accounts/).

| Field | Notes |
|---|---|
| `account_id` | "will not change unless Plaid can't reconcile the account with the data returned by the financial institution. This may occur, for example, when the name of the account changes." |
| `type` / `subtype` | Card: `credit` / `credit card` (subtype is nullable) |
| `mask` | nullable; "last 2-4 alphanumeric characters", "may be non-unique between an Item's accounts" |
| `name` | "assigned by the user or by the financial institution" |
| `official_name` | nullable |
| `balances.current`, `balances.limit`, `balances.iso_currency_code`, `balances.unofficial_currency_code` | cached; "will typically update about once a day" |
| `persistent_account_id` | **Not useful here.** "currently supported only for Items at institutions that use Tokenized Account Numbers (i.e., Chase, PNC, and US Bank)" and described "for depository accounts". Expect it absent for BofA cards. |

"Plaid will only return active bank accounts". It's free and serves cached data. Rate limit: 15 per minute per Item. `/transactions/sync` also returns `accounts[]` with the same fields, but "Only accounts that have associated transactions will be shown" ([Transactions API](https://plaid.com/docs/api/products/transactions/#transactionssync)), so use `/accounts/get` to list cards at link time.

---

## 5. `/transactions/sync`

Source unless noted: [Transactions API](https://plaid.com/docs/api/products/transactions/#transactionssync).

### 5.1 Request

| Field | Notes |
|---|---|
| `access_token` | required |
| `cursor` | Omitted means "the entire history of updates will be returned". `"now"` is only for migrating from `/transactions/get`. "The upper-bound length of this cursor is 256 characters of base64." |
| `count` | default 100, min 1, **max 500** |
| `options.include_original_description` | default `false` |
| `options.personal_finance_category_version` | `v1` / `v2`. "If you enabled Transactions or Enrich on or after December 3, 2025, you may only receive the `v2` taxonomy." |
| `options.days_requested` | Only for Items not initialized with Transactions. We initialize in Link, so it has no effect. |
| `options.account_id` | Makes a separate stream with its own cursor. Don't use it (one cursor per Item matches `plaid_items.cursor`). |

`options.include_personal_finance_category` no longer exists in the docs. The OpenAPI keeps it as `deprecated: true`, `x-hidden-from-docs: true`, described as "Personal finance categories are now returned by default." Don't send it. Do send `personal_finance_category_version: "v2"`, as the 6a handoff says.

### 5.2 Response and pagination

- `added`, `modified`, `removed` (`transaction_id`, `account_id`), `next_cursor`, `has_more`, `transactions_update_status`, `accounts`, `request_id`.
- `has_more`: "If `has_more` is true, it's important to pull all available pages, to make it less likely for underlying data changes to conflict with pagination."
- `next_cursor`: "The cursor obtained after all pages have been pulled ... will be valid for at least 1 year." "If transactions are not yet available, this will be an empty string."
- Store the cursor only "After successfully pulling all currently available pages" ([Add Transactions to your app](https://plaid.com/docs/transactions/add-to-app/)).
- `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` (HTTP 400, `TRANSACTIONS_ERROR`): "the entire pagination request loop must be restarted beginning with the cursor for the first page of the update, rather than retrying only the single request that failed."
- `TRANSACTIONS_SYNC_ITEM_LIMIT_EXCEEDED`: "Do not retry or restart pagination for this Item" ([Transactions errors](https://plaid.com/docs/errors/transactions/)).
- Rate limit: 50 per minute per Item, error `TRANSACTIONS_SYNC_LIMIT` (HTTP 429, `RATE_LIMIT_EXCEEDED`) ([Rate limits](https://plaid.com/docs/errors/rate-limit-exceeded/#transactions_sync_limit)). At 500 per page, 50 pages per minute is 25,000 transactions, far more than two years of a family's cards.
- `PRODUCT_NOT_READY` isn't a sync error. The errors overview lists it for `/transactions/get`, and sync instead "will return empty transactions arrays" when data isn't ready ([Errors](https://plaid.com/docs/errors/)).

### 5.3 First sync and the historical pull

- **Call sync once right after the exchange.** "to receive this webhook for an Item, `/transactions/sync` must have been called at least once on that Item." (`SYNC_UPDATES_AVAILABLE`). Until then, no webhooks.
- Timing: "Typically, the first 30 days of transaction history is available to be fetched almost immediately, but full transaction history may take a minute or more" ([Add Transactions](https://plaid.com/docs/transactions/add-to-app/)). For the `/transactions/get` webhooks Plaid gives "`INITIAL_UPDATE` typically fires within 10 seconds, and `HISTORICAL_UPDATE` within 1 minute, although these webhooks may take 2 minutes or more" ([Transactions webhooks](https://plaid.com/docs/transactions/webhooks/)).
- `SYNC_UPDATES_AVAILABLE` carries `initial_update_complete` ("most recent 30 days") and `historical_update_complete` ("maximum transaction history requested, up to 2 years"). The sync response's `transactions_update_status` gives the same state: `NOT_READY`, `INITIAL_UPDATE_COMPLETE`, `HISTORICAL_UPDATE_COMPLETE`, or `TRANSACTIONS_UPDATE_STATUS_UNKNOWN`.
- `INITIAL_UPDATE`, `HISTORICAL_UPDATE`, `DEFAULT_UPDATE` and `TRANSACTIONS_REMOVED` still fire "to maintain backwards compatibility". With sync, Plaid says to act on `SYNC_UPDATES_AVAILABLE` instead. Acknowledge the others and ignore them.
- Update cadence: "Plaid typically checks for new transactions data between one and four times per day, depending on the institution." The spec's 6-hour backup sync is in line with that.
- Churn: "A transaction may be removed if its details are changed by the bank so extensively that Plaid can no longer recognize the new and old versions ... This "transaction churn" can affect both pending and posted transactions." ([Transactions webhooks](https://plaid.com/docs/transactions/webhooks/)). So a posted row in `removed`, with a new id in `added`, is a documented case, not just an anomaly.
- `/transactions/refresh` forces a bank pull. It's included on Trial ("Transactions (including Transactions Refresh)", [Billing](https://plaid.com/docs/account/billing/#trial-plans)) but has its own per-request fee on paid plans and needs a product access request there ([Transactions API, refresh](https://plaid.com/docs/api/products/transactions/#transactionsrefresh)). Rate limit: 2 per minute and 120 per hour per Item. Latency "typically less than 10 seconds, but occasionally up to 30 seconds or more". Results arrive through `SYNC_UPDATES_AVAILABLE`.

---

## 6. `/liabilities/get`

Source: [Liabilities API](https://plaid.com/docs/api/products/liabilities/).

- Request: `access_token`, optional `options.account_ids` (array). "An error will be returned if a provided `account_id` is not associated with the Item".
- Supported: `credit` / `credit card` and `paypal`, and the loan subtypes.
- Refresh: "Data is refreshed approximately once per day".
- Webhook `LIABILITIES` / `DEFAULT_UPDATE` "will be fired when new or updated liabilities have been detected", with `account_ids_with_new_liabilities` and `account_ids_with_updated_liabilities` (account id to changed field names). The [Liabilities overview](https://plaid.com/docs/liabilities/) says to listen for it, then call `/liabilities/get` again.
- Rate limit: 30 per minute per Item.
- "liabilities data does not contain detailed transaction history for credit card accounts" ([Liabilities overview](https://plaid.com/docs/liabilities/)).
- Errors: `NO_LIABILITY_ACCOUNTS` (also when the user "did not grant permission in the OAuth flow ... to share details for any liabilities accounts"), `ACCESS_NOT_GRANTED`, `PRODUCT_NOT_ENABLED` ([Item errors](https://plaid.com/docs/errors/item/)).
- **UNVERIFIED:** whether `DEFAULT_UPDATE` fires for an Item whose Liabilities is only in `additional_consented_products` before the first `/liabilities/get` call. With `required_if_supported_products` or `products` (2.2), Liabilities is initialized at Link, so this doesn't come up.
- Field shapes for `liabilities.credit[]`: see spend-plaid-csv.md §4. Whether BofA fills `last_statement_issue_date` is still **UNVERIFIED** (spec §19 item 1).

**JUDGMENT:** call it once per Item without `account_ids` and pick the included cards out of the result. One call per Item covers every card, and filtering by ids means an error if a card's account id has changed.

---

## 7. Webhook verification

Source: [Webhook verification](https://plaid.com/docs/api/webhooks/webhook-verification/).

### 7.1 The documented steps

1. Read the `Plaid-Verification` header (case-insensitive; lowercase on HTTP/2). Its value is a JWT.
2. Decode the JWT header without verifying. "Ensure that the value of the `alg` (algorithm) field in the header is `"ES256"`. Reject the webhook if this is not the case." Take `kid`.
3. Call `/webhook_verification_key/get` with `key_id: kid`. The response `key` is a JWK: `alg` (`ES256`), `crv` (`P-256`), `kid`, `kty` (`EC`), `use` (`sig`), `x`, `y`, `created_at` (Unix time), `expired_at` (nullable, Unix time).
4. Verify the JWT signature with that JWK; reject if invalid.
5. Payload: `iat` and `request_body_sha256`. "Use the issued at time denoted by the `iat` field to verify that the webhook is not more than 5 minutes old."
6. SHA-256 the body and compare it with `request_body_sha256`, using "a constant time string/hash comparison". "the `request_body_sha256` ... is sensitive to the whitespace in the webhook body and uses a tab-spacing of 2." In other words, hash the raw bytes as received, never a re-serialized object.

The page also says "The verification process is optional". The spec makes it mandatory, which is right.

### 7.2 Key caching and rotation

- Plaid's Node example (both SDK flavours) keeps a single `cachedKey` and only fetches when it's empty, so it would keep using an old key after a rotation and reject every webhook signed with the new `kid`. The Go example caches by `kid` (`jwkCache = map[string]...`), which is the right shape.
- The docs don't say how often keys rotate, how long a `kid` stays valid, or what to do with `expired_at`. The `kid` description says it can "choose among a set of keys within the JWK during key rollover." **UNVERIFIED:** rotation cadence and `expired_at` semantics.
- **JUDGMENT:** cache keys in memory by `kid`. Fetch on a miss. Refuse a key whose `expired_at` is set and in the past, and refetch it at most once per some interval. Rate-limit fetches of unknown `kid`s and cache misses briefly. The `kid` is attacker-controlled input: anyone can POST to `/webhooks/plaid`, and without a miss limit each forged `kid` turns into an authenticated call to Plaid with our secret. `/webhook_verification_key/get` isn't in Plaid's rate-limit table, so its limit is **UNVERIFIED**.

### 7.3 `jose` or `node:crypto`

Either works.

**`jose`** (6.2.17 is already in `node_modules` as a dependency of `openid-client` 6.9.0, so declaring it directly adds nothing to install). Plaid's own Node example uses it:

```ts
import { importJWK, jwtVerify, decodeProtectedHeader } from 'jose';
const { alg, kid } = decodeProtectedHeader(token);      // reject unless alg === 'ES256' and kid is a string
const key = await importJWK(jwk, 'ES256');
const { payload } = await jwtVerify(token, key, { algorithms: ['ES256'], maxTokenAge: '5 min' });
// then: timingSafeEqual(sha256hex(rawBody), payload.request_body_sha256)
```

From jose's source here (`dist/webapi/lib/jwt_claims_set.js`), `maxTokenAge` requires `iat` to be present and rejects an `iat` in the future ("it should be in the past"). `clockTolerance` applies to `iat` when `maxTokenAge` is set, and `currentDate` lets tests pin the clock ([JWTVerifyOptions](https://github.com/panva/jose/blob/main/docs/jwt/verify/interfaces/JWTVerifyOptions.md)). Plaid's example omits `algorithms`. Pass it anyway, so a key's algorithm can't widen what's accepted.

**`node:crypto`** with no dependency: `crypto.createPublicKey({ key: jwk, format: 'jwk' })`, then `crypto.verify('sha256', Buffer.from(headerB64 + '.' + payloadB64), { key, dsaEncoding: 'ieee-p1363' }, base64urlDecode(sigB64))`. JWS ES256 signatures are raw `r || s`, which is what `'ieee-p1363'` means ([Node crypto docs](https://github.com/nodejs/node/blob/v22.x/doc/api/crypto.md)). You then parse the JSON and check `alg`, `typ` and `iat` yourself.

**JUDGMENT:** use `jose`. Plaid's docs say "It is highly recommended that you utilize well-tested libraries rather than trying to implement these specifications from scratch", and jose is already in the tree. Declare it in `package.json` so it isn't only a transitive dependency.

Raw body in Hono: read `await c.req.arrayBuffer()` (or `text()`) once, hash those bytes, then `JSON.parse` the same bytes. Compare digests as equal-length `Buffer`s with `crypto.timingSafeEqual` (Plaid's examples compare lowercase hex).

### 7.4 Webhooks 6b needs

Every webhook body has `webhook_type`, `webhook_code`, `item_id`, and `environment` (`sandbox` / `production`).

| Type / code | Meaning | Fields beyond the common ones | Action |
|---|---|---|---|
| `TRANSACTIONS` / `SYNC_UPDATES_AVAILABLE` | changes ready | `initial_update_complete`, `historical_update_complete` | run the sync job for the Item |
| `TRANSACTIONS` / `INITIAL_UPDATE`, `HISTORICAL_UPDATE`, `DEFAULT_UPDATE`, `TRANSACTIONS_REMOVED` | legacy, for `/transactions/get` | | 200 and ignore |
| `ITEM` / `ERROR` | "The error can be resolved by having the user go through Link's update mode." | `error` (no `request_id` in webhook errors; has `status`) | if `ITEM_LOGIN_REQUIRED`, mark needs_reconnect |
| `ITEM` / `PENDING_DISCONNECT` | US/CA; "fired 7 days before the existing Item is scheduled for disconnection" | `reason` (`INSTITUTION_MIGRATION`, `INSTITUTION_TOKEN_EXPIRATION`), `disconnect_time` | warn admins, offer Reconnect |
| `ITEM` / `PENDING_EXPIRATION` | "fired only for Items associated with institutions in Europe (including the UK)" | | not expected for BofA; handle as `PENDING_DISCONNECT` anyway |
| `ITEM` / `USER_PERMISSION_REVOKED` | revoked via Plaid. If revoked at the bank, "this webhook may not always fire". Update mode may not be possible; "create a fresh Link token for the user" | `error` | mark needs_reconnect; a fresh link is a new Trial Item |
| `ITEM` / `USER_ACCOUNT_REVOKED` | account-level; "currently sent only for Chase, PNC, and Truist" | `account_id` | not expected for BofA |
| `ITEM` / `LOGIN_REPAIRED` | the Item left `ITEM_LOGIN_REQUIRED` without our update mode | | clear needs_reconnect |
| `ITEM` / `NEW_ACCOUNTS_AVAILABLE` | "Plaid detects a new account"; doesn't fire if the user opted out of sharing new accounts in the bank's OAuth settings | `error` | offer update mode with Account Select |
| `ITEM` / `CONSENT_UPDATED` (beta) | the user changed the consent duration at the bank | `consent_expiration_time` (the new value) | store it |
| `ITEM` / `WEBHOOK_UPDATE_ACKNOWLEDGED` | after `/item/webhook/update` | | ignore |
| `LIABILITIES` / `DEFAULT_UPDATE` | new or updated liabilities | `account_ids_with_new_liabilities`, `account_ids_with_updated_liabilities`, `error` | run `/liabilities/get` for the Item |

Sources: [Items API webhooks](https://plaid.com/docs/api/items/#webhooks), [Transactions API webhooks](https://plaid.com/docs/api/products/transactions/#webhooks), [Liabilities API webhooks](https://plaid.com/docs/api/products/liabilities/#webhooks).

### 7.5 Delivery, retries, required response

From [Webhooks](https://plaid.com/docs/api/webhooks/):

- "If there is a non-2xx response or no response within 10 seconds ..., Plaid will keep attempting to send the webhook for up to 24 hours." Delays start at 30 seconds, and each is four times the last.
- "`4xx` responses other than `408`, `425`, and `429` are treated as permanent failures and are not retried."
- On `429`, Plaid honours `Retry-After` (seconds, HTTP date, or ISO 8601), "for up to a maximum of 4 hours".
- No body is required. Any 2xx counts as delivered.
- "design your application to handle duplicate and out-of-order webhooks." Keep the receiver minimal ("write the webhook into a queue or reliable storage").
- Missed webhooks: "If you (or Plaid) experience downtime for longer than Plaid's retry period, you will lose webhooks." The fix is polling, which the 6-hour job already does. `/beta/webhook_events/list` returns the last 7 days of sent webhooks.
- Source IPs: `52.21.26.131`, `52.21.47.157`, `52.41.247.19`, `52.88.82.239`, "subject to change". Fine as an extra nginx filter, never as the only check.

**JUDGMENT** on status codes:

- Bad, missing or expired signature, or a hash mismatch: 400 or 401. Not retried, which is what we want for forgeries.
- Can't fetch the verification key (Plaid or network down): 503, so Plaid retries.
- Verified but `environment` doesn't match `PLAID_ENV`, or `item_id` is unknown: 200 and a log line. A 4xx gains nothing, and 5xx would make Plaid retry for 24 hours.
- Verified: 200 straight away, then enqueue the job keyed by Item (the existing `KeyedLock`).

---

## 8. Errors

### 8.1 Error object

From [Errors](https://plaid.com/docs/errors/): `error_type` and `error_code` ("Safe for programmatic use"), `error_code_reason` (only for OAuth Item errors and expired Sandbox Items: `OAUTH_INVALID_TOKEN`, `OAUTH_CONSENT_EXPIRED`, `OAUTH_USER_REVOKED`, `SANDBOX_ITEM_EXPIRED`), `error_message` and `display_message` ("may change over time and is not safe for programmatic use"; `display_message` is `null` when not user-related), `request_id` (omitted in webhook errors), `causes`, `status` (in webhooks only), `documentation_url`, `suggested_action`. HTTP: 4xx developer or user, 5xx Plaid. New `error_code`s can appear without a version bump ([Versioning](https://plaid.com/docs/api/versioning/)), so unknown codes need a default branch.

### 8.2 Classification for 6b

| Code (type, HTTP) | Means | App state |
|---|---|---|
| `ITEM_LOGIN_REQUIRED` (`ITEM_ERROR`, 400) | expired or revoked consent, password change, migration, a duplicate Item at a no-duplicates OAuth bank, or Sandbox Item over 30 days old | needs_reconnect (update mode) |
| `ACCESS_NOT_GRANTED` (`ITEM_ERROR`, 400) | user didn't share the needed data in OAuth | needs_reconnect (update mode to grant it) |
| `NO_ACCOUNTS` (`ITEM_ERROR`, 400) | closed, revoked, or "account churn" | needs_reconnect |
| `NO_LIABILITY_ACCOUNTS` (`ITEM_ERROR`, 400) | no liabilities shared | keep syncing transactions; fall back to inferred closing dates |
| `PASSWORD_RESET_REQUIRED`, `ITEM_LOCKED` (`ITEM_ERROR`, 400) | user must act at the bank | needs_reconnect, with the bank-side message |
| `ITEM_NOT_FOUND` (`ITEM_ERROR`, 400) | "removed via /item/remove, or has had access removed by the user" (my.plaid.com, or a Plaid deletion request) | treat as removed, not reconnectable |
| `INVALID_ACCESS_TOKEN` (`INVALID_INPUT`) | **UNVERIFIED**, I didn't read the invalid-input page | treat as a broken connection, alert |
| `PRODUCT_NOT_READY` (`ITEM_ERROR`, 400) | `/transactions/get` only; "can be resolved by retrying a few seconds later" ([Versioning](https://plaid.com/docs/api/versioning/)) | shouldn't happen on sync; retry later if it does |
| `INSTITUTION_DOWN`, `INSTITUTION_NOT_RESPONDING`, `INSTITUTION_NOT_AVAILABLE` (`INSTITUTION_ERROR`, 400) | temporary bank outage | transient: back off, keep status OK, count failures |
| `INTERNAL_SERVER_ERROR` (`API_ERROR`, 500) | Plaid or bank internal. Also listed: a product call on an OAuth Item "but the end user did not authorize the Item for the specific product" | transient, but if it persists on one Item, suspect consent |
| `PLANNED_MAINTENANCE` (`API_ERROR`, 503) | Plaid maintenance | transient |
| `TRANSACTIONS_SYNC_LIMIT` and other `RATE_LIMIT_EXCEEDED` (429) | rate limit | back off |
| `TRIAL_CONNECTION_LIMIT` (`RATE_LIMIT_EXCEEDED`, 429) | "The Plaid Trial plan connection limit has been reached." | **permanent**. Its `error_type` is `RATE_LIMIT_EXCEEDED`, so a naive "retry on rate limit" branch would loop. Match on the code first. |
| `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` (`TRANSACTIONS_ERROR`, 400) | data changed mid-loop | restart the loop from the stored cursor |
| `INSTITUTION_REGISTRATION_REQUIRED`, `UNAUTHORIZED_INSTITUTION` (`INSTITUTION_ERROR`, 400) | not yet enabled (Trial: "up to 1-2 days") | show at link time, try later |

Sources: [Item errors](https://plaid.com/docs/errors/item/), [Institution errors](https://plaid.com/docs/errors/institution/), [API errors](https://plaid.com/docs/errors/api/), [Rate limit errors](https://plaid.com/docs/errors/rate-limit-exceeded/), [Transactions errors](https://plaid.com/docs/errors/transactions/).

### 8.3 Retry guidance

Plaid publishes no general retry or backoff policy that I found. What it does say:

- Rate limits "are based on fixed windows, not rolling periods" ([Rate limits](https://plaid.com/docs/errors/rate-limit-exceeded/)).
- The SDK's view: v51's `requestWithRetries.js` defaults `maxRetries` to 0, with the comment "callers opt in to retries ... A retried transfer or payment may already have succeeded." When enabled, it retries 408, 429 and 5xx with exponential backoff from 1 s (capped at 60 s, 20% jitter), and reads `Retry-After`.
- **UNVERIFIED:** whether Plaid's API sends `Retry-After` on its 429s.

**JUDGMENT:** retry only idempotent reads (`/transactions/sync` with the same cursor, `/liabilities/get`, `/accounts/get`, `/item/get`, `/webhook_verification_key/get`). Use 2 or 3 attempts, exponential from 1 s, on 429 (except `TRIAL_CONNECTION_LIMIT`), 5xx, `INSTITUTION_*` transient codes, and network errors. Never auto-retry `/item/public_token/exchange` (a retry after a lost response can't create a second Item, since the public token is single-use, but you'd get an error instead of the token; **UNVERIFIED** what that error is). Don't auto-retry `/link/token/create` either; the user can click again. `/item/remove` gets the capped background retry the handoff already describes.

---

## 9. `/item/remove` and the Trial count

- **Confirmed, twice:** "On a Trial plan, calling `/item/remove` does not impact the number of remaining Trial Items (bank connections) you have available." ([Items API, /item/remove](https://plaid.com/docs/api/items/#itemremove)), and "Removing Items created on a Trial plan (using /item/remove) will _not_ allow you to create more Items." ([Billing, Trial plan limitations](https://plaid.com/docs/account/billing/#trial-plan-limitations)).
- "All access tokens created in Production will count against your Trial plan Item limit" (Billing). "You can see how many Production Items you have created on your Dashboard homepage" (Billing), which is the ground truth if the local counter ever drifts.
- Request: `access_token` (required), optional `reason_code` (`FRAUD_*`, `CONNECTION_IS_NON_FUNCTIONAL`, `OTHER`) and `reason_note` (max 512, no PII). Response: `request_id`.
- "for certain OAuth-based institutions, an Item removed via /item/remove may still show as an active connection in the institution's OAuth permission manager." Worth a line in the remove dialog.
- After an upgrade, `/item/remove` "is required to end subscription billing for the Item".

---

## 10. Library choice: `plaid` npm vs plain `fetch`

### 10.1 The package today

| | Value | Source |
|---|---|---|
| Latest | **51.0.0**, published 2026-11-06. 50.0.0 was 2026-11-02; 49.0.0 was 2026-10-19. Twelve majors since 42.0.0 on 2026-04-16. | npm registry `time` |
| Maintained | Yes. Maintainers `plaid-admin` and `plaid-devx`. `plaid/plaid-node` last pushed 2026-11-06, not archived. README: "typically updated on a monthly basis", semver majors for breaking changes. | registry, `gh api repos/plaid/plaid-node` |
| Size | **26.0 MB unpacked, 11,911 files** (`dist/cjs` 17 MB, `dist/esm` 16 MB, `dist/legacy` 14 MB). v50 was 19.0 MB. | registry `dist.unpackedSize`, tarball |
| Runtime deps | `axios ^1.7.4` (axios 1.21.1 itself depends on `form-data`, `proxy-from-env`, `follow-redirects`, `https-proxy-agent`) | registry |
| HTTP client | **Both.** v51 "introduces a new SDK" (generated by Fern) that uses `fetch` (`core/fetcher/getFetchFn.js`, `makeRequest.js`). The old axios-based SDK moved to `plaid/legacy`. Installing either way pulls in axios. | README, tarball |
| Node | `engines.node >= 18` | registry |
| Logging hazard | Legacy README: "the full error object includes the API configuration object, including the request headers, which in turn include the API key and secret". | README |
| Retries | v51 defaults `maxRetries` to 0 | tarball |

### 10.2 What 6b calls

`/link/token/create`, `/item/public_token/exchange`, `/item/get`, `/item/remove`, `/accounts/get`, `/transactions/sync`, `/liabilities/get`, `/webhook_verification_key/get`, maybe `/transactions/refresh` and `/item/webhook/update`. That's 8 to 10 POSTs with JSON bodies and the same two auth headers.

### 10.3 Recommendation

**JUDGMENT: plain `fetch`.** Reasons:

- It matches the repo. Todoist and Google already use `fetch`, and responses are already validated with zod at the boundary. An SDK's TypeScript types aren't runtime validation, so we'd validate either way.
- Weight: 26 MB and about 12,000 files plus axios's tree, for 10 endpoints.
- Churn: four majors in the last five weeks, plus a new client shape in v51 with the old one kept under `plaid/legacy`. With `fetch` we pin `Plaid-Version: 2020-09-14` and only the API's own versioning applies, which is stable ([Versioning](https://plaid.com/docs/api/versioning/) lists breaking-change rules).
- Testability: the in-process fake becomes a `fetch` stub, or a tiny Hono app, keyed by path, with no SDK internals in the way.
- Secret hygiene is in our hands: headers set in one place, and request headers never logged.

What we lose: generated types. Mitigation: hand-write zod schemas for only the fields we read, citing the OpenAPI component names (`TransactionsSyncResponse`, `LiabilitiesGetResponse`, `JWKPublicKey`, `PlaidError`), and pin the OpenAPI commit they were checked against.

This contradicts spec §3.1 ("Official `plaid` Node SDK on the server"); see Implications.

---

## 11. Sandbox, for designing the fake

| Item | What Plaid documents | Source |
|---|---|---|
| `ins_109508` | First Platypus Bank, non-OAuth. Plaid's suggested institution for special test credentials and `/sandbox/public_token/create`. | [Sandbox institutions](https://plaid.com/docs/sandbox/institutions/), [Test credentials](https://plaid.com/docs/sandbox/test-credentials/) |
| OAuth test banks | `ins_127287` Platypus OAuth Bank. `ins_129644` First Platypus Bank - OAuth (populates `consent_expiration_time`, 30 days out). | same, and [OAuth, testing](https://plaid.com/docs/link/oauth/#testing-oauth) |
| `user_good` / `pass_good` | "basic account access to most Plaid products" | Test credentials |
| `user_transactions_dynamic` (any non-blank password) | "realistic transaction history", including credit card. "may update transactions and fire webhooks when `/transactions/refresh` is called" | Test credentials |
| `/sandbox/public_token/create` | Skips Link. `institution_id` and `initial_products` required; `options.webhook`, `options.override_username` (default `user_good`), `options.override_password` (default `pass_good`), `options.transactions.days_requested`. Returns a `public_token` to exchange as usual. | [Sandbox API](https://plaid.com/docs/api/sandbox/#sandboxpublic_tokencreate) |
| `/sandbox/item/fire_webhook` | `access_token`, `webhook_code` (required), `webhook_type`. Can fire `SYNC_UPDATES_AVAILABLE`, `DEFAULT_UPDATE` (types incl. `TRANSACTIONS`, `LIABILITIES`), `NEW_ACCOUNTS_AVAILABLE`, `LOGIN_REPAIRED`, `PENDING_DISCONNECT`, `CONSENT_UPDATED`, `USER_PERMISSION_REVOKED`, `USER_ACCOUNT_REVOKED`, and others. **It cannot fire `ITEM` / `ERROR`**; the `ERROR` code it lists is the Assets one. | [Sandbox API](https://plaid.com/docs/api/sandbox/#sandboxitemfire_webhook) |
| `/sandbox/item/reset_login` | Forces `ITEM_LOGIN_REQUIRED` and fires the Item error webhook. Sandbox Items also go to `ITEM_LOGIN_REQUIRED` "automatically after 30 days" (`error_code_reason` `SANDBOX_ITEM_EXPIRED`). | [Sandbox API](https://plaid.com/docs/api/sandbox/#sandboxitemreset_login) |
| `/sandbox/transactions/create` | Up to 10 custom transactions per call on an existing Sandbox Item | [Sandbox API](https://plaid.com/docs/api/sandbox/#sandboxtransactionscreate) |
| Webhooks in Sandbox | "will fire as normal", signed the same way. The verification page's first step points at Sandbox webhooks for testing. | [Webhooks](https://plaid.com/docs/api/webhooks/#testing-webhooks-in-sandbox) |
| Sandbox rate limits | e.g. `/transactions/sync` 50 per minute per Item, 1,000 per minute per client | [Rate limits](https://plaid.com/docs/errors/rate-limit-exceeded/) |

**How the fake should behave** (INFERRED from the above):

- `/link/token/create` returns `link-sandbox-...`-style tokens and an `expiration` 4 hours out (30 minutes when `access_token` is given). It rejects `products` alongside `access_token` only if we want to catch our own mistakes; Plaid itself says "should be omitted", not "is rejected".
- Exchange returns `access-...` and `item_id`, and invalidates the public token.
- Sync: the first call with no cursor can return empty arrays, `next_cursor: ""` and `NOT_READY`. Later pages honour `count` up to 500 with `has_more`. A switch injects `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` on page N. `removed` holds only `transaction_id` and `account_id`. Pending to posted is `removed` plus `added` with `pending_transaction_id`, possibly on different pages.
- Webhooks: the fake signs ES256 JWTs with a test P-256 key (`crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })`, exported as JWK, or jose's `SignJWT`). It serves that JWK from `/webhook_verification_key/get` by `kid`, and puts `iat` and `request_body_sha256` (hex of the exact body bytes) in the payload. Tests should cover: wrong `alg`, unknown `kid`, rotated `kid`, `iat` over 5 minutes old, `iat` in the future, a body changed by one byte, and the header name in lowercase.
- Errors use Plaid's shape (`error_type`, `error_code`, `error_message`, `display_message`, `request_id`) and Plaid's HTTP codes (400 for Item errors, 429 for rate limits including `TRIAL_CONNECTION_LIMIT`, 500 for `INTERNAL_SERVER_ERROR`).

---

## Implications for the design

### Contradicts or needs changing in the spec

1. **§15 CSP is incomplete.** `cdn.plaid.com` for script and frame isn't enough. Plaid's list also needs `connect-src https://production.plaid.com/` (or sandbox), inline or nonce styles (`style-src`, `style-src-elem`, and `style-src-attr 'unsafe-inline'`), and `default-src https://cdn.plaid.com/`. And it applies to **two** pages: the connect page and `/connect/plaid/oauth-return`, where Link is re-initialized (§3.3, §3.4). Because the app is an SPA, those pages must be full page loads whose HTML response carries the relaxed header. Otherwise the exception leaks to every route. Sizing the minimum set needs a Sandbox session with CSP reports.
2. **§3.1 says the official `plaid` SDK.** I recommend plain `fetch` (§10). Change §3.1 if you agree.
3. **§12.2 products.** Spec: `transactions` and `liabilities` both in `products`. Valid, but Plaid recommends Liabilities outside `products` for personal-finance apps (§2.2). I'd use `required_if_supported_products: ["liabilities"]`. Either way, add `account_filters: { credit: { account_subtypes: ["credit card"] } }`, which also replaces "Accounts that aren't credit cards ... are ignored" with "never shared with us" (§2.3).
4. **§12.2 Link token storage for OAuth.** Re-initializing on the return page needs the **same** link token (§3.4). The spec doesn't say where it lives. It needs either `sessionStorage` (same-browser only) or a server-side row bound to the session, for example a `plaid_link_pending(id, user_id, session_hash, link_token, mode: new|update, plaid_item_id null, expires_at)` table with 4 h or 30 min expiry, like `calendar_link_pending`. That's a new, additive table.
5. **§12.2 duplicate Items.** Add a duplicate check **before** the exchange: compare `onSuccess` `institution.institution_id` and each account's `name` and `mask` with existing `plaid_items` and cards, and don't exchange on a match (§4.1). A duplicate costs one of the 10 Trial Items, and at some OAuth banks it can push the older Item into `ITEM_LOGIN_REQUIRED`.
6. **§12.2 Trial counter.** Confirmed: increment on every successful exchange. Also note `TRIAL_CONNECTION_LIMIT` is a 429 with `error_type: RATE_LIMIT_EXCEEDED` and must not be retried (§8.2). The Dashboard homepage shows Plaid's own count if ours drifts.
7. **§12.2 Reconnect.** Update mode doesn't create a new access token, so it doesn't use a Trial Item. That's INFERRED from "access_token does not change" plus "All access tokens ... count"; no page says it in one sentence. Two gaps:
   - At BofA, Account Select is always on in update mode, so a reconnect can deselect a card. Compare `onSuccess` `accounts` with the Item's cards, and handle a card that disappears (keep the history, flag it).
   - `USER_PERMISSION_REVOKED` may make update mode impossible ("create a fresh Link token"). That's a new Item, so it costs a Trial slot.
8. **§12.3 first sync.** Call `/transactions/sync` right after the exchange. `SYNC_UPDATES_AVAILABLE` doesn't fire until sync has been called once (§5.3). When `next_cursor` is `""`, store `null`, not `""`. Whether sending `""` equals omitting the cursor is **UNVERIFIED**.
9. **§12.3 webhooks.** The spec lists only `SYNC_UPDATES_AVAILABLE`. Add `ITEM` `ERROR`, `PENDING_DISCONNECT`, `USER_PERMISSION_REVOKED`, `LOGIN_REPAIRED`, `NEW_ACCOUNTS_AVAILABLE` and `CONSENT_UPDATED`, and `LIABILITIES` `DEFAULT_UPDATE`. Ack and ignore the legacy transaction codes. The handler must answer within 10 s, return 2xx after verification and do the work in the job, return 4xx for a bad signature (not retried), and return 5xx when the key can't be fetched (retried) (§7.5).
10. **§12.3 removed posted transactions** aren't only "rare". Plaid documents churn on posted rows (delete and re-add with a new id). The handoff's "log line" stays right. But manual category, person or note on a churned posted row is lost, since there's no `pending_transaction_id` link. Consider running the same card, amount and date matching the CSV duplicate test uses, from `removed` to `added` within one sync batch. INFERRED.
11. **§12.3 Refresh button.** Decide whether it means "sync now" (free, gets what Plaid has) or `/transactions/refresh` (forces a bank pull; on Trial; per-request fee and an access request after upgrading; 2 per minute per Item; up to 30 s or more) (§5.3).
12. **§12.4 daily `/liabilities/get` "for every included card"** is really per Item. Call it once per Item without `account_ids` and pick out included cards. Also trigger it on `LIABILITIES` `DEFAULT_UPDATE`, keeping the daily run as backup. Plaid refreshes liabilities "approximately once per day", so more than daily polling gains nothing.
13. **§15 webhook verification.** Add to the spec text:
    - Check `alg === "ES256"` before fetching a key.
    - Cache keys by `kid`, not as a single key (Plaid's Node sample has this bug).
    - Limit and briefly cache misses on unknown `kid`s, since the `kid` is attacker-controlled and each miss is an authenticated call to Plaid.
    - Reject an `iat` in the future.
    - Hash the raw bytes.
    - Check `environment` against `PLAID_ENV`.
14. **§3.4 config.** `PLAID_SECRET` is per environment (§1), so switching `PLAID_ENV` without switching the secret fails. The config check can't verify the pairing offline. Worth a sentence in the README.
15. **Revocation and retention (policy, not a hard contradiction).** Plaid's OAuth guide says that on revocation "you should delete the associated data", citing the 1033 rule's requirement on "third parties". §12.2 keeps transactions after removal unless the admin deletes them. In a self-hosted family app, the user and the operator are the same people, so keeping is defensible. JUDGMENT: keep the spec's choice and make the delete option visible when an Item is revoked or removed.

### Against the 6a schema

- **`cards`**: fits. `mask`, `plaid_name`, `plaid_official_name`, `plaid_type`, `plaid_subtype`, `iso_currency_code` map 1:1 from `/accounts/get`. Two caveats:
  - Plaid's mask "may also not match the mask that the bank displays", so attach-by-mask must stay a suggestion the admin confirms (as planned).
  - `persistent_account_id` won't exist for BofA cards, so there's no column to add for it. Re-matching after an account id change relies on `transactions.plaid_account_id` (already there).
- **`plaid_items`**: fits. `plaid_item_id`, `institution_id`, `institution_name`, `cursor`, `consent_expiration_time` (from `/item/get`, not the exchange), `last_webhook_code`, `removed_at`. Optional additions (nullable, additive): `historical_update_complete` (or `transactions_update_status`) so the UI can say "history still loading" and so the CSV-to-Plaid replacement waits for the full pull; `disconnect_time` from `PENDING_DISCONNECT`. These could also live in `connections.meta`.
- **`transactions`**: fits. Every field 6b stores has a column. Amounts: Plaid can send more than two decimal places in principle (§1), so the decimal-string-to-cents path should refuse or log a value that isn't whole cents rather than round silently. INFERRED; for a USD card it shouldn't happen.
- **`statements`**: fits (`source: 'plaid'`, `statement_balance_cents`, `payment_due_date`, `minimum_payment_cents`, `fetched_at`).
- **`settings.plaid_items_created`**: fits.
- **New**: `plaid_link_pending`, for the OAuth return (implication 4).

---

## UNVERIFIED list

- Whether BofA connects on a Trial team. INFERRED yes from the general Trial OAuth rule; no BofA-specific statement.
- Whether BofA fills `last_statement_issue_date` and the other `liabilities.credit` fields (carried over from the earlier research).
- Whether BofA disallows duplicate Items (which would push an older Item to `ITEM_LOGIN_REQUIRED`).
- Whether a public token that's never exchanged still counts toward the Trial limit. INFERRED no.
- That update mode doesn't count as a new Trial Item. INFERRED from "access_token does not change" plus "all access tokens count"; not stated in one place.
- The minimal CSP Link needs: what `default-src https://cdn.plaid.com/` and `connect-src` cover in the parent page.
- Whether anything depends on loading `link-initialize.js` on every page, as Plaid advises.
- Webhook key rotation cadence, how long a `kid` stays valid, and what `expired_at` means in practice.
- The rate limit on `/webhook_verification_key/get`.
- What `/webhook_verification_key/get` answers for a `kid` Plaid doesn't know (the error type, code and HTTP status). The fake answers `INVALID_REQUEST` / `INVALID_FIELD` with a 400. Since that's unverified, the app never treats a 4xx from the key endpoint as final: an unknown `kid` is remembered for 10 minutes and answered 503, so a real key Plaid hasn't published yet still gets Plaid's retries.
- Whether `LIABILITIES` `DEFAULT_UPDATE` fires for an Item where Liabilities is only an additional consented product, before the first `/liabilities/get`.
- Whether sending `cursor: ""` to `/transactions/sync` is the same as omitting it.
- Whether Plaid's API sends `Retry-After` on its own 429 responses.
- What error a second `/item/public_token/exchange` of the same public token returns.
- The `INVALID_ACCESS_TOKEN` details (I didn't read the invalid-input errors page).
- Which call returns `TRIAL_CONNECTION_LIMIT` (Link, the exchange, or both). The docs show a Link error preview and an API response.
