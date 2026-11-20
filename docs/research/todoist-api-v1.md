# Todoist API v1: verified reference notes

Researched 2026-11-15.

**Sources and how I checked them**

- Official docs: https://developer.todoist.com/api/v1/ (returns HTTP 200; it's a Redoc page). I pulled the embedded OpenAPI 3.1.0 spec out of the page and read the tag sections (Authorization, Sync, Webhooks, Due dates, Pagination, Request limits, Migrating from v9) plus the path and schema definitions. Section anchors are given below as `#tag/...`.
- Official TypeScript SDK: the package has been renamed twice. `@doist/todoist-api-typescript` (last version 7.10.0) is deprecated with the message "renamed to @doist/todoist-sdk". `@doist/todoist-sdk` (last version 17.0.1) is deprecated with the message "Moved to @todoist/sdk". **I checked `@todoist/sdk` 20.0.1** (published 2026-11-14), repo https://github.com/todoist/todoist-sdk-typescript, by reading the npm tarball's `dist/esm` source. I didn't run any of it. npm pages: https://www.npmjs.com/package/@todoist/sdk and https://www.npmjs.com/package/@doist/todoist-api-typescript
- Live, unauthenticated probes I ran myself (no token, no account):
  - OAuth discovery documents at https://api.todoist.com/.well-known/oauth-authorization-server and https://api.todoist.com/.well-known/oauth-protected-resource
  - Status codes from the old and new endpoints (results in section 7)

Every claim is tagged with its source. **UNVERIFIED** means the official docs don't state it. **SDK** means the claim comes only from the SDK source. **LIVE** means I observed it myself.

---

## 1. OAuth

Source: https://developer.todoist.com/api/v1/#tag/Authorization/OAuth

### Authorize

- `GET https://app.todoist.com/oauth/authorize`
- Required parameters:
  - `client_id`
  - `scope`: comma-separated
  - `state`
- Optional parameters:
  - `redirect_uri`: **required if the app has more than one redirect URI configured**; otherwise the request is rejected with `invalid_request`.
  - `response_type`: may be omitted or set to `code`. Only the authorization code flow is supported.
- On success the user is redirected back with `code` and `state` in the query string.
- Errors come back on the redirect as `?error=`. The documented values are `access_denied`, `invalid_application_status`, `invalid_scope` and `unsupported_response_type`. A "Redirect URI not configured" error is returned as JSON to the browser instead.
- Host discrepancy: the docs say `app.todoist.com`, discovery advertises `https://api.todoist.com/oauth/authorize` (LIVE), and the SDK builds `https://todoist.com/oauth/authorize` (SDK, `consts/endpoints.js`). I'd use the documented host.

### Token exchange

- `POST https://api.todoist.com/oauth/access_token`
- The docs example is form-encoded (`curl -d`).
- Parameters: `client_id`, `client_secret`, `code`. The example also sends `redirect_uri`.
- New apps get this response:
  ```json
  {"access_token": "...", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "...", "scope": "data:read_write"}
  ```
- Errors: `{"error":"bad_authorization_code"}` and `{"error":"incorrect_application_credentials"}`.

### Scopes

| Scope | Docs say |
|---|---|
| `task:add` | Add new tasks only. Can't read or modify existing data. |
| `data:read` | Read-only access to tasks, projects, labels and filters. |
| `data:read_write` | Read and write. **Includes `task:add` and `data:read`.** |
| `data:delete` | "Grants permission to delete application data, including tasks, labels, and filters." |
| `project:delete` | Delete projects. |
| `backups:read` | List backups without MFA. |

- Discovery also lists `billing:read`, `billing:read_write`, `user:read`, `user:write`, `workspaces:read`, `workspaces:write`, plus many `comms:*` and `automations:*` scopes (LIVE).
- `GET /api/v1/user` needs `user:read`, which the spec says is "implied by `data:read`".
- **Is `data:delete` needed to delete a task?** The scope description implies yes. Neither the docs nor the spec says which scope each endpoint or command requires. **UNVERIFIED** at the per-endpoint level. Requesting `data:read_write,data:delete` covers both readings.

### PKCE

- Supported. Discovery advertises `"code_challenge_methods_supported":["S256"]` (LIVE).
- The docs describe PKCE (`code_challenge` on authorize, `code_verifier` on token exchange) only for public clients: Client ID Metadata Document clients, and dynamically registered clients with `token_endpoint_auth_method: none`.
- **UNVERIFIED:** whether a confidential app registered in the console accepts or enforces PKCE alongside `client_secret`. Given S256 is advertised, I expect it's accepted, but the docs don't say so.

### Expiry and refresh

Source: https://developer.todoist.com/api/v1/#tag/Authorization (section "Refreshing access tokens")

- Expiry:
  - **New apps have refresh tokens enabled by default.** Access tokens expire after 1 hour (`expires_in: 3600`).
  - Legacy apps get `expires_in: 315360000` (10 years, a compatibility value) and no refresh token.
  - A legacy app can opt in through the App Management Console. This can't be undone, and tokens issued before opting in stay long-lived.
- Refresh request:
  - `POST https://api.todoist.com/oauth/access_token` with `grant_type=refresh_token`, `refresh_token`, `client_id`, and `client_secret` (confidential clients).
  - Optional `scope` narrows the grant.
- Client authentication can be `client_secret_post` (the default), `client_secret_basic`, or `none` (public clients).
- Rotation and replay detection:
  - **Refresh tokens rotate on every refresh.**
  - If the same consumed refresh token is presented again within 60 seconds, the response is 200 with the *same* new access token, but **no `refresh_token` field**.
  - Outside 60 seconds it's treated as replay: **all of that user's access and refresh tokens for the app are revoked**, and the user must re-authorize.
- Refresh errors: `invalid_grant`, `invalid_client`, `invalid_scope`, `unsupported_grant_type`.
- Expired token:
  - API calls return `401` with an `UNAUTHORIZED` body (`error_code` 477) and `WWW-Authenticate: Bearer error="invalid_token", ... resource_metadata="https://api.todoist.com/.well-known/oauth-protected-resource"`. The response may also carry `Retry-After`.
  - The docs say to refresh, and explicitly say not to wait and retry with the same expired token.

### Revocation

Source: https://developer.todoist.com/api/v1/#tag/Authorization (operations `revoke_token_rfc7009_compliant_api_v1_revoke_post` and `revoke_access_token_api_api_v1_access_tokens_delete`)

**Preferred: `POST https://api.todoist.com/api/v1/revoke`**

- RFC 7009 style. Discovery lists it as `revocation_endpoint` (LIVE).
- The client authenticates with `Authorization: Basic base64(client_id:client_secret)`.
- Body: `token` (required) and `token_type_hint` (optional; the only documented value is `access_token`).
- Encoding conflict:
  - The prose says the endpoint "accepts form-encoded data".
  - The OpenAPI `requestBody` declares `application/json`.
  - The SDK sends JSON (`{"token": ..., "token_type_hint": "access_token"}`) with Basic auth (SDK, `authentication.js` `revokeToken`).
  - **UNVERIFIED** which encoding the server requires. Probably both work; test it.
- Response: `200`.

**Legacy: `DELETE https://api.todoist.com/api/v1/access_tokens?client_id=...&client_secret=...&access_token=...`**

- All three values are required **query** parameters.
- Security note: this puts the client secret and token in the URL, where they end up in proxy and access logs. Avoid it.

**Gaps**

- **UNVERIFIED:** whether revoking an access token also invalidates its refresh token. Neither revoke endpoint documents a `refresh_token` hint.
- **UNVERIFIED:** whether revocation fires any webhook, or otherwise stops webhooks for that user.

### Redirect URIs

- Registered in the App Management Console ("configure one or more valid OAuth2 redirect URLs"): https://app.todoist.com/app/settings/integrations/app-management
- If there are several, you must pass `redirect_uri`.
- For dynamic registration, redirect URIs must be HTTPS, with localhost allowed for testing.
- **UNVERIFIED:** whether matching is exact (including path, trailing slash and query). The docs don't say. Assume exact match and register the precise callback URL.

### Other things that exist (not needed for us)

- Dynamic Client Registration (RFC 7591) at `POST https://api.todoist.com/oauth/register`.
- Client ID Metadata Documents.
- `POST /api/v1/access_tokens/migrate_personal_token`.

---

## 2. Sync endpoint

Source: https://developer.todoist.com/api/v1/#tag/Sync/Overview

### Request

- `POST https://api.todoist.com/api/v1/sync`. **GET was removed in v1** ([migration guide](https://developer.todoist.com/api/v1/#tag/Migrating-from-v9)).
- Body encoding:
  - The docs say: "Sync requests should be made in HTTP POST (`application/x-www-form-urlencoded`)". Responses, including errors, are JSON.
  - The SDK sends a JSON body with `Content-Type: application/json` for every POST, sync included (SDK, `transport/http-client.js`). So JSON evidently works too, but that's SDK evidence only.
- Read parameters:
  - `sync_token`: `*` returns "all active resource data". After that, pass the token from the previous response.
  - `resource_types`: a JSON-encoded array such as `["items","projects","user"]`. `"all"` includes everything, and a `-` prefix excludes a type (for example `-projects`).
- Sync is not listed under OpenAPI `paths`; it's documented only in the Sync tag prose.
- The `/sync` endpoint **keeps the legacy names** (`items`, `notes`, `item_add`, and so on), while REST uses `tasks` and `comments` ([migration guide, Object renames](https://developer.todoist.com/api/v1/#tag/Migrating-from-v9)).

### Response

- Top-level fields we care about: `sync_token`, `full_sync` (boolean, so **yes, there's a `full_sync` flag**), `full_sync_date_utc` (full syncs only), `items`, `projects`, `user`, `sync_status`, `temp_id_mapping`.
- Big accounts: full-sync data "may be returned with some delay". If `full_sync_date_utc` is far from now, run an incremental sync straight away (#tag/Sync/Overview/Incremental-sync).

### Item (task) object

Source: https://developer.todoist.com/api/v1/#tag/Sync/Tasks

| Field | Type and notes |
|---|---|
| `id` | String |
| `user_id` | String |
| `project_id` | String |
| `section_id` | String or null |
| `parent_id` | String, null for root tasks |
| `content` | String (markdown allowed) |
| `description` | String |
| `checked` | Boolean (completed) |
| `is_deleted` | Boolean |
| `completed_at` | String or null |
| `added_at` | String |
| `updated_at` | String |
| `priority` | 1 to 4, where **4 = very urgent** (shown as p1 in the UI) |
| `labels` | String[] |
| `due` | Object or null |
| `deadline` | Object or null |
| `duration` | `{amount, unit: minute or day}` or null |
| `child_order`, `order_key`, `day_order`, `is_collapsed`, `added_by_uid`, `assigned_by_uid`, `responsible_uid` | Ordering, display and assignment fields |

### `due` object

Source: https://developer.todoist.com/api/v1/#tag/Due-dates

- Fields: `date`, `timezone`, `string`, `lang`, `is_recurring`.
- **There is no separate `datetime` field in the documented due object.** `date` carries one of three formats:
  - Full day: `YYYY-MM-DD`, with `timezone: null`.
  - Floating time: `YYYY-MM-DDTHH:MM:SS` (no `Z`), with `timezone: null`.
  - Fixed timezone: `YYYY-MM-DDTHH:MM:SSZ` (UTC), with `timezone` set, for example `"Europe/Madrid"`.
- The SDK's `DueDateSchema` adds an optional, nullable `datetime` (SDK, `types/tasks/types.js`). **UNVERIFIED** whether the API ever populates it. Parse `date` and don't depend on `datetime`.

### Incremental sync semantics

- Documented: incremental sync returns "only the updated resource data".
- **UNVERIFIED:** whether deleted items come back with `is_deleted: true`, and whether completed items come back with `checked: true`. Neither the docs nor the spec states this explicitly. The fields exist and full sync returns only *active* data, so it's very likely, but it's not written down.
- Handle it defensively: treat `is_deleted` or `checked` as "remove from the active mirror", and treat an item that appears in a full sync as authoritative.

### Projects and Inbox

Sources: https://developer.todoist.com/api/v1/#tag/Sync/Projects and #tag/Sync/User

- Project fields: `id` (String), `name`, `is_deleted`, `is_archived`, `parent_id`, `color`, and so on.
- **Inbox:** `inbox_project: true` on the Inbox project. The docs say the property "is not sent" when it isn't true. The REST schema `PersonalProjectSyncView` marks it required boolean, so REST probably always sends it.
- `user.inbox_project_id` also gives the Inbox project id.

### Rate limits

Source: https://developer.todoist.com/api/v1/#tag/Request-limits

- Per user: **1000 partial (incremental) syncs per 15 minutes** and **100 full syncs per 15 minutes**.
- Up to **100 commands per request**, which counts as one request.
- 1 MiB POST body limit, 65 KiB total headers, 15-second processing timeout for standard requests.
- **UNVERIFIED:** limits for the REST endpoints. The Request limits section only gives sync numbers.

---

## 3. Commands via `/sync`

Sources: https://developer.todoist.com/api/v1/#tag/Sync/Overview (Write resources, Command UUID, Temporary resource ID, Response / Error) and #tag/Sync/Tasks

### Format

- Send `commands=[{type, uuid, args, temp_id?}]` (JSON array).
- `uuid`:
  - A client-generated unique id per command.
  - It's the key in `sync_status`, and it's also idempotency: "Todoist will not execute a command that has same UUID as a previously executed command". So a retry with the same uuid is safe.
  - **UNVERIFIED:** how long uuids are remembered.
- `temp_id`:
  - Only on create commands (`item_add`, `project_add`).
  - Later commands in the *same request* can reference it.
  - The response's `temp_id_mapping` maps `temp_id` to the real id.
  - This is different from the `tmp-` placeholder ids that first-party clients use (see the docs intro, "Resource IDs and optimistic updates").

### Response

- Shape:
  ```json
  {"sync_token": "...", "sync_status": {"<uuid>": "ok"}, "temp_id_mapping": {"<temp_id>": "<real id>"}}
  ```
- A failed command's value in `sync_status` is an error object:
  ```json
  {"error_tag": "INVALID_ARGUMENT_VALUE", "error_code": 20, "error": "Invalid argument value", "http_code": 400, "error_extra": {"argument": "...", "explanation": "..."}}
  ```
- Older examples show only `{error_code, error}`.
- `error_extra` may include `retry_after`, `event_id`, `argument`, `explanation`, `project_id`, `bad_item`, and others.
- The docs say: treat a per-command `http_code: 400` as terminal and don't retry (for example ITEM_NOT_FOUND). 403 and 409 may also be terminal.
- The per-command `http_code` can differ from what REST returns for the same error.

### Task commands

- `item_add`:
  - Required: `content`.
  - Optional: `description`, `project_id` (defaults to Inbox), `due`, `deadline`, `priority`, `parent_id`, `section_id`, `labels`, `child_order`, `order_key`, `day_order`, `responsible_uid`, `auto_reminder`, `auto_parse_labels`, `duration`.
- `item_update`:
  - Required: `id`.
  - Optional: `content`, `description`, `due`, `deadline`, `priority`, `labels`, `duration`, `order_key`, and so on.
  - **Can't move, re-parent, complete or uncomplete.**
- `item_move`: `id`, plus exactly one of `parent_id`, `section_id` or `project_id`.
- `item_delete`: `id`. Deletes the task **and all its sub-tasks**.
- `item_close`:
  - "Does exactly what official clients do".
  - Regular tasks are completed and archived. **Recurring tasks are rescheduled to their next occurrence**, so they stay active with a new `due`.
- `item_complete`:
  - Completes a task and its sub-tasks and moves them to the archive.
  - Optional `date_completed` (RFC3339 UTC) and `from_undo`.
  - A lower-level command. Use `item_close` for a "check it off" button.
- `item_update_date_complete`: the explicit recurring-completion command (`due`, `is_forward`, `reset_subtasks`).
- `item_uncomplete`: `id`. Restores the task; ancestor items and sections are reinstated and `checked` is reset.
- Deprecated: `item_reorder` and `item_update_day_orders`, both replaced by `order_key`.

### Setting due dates

Source: https://developer.todoist.com/api/v1/#tag/Due-dates

| What you want | What to send |
|---|---|
| Natural language | `due: {"string": "tomorrow at 10:00"}`. Optional `lang`. This is the only way to create a **recurring** date ("every day"). |
| Full day | `due: {"date": "2026-11-20"}` |
| Floating time | `due: {"date": "2026-11-20T10:00:00"}`, in the user's local time with no `Z` |
| Fixed timezone | `due: {"date": "2026-11-20T15:00:00Z"}` (UTC), optionally with `"timezone": "America/Los_Angeles"`. Or `{"string": "tomorrow at 12", "timezone": "Asia/Jakarta"}`. |
| No due date | `due: null` |

- "Unless specified explicitly, dates with time are created as floating."
- The docs show `due: null` for creating a task with no due date. **UNVERIFIED** (but strongly implied) that `item_update` with `due: null` clears an existing due date.

---

## 4. REST-style endpoints in v1

Source: the OpenAPI paths in https://developer.todoist.com/api/v1/ (tags Tasks and Projects) and #tag/Pagination

### Endpoints

All are under `https://api.todoist.com`.

- `POST /api/v1/tasks`: JSON body. Returns the task object (`ItemSyncView`).
  - Body fields: `content` (required), `description`, `project_id` (null means Inbox), `section_id`, `parent_id`, `order`, `labels`, `priority`, `assignee_id`, `due_string`, `due_date`, `due_datetime`, `due_lang`, `duration`, `duration_unit`, `deadline_date`.
- `GET /api/v1/tasks`: paginated.
  - Filters: `project_id`, `section_id`, `parent_id`, `label`, `ids` (comma-separated), `cursor`, `limit`.
  - Returns `{results: [...], next_cursor}`.
- `GET /api/v1/tasks/{task_id}`: "Returns a single active (non-completed) task".
- `POST /api/v1/tasks/{task_id}`: update. JSON body with the same `due_*` fields; omitted fields are left unchanged. Returns the task.
- `POST /api/v1/tasks/{task_id}/close`: same semantics as `item_close` (recurring tasks reschedule). Returns `200`; the response schema is empty.
- `POST /api/v1/tasks/{task_id}/reopen`: reopens the task and restores its ancestors. `200`.
- `DELETE /api/v1/tasks/{task_id}`: deletes the task and its subtasks. `200`. The spec says it "Returns `NOT_FOUND` when the task does not exist and `FORBIDDEN` when the authenticated user cannot modify the task."
- `POST /api/v1/tasks/{task_id}/move`, `GET /api/v1/tasks/filter`, and `POST /api/v1/tasks/quick` also exist.
- `GET /api/v1/projects`: paginated, optional `folder_id` and `workspace_id`. Each item has `inbox_project` (boolean).
- Completed tasks are available through `GET /api/v1/tasks/completed/by_completion_date` and `/by_due_date`.

### Pagination

- Cursor-based: `limit` defaults to 50 with a max of 200 (anything over 200 is a 400). Pass `cursor` = the previous `next_cursor`.
- Cursors are user-specific and parameter-specific, so don't persist them.
- Concurrent edits can cause duplicates or skipped items while you page.

### Response and body details

- Response body shapes for close, reopen and delete are unspecified (an empty schema, `{}`). **UNVERIFIED** what they actually return (empty body or `null`). Don't parse them.
- **UNVERIFIED:** how to clear a due date via REST `POST /tasks/{id}`. The schema types `due_string`, `due_date` and `due_datetime` as plain strings, not nullable, and doesn't document a way to clear them. (In the old REST v2, `due_string: "no date"` was the convention. That's from memory of REST v2, not verified for v1.) Use `item_update` with `due: null` instead.
- **Doc inconsistency:** the REST create and update bodies say "priority (1-4, where 1 is highest)". The task object (`ItemSyncView`) and the sync docs say 4 = urgent. I'd trust the task object (4 = urgent) and test it.
- **UNVERIFIED:** whether the server dedupes REST POSTs by `X-Request-Id`. The SDK sends that header (SDK, `transport/http-client.js`), but the v1 docs don't mention it. `/sync` `uuid` is the only documented idempotency mechanism.

### Already-deleted or missing tasks

- `GET` is documented as active tasks only.
- `DELETE` returns `NOT_FOUND` when the task "does not exist".
- **UNVERIFIED:**
  - whether an already-deleted task counts as "does not exist" (so 404) or is idempotent 200;
  - what `GET` returns for a completed task (probably 404);
  - what `close` returns for an already-closed task.

### Error format

Source: [migration guide, "Previous REST API endpoints error responses"](https://developer.todoist.com/api/v1/#tag/Migrating-from-v9)

- All v1 endpoints return JSON errors:
  ```json
  {"error": "Task not found", "error_code": 478, "error_extra": {"event_id": "<hash>", "retry_after": 3}, "error_tag": "NOT_FOUND", "http_code": 404}
  ```
- Status codes listed (#tag/Sync/Overview/Response-status-codes): 200, 400, 401, 403, 404, 429, 500, 503.
- 401 is `UNAUTHORIZED`, `error_code` 477, with `WWW-Authenticate` and `Retry-After` headers (Authorization docs). LIVE: an unauthenticated `GET /api/v1/tasks` returned exactly this shape with `retry_after: 4`.
- `retry_after` in `error_extra` "may be returned on rate-limited requests and other API errors, not just 429".
- **UNVERIFIED:** that a 429 carries a `Retry-After` *header*. The docs only show the header on 401. Read both the header and `error_extra.retry_after`.

### Sync vs REST for writes

- **The docs don't recommend one over the other for writes.**
- What they do say: `/sync` "is used by our first-party clients", "some actions will only be available via `/sync`", and "the format is unconventional" (#section/Developing-with-Todoist/Our-API).
- Points in favor of sync for our case:
  - documented per-command idempotency (`uuid`);
  - batching up to 100 commands for one rate-limit unit;
  - `due: null` to clear a date;
  - the response returns a fresh `sync_token`.
- Points in favor of REST: it returns the full task object on create and update.

---

## 5. Webhooks

Source: https://developer.todoist.com/api/v1/#tag/Webhooks

### Configuration

- Configured per app in the App Management Console (https://app.todoist.com/app/settings/integrations/app-management): callback URL, events, and webhook version.
- The SDK also has an app-management client that calls an undocumented `POST/GET /apps/<id>/webhook` with wire names like `e_item_added` (SDK, `types/apps/types.js`, `clients/app-client.js`). It isn't in the public spec. Ignore it.
- URL rules: **HTTPS only, and no port in the URL.** `https://host:5980` is rejected, so the endpoint must be on 443.

### Events

- `item:added`, `item:updated`, `item:deleted`, `item:completed`, `item:uncompleted`
- `note:*`, `project:added/updated/deleted/archived/unarchived`, `section:*`, `label:*`, `filter:*`, `reminder:fired`
- The SDK's list matches.

### Payload

```json
{"event_name": "item:added", "user_id": "2671355", "event_data": { ...task object... },
 "initiator": {"id": "2671355", "email": "...", "full_name": "...", "image_id": "...", "is_premium": true},
 "triggered_at": "2025-02-10T10:39:38.000000Z", "version": "10", "event_data_extra": { ... }}
```

- **`user_id` (String) is "the ID of the user that is the destination for the event".** Use it to map the event to a local user.
- `initiator` is whoever caused the event. It may be a collaborator from a shared project, not the destination user.
- `event_data_extra` on `item:updated` includes `old_item` and `update_intent`, which is one of `item_updated`, `item_completed` or `item_uncompleted`. The docs say this lets you tell apart a user postponing a task from "item updates that are task completions (initiated by completing a recurring task)".
  - So **completing a recurring task appears as `item:updated` with `update_intent: item_completed`.**
  - **UNVERIFIED:** whether `item:completed` also fires in that case.
- Version discrepancy: the docs example shows `"version": "10"`, but the SDK's `WEBHOOK_VERSIONS = ['1']`, with a comment saying "v9 is deprecated and intentionally excluded". **UNVERIFIED** which string the console offers and sends today. Don't hard-validate it.
- **UNVERIFIED:** for a task in a shared project, whether each collaborator who authorized the app gets a separate delivery (one per destination `user_id`). The `user_id` / `initiator` split suggests yes.

### Headers and signature

- `User-Agent: Todoist-Webhooks`.
- `X-Todoist-Hmac-SHA256`: HMAC-SHA256 with the app's **`client_secret`** as key over "the whole request payload". The result is **base64**, for example `UEEq9si3Vf9yRSrLthbpazbb69kP9+CZQ7fXmVyjhPs=`.
  - The SDK's `verifyWebhookSignature({rawBody, signature, clientSecret})` base64-decodes the header and runs `crypto.subtle.verify('HMAC', ...)` over the raw body bytes (SDK, `utils/webhook-parser.js`). That's constant-time, and it works on the raw body, not re-serialized JSON.
- `X-Todoist-Delivery-ID`: unique per notification and **reused on redelivery**. Use it for dedupe.

### Retries

- A failed delivery is retried after 15 minutes, at most 3 times.
- **The endpoint must respond with HTTP 200.** "A response other than HTTP 200 will be considered as a failed delivery". That reads as 200 exactly, not any 2xx. Don't return 204.
- Webhooks "could arrive delayed, out of order, or could even fail to arrive at all". Use them only as notifications, not as a data source.

### Activation

- "Once you have a webhook setup, you will start receiving webhook events from **all your app users** immediately."
- "The webhook for a specific user is activated when that user completes the OAuth flow of the app that declares the webhook."
- "**Todoist webhooks don't fire by default for the user that has created the Todoist app**". The owner has to go through the app's OAuth flow to get them.
- Implication: tokens not obtained via this app's OAuth (personal API tokens) don't activate webhooks. That's inferred from the activation rule; the docs don't spell out "personal tokens".
- There's no documented per-user toggle beyond completing OAuth. There's no documented "app must be published or activated" requirement either. (The SDK's `APP_STATUSES = ['public']` concerns the app's own status, not webhook activation.)

---

## 6. IDs and the user

- Getting the authenticated user's id:
  - Sync: `resource_types=["user"]` returns `user.id` (String), `user.email`, `user.inbox_project_id`, `user.tz_info`, and so on (#tag/Sync/User).
  - REST: `GET https://api.todoist.com/api/v1/user` (the OIDC userinfo endpoint; needs `user:read`, implied by `data:read`). Returns `UserJSON` with `id` (String), `email`, `full_name`, `is_premium`, and so on.
- **IDs are strings everywhere in v1.** The migration guide says IDs are now "non-number opaque strings", and the old numeric ids are rejected for tasks, projects, sections, comments and reminders.
  - User ids still *look* numeric (for example `"2671355"`) but are typed String. Store every id as TEXT.
  - `GET /api/v1/id_mappings/{obj_name}/{obj_ids}` translates old ids to new ones (up to 100 at a time).
  - Source: https://developer.todoist.com/api/v1/#tag/Migrating-from-v9 (IDs)
- Task URLs look like `https://app.todoist.com/app/task/<id>`.

---

## 7. Recent changes and deprecations

**Sync v9 and REST v2 are shut down.**

- Doist's API group announcement, posted 2025-12-03, scheduled brownouts and then "shutting down the previous APIs on February 10, 2026": https://groups.google.com/a/doist.com/g/todoist-api/c/brwENjfT_tk
  - It lists the brownouts as "Monday" Jan 7, Jan 21 and Feb 4, 2026, at 10:00 and 18:00 UTC. As quoted, those dates don't fall on Mondays, so treat the day names as a typo in the post or in my fetch.
- LIVE: `https://api.todoist.com/rest/v2/tasks` and `https://api.todoist.com/sync/v9/sync` both return **410 Gone** with "This endpoint is deprecated." today.

**v1 changes vs v9/v2** (https://developer.todoist.com/api/v1/#tag/Migrating-from-v9)

- Lowercase-only paths; mixed case returns 404.
- `api.todoist.com` is the only supported subdomain.
- Opaque string IDs.
- JSON errors on the formerly plain-text REST endpoints.
- Pagination added.
- `/sync` is POST-only, adds `full_sync_date_utc`, and drops `day_orders_timestamp`.
- `comment_count` removed.
- Webhooks inherit the new formatting; you switch the webhook version in the console.

**Newer v1 additions worth knowing**

- Refresh tokens are on by default for new apps (1-hour access tokens, rotation, replay revocation).
- RFC 7009 `/api/v1/revoke`, Dynamic Client Registration, Client ID Metadata Documents, PKCE (S256).
- In-v1 deprecations: `item_reorder`, `item_update_day_orders` and the `day_orders` response field, all replaced by `order_key` / `user_item_orders`.
- The SDK moved packages twice in 2026, to `@todoist/sdk` (see the top of this file).

---

## Implications for the design

1. **Incremental `/sync` with a stored token: OK.**
   - Store `sync_token` per user and use `resource_types=["items","projects","user"]`.
   - Budget: 1000 incremental and 100 full syncs per user per 15 minutes.
   - Handle `full_sync: true` (replace the mirror) and check `full_sync_date_utc`.
   - Deleted and completed items appearing in incremental results is **UNVERIFIED**. Code it defensively: drop an item from the active mirror if `is_deleted` or `checked` is true, and allow a periodic full resync.
   - Project names come from `projects` (watch `is_deleted` and `is_archived`). The Inbox is `inbox_project: true` or `user.inbox_project_id`.
2. **Webhooks that trigger a sync: OK, with conditions.**
   - The endpoint must be public HTTPS on 443 with no port in the URL.
   - Return exactly 200.
   - Verify base64 HMAC-SHA256 over the raw body with `client_secret`.
   - Dedupe on `X-Todoist-Delivery-ID`.
   - Map to a local user by `user_id`, not `initiator`.
   - Recurring completions arrive as `item:updated`.
   - Since delivery isn't guaranteed (at most 3 retries 15 minutes apart), **keep a polling fallback**.
   - **Alex's own account won't get webhooks unless it links through the app's OAuth flow.** The dashboard's normal link flow does that, but don't test with a personal API token.
3. **Writes to Todoist first, then update the mirror from the response: OK, with a nuance.**
   - Sync commands return only `sync_status` and `temp_id_mapping` (plus a new `sync_token`), not the task object.
   - Either include `resource_types` in the same request, or run an incremental sync right after, to get the canonical item.
   - REST create and update do return the task object.
   - For idempotent retries, use `/sync` with a stable `uuid`.
   - Use `item_close` for check-off: recurring tasks stay active with a new `due`, so don't remove them locally.
   - Clear a due date with `item_update` and `due: null`.
4. **Scopes `data:read_write,data:delete`: OK.**
   - Read/write includes read.
   - Deleting tasks is covered by `data:delete` (the per-endpoint requirement is UNVERIFIED).
   - `GET /api/v1/user` works under `data:read`, which `data:read_write` includes.
   - Don't request `project:delete` unless the dashboard deletes projects.
5. **Revoke on unlink: OK, but update for refresh tokens.**
   - Use `POST /api/v1/revoke` with Basic auth (`client_id:client_secret`) and `token`. Avoid `DELETE /api/v1/access_tokens`, which puts the secret in the query string.
   - Whether this kills the refresh token too is **UNVERIFIED**. Delete the stored refresh token locally regardless.
   - Verify the encoding (form vs JSON) once against a test token.
6. **Not in the current design: token refresh.** This is the biggest change from the assumptions.
   - A new app gets **1-hour access tokens and rotating refresh tokens**. The design needs a refresh path triggered by 401 `UNAUTHORIZED` / `invalid_token`.
   - Refresh must be **single-flight per user**. A second concurrent refresh more than 60 seconds later triggers replay detection, which revokes every token for that user.
   - Persist the new refresh token atomically.
   - Never overwrite a stored refresh token with a missing one: a grace-window retry returns no `refresh_token`.
7. **Use PKCE (S256)** on the authorize and token calls as defense in depth, plus `state`. Discovery advertises S256. **UNVERIFIED** that a confidential console app accepts it; test it during development.
8. **Register the exact callback URL** in the console and always send `redirect_uri`. Exact-match behavior is UNVERIFIED, so don't rely on prefix matching.
9. **Store every Todoist id as TEXT.** That includes user ids, which look numeric but are typed String.
10. **Don't build on REST v2 or Sync v9 examples.** Both return 410. Watch for v2-isms: `due.datetime`, `/rest/v2/*`, numeric ids, and the `items/*` REST names.

---

## UNVERIFIED items (consolidated)

- Whether `data:delete` is enforced per endpoint or command for task deletion. The scope description implies it.
- Whether PKCE works or is enforced for confidential, console-registered apps. Discovery advertises S256; the docs only describe it for public clients.
- Whether redirect URIs must match exactly.
- Whether `/api/v1/revoke` requires form-encoded or JSON. The docs prose, the OpenAPI spec and the SDK disagree.
- Whether revoking an access token also revokes the refresh token.
- Whether incremental sync returns deleted items with `is_deleted: true` and completed items with `checked: true`.
- Whether the due object ever includes `datetime`. The SDK models it as optional; the docs omit it.
- Whether `item_update` with `due: null` clears a due date. Strongly implied but not stated.
- How to clear a due date via REST `POST /tasks/{id}`. `due_string: "no date"` is a REST v2 convention from memory.
- REST priority direction: the request body says "1 is highest", while the task object says 4 = urgent.
- REST rate limits. Only sync limits are documented.
- Whether 429 responses include a `Retry-After` header.
- The response bodies of REST `close`, `reopen` and `delete`.
- What REST returns for an already-deleted task (404 vs 200), for `GET` on a completed task, and for `close` on an already-closed task.
- Whether `X-Request-Id` gives REST idempotency, and how long sync `uuid` idempotency lasts.
- Whether `item:completed` also fires for recurring completions, alongside `item:updated` with `update_intent`.
- The webhook `version` value ("10" in the docs vs "1" in the SDK).
- Whether shared-project events are delivered once per authorized collaborator.
- That personal API tokens never activate webhooks. Inferred from "activated when that user completes the OAuth flow".
- Whether a token revocation stops webhook delivery for that user.
- The exact days of the week for the 2026 brownouts. The dates don't match "Monday" as quoted.

## Verified live (2026-11-16)

Checked against the real API (`POST https://api.todoist.com/api/v1/sync`) with the app owner's test token. The probe created two clearly labeled tasks in Inbox, exercised them, and deleted them. These results override the UNVERIFIED notes above.

- **Request body:** both a JSON body and a form-encoded body work. Use JSON, as the official SDK does.
- **IDs:** item, project, and user ids are opaque strings, like `6j2qXvH9v8wQ2gQr`. An id that isn't in that format is rejected with `INVALID_ARGUMENT_VALUE` (error_code 20). So never synthesize ids like `0000`.
- **Commands and an incremental sync in one request work.** The response includes `sync_status`, `temp_id_mapping`, and the changed `items`, including the item just written. So the mirror can be updated from the same response.
- **Completing:** `item_close` on a normal task gives `checked: true`, with `completed_at` as an ISO UTC string with microseconds. `item_uncomplete` gives `checked: false` and `completed_at: null`.
- **Repeating a command:**
  - Resending the same command `uuid` returns `"ok"` and changes nothing. That's what makes retries safe.
  - `item_close` on a task that's already closed, with a new uuid, also returns `"ok"`, and the item comes back unchanged. That means "already in that state" has to be detected from the mirror.
- **Repeating tasks:** `item_close` on a repeating task (`due.is_recurring: true`) leaves `checked: false` and `completed_at: null`, and moves `due.date` forward (2026-11-16 to 2026-11-17).
- **Deleting:** `item_delete` gives `is_deleted: true` in the incremental items. **A deleted item's fields are blanked:** `content: ""`, `description: ""`, `due: null`, and `project_id: "2222222222222222"`, a placeholder. Never overwrite the mirror's last known fields from a deleted item; just mark the row deleted.
- **Errors on a command:** a command against a deleted item returns HTTP 200, with the per-command `sync_status[uuid]` set to `{"error":"Item not found","error_code":22,"error_tag":"ITEM_NOT_FOUND","http_code":400,"error_extra":{}}`.
- **Bad tokens:** a bad token returns **HTTP 401** with `{"error":"Invalid token","error_code":401,"error_tag":"AUTH_INVALID_TOKEN","http_code":401,"error_extra":{"access_type":"access_token","retry_after":4,...}}`. Error bodies carry `error_extra.retry_after`, in seconds.
- **No rate-limit or Retry-After headers** on successful sync responses.
- **Due dates:**
  - A date only is `{"date":"2026-12-02","timezone":null,"is_recurring":false,"string":"2026-12-02","lang":"en"}`.
  - A floating time is `"date":"2026-12-01T09:30:00"` with `timezone: null`.
  - A fixed time is `"date":"2026-12-01T17:30:00Z"` with `"timezone":"America/Los_Angeles"`.
  - There's no `datetime` field.
  - `item_update` with `due: null` clears the due date.
- **The `user` resource** has a string `id`, `inbox_project_id`, and `tz_info.timezone` (for example `US/Pacific`). Projects carry `inbox_project: true` on the Inbox and `is_deleted` and `is_archived` flags.
- **REST:** `GET /api/v1/tasks/{bad-id}` returns 400 `INVALID_ARGUMENT_VALUE`. A well-formed but missing id wasn't tested.

### Telling completed from deleted (live, 2026-11-16)

- A **full sync (`sync_token: '*'`) leaves out completed tasks.** A row missing from a full sync can be either completed or deleted.
- `GET /api/v1/tasks/{id}`:
  - An open task returns 200 with `checked: false`.
  - A **completed task returns 200 with `checked: true`** and `completed_at`.
  - A **deleted task returns 404** with `{"error":"Task not found","error_code":478,"error_tag":"NOT_FOUND","http_code":404}`.
  - That's the way to confirm a row that's missing from a full sync.
- An incremental sync from an **older** stored sync token still works (`full_sync: false`). It reports the close (`checked: true`) and later the delete (`is_deleted: true`).
- `GET /api/v1/tasks/completed/by_completion_date?since=…&until=…&limit=…` returns `{items:[…]}` and includes the completed task.
- `GET /api/v1/items/get?item_id=…` returns 404 for a completed task. Don't use it.
- `GET /api/v1/tasks/{id}` with an id that isn't base32 returns 400 `INVALID_ARGUMENT_VALUE`, not 404.

### `GET /api/v1/tasks` (live, 2026-11-16)

Checked with the owner's test token, read only:
- `GET /api/v1/tasks?project_id=<id>&limit=N` returns `{ "results": [...], "next_cursor": "<string>" | null }`.
- Each result has the sync item fields, including `project_id`, `added_at`, `due`, `checked` and `content`.
- Every result belongs to the requested project.
- `cursor=<next_cursor>` returns the next page, with no overlap.
- `limit=201` is refused with HTTP 400, so the maximum is 200.
