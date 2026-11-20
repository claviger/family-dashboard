# Google Calendar API v3 and Google OAuth: verified reference notes

Researched 2026-11-16, for spec §9 (Calendar panel), §8 (integrations) and §17 (Google Cloud setup).

**How I checked things**

- I downloaded each official page and read the text myself rather than relying on summaries. The main sources are Google's Identity docs (developers.google.com/identity), the Calendar API reference and guides (developers.google.com/workspace/calendar), and Google Cloud's OAuth help center (support.google.com/cloud).
- LIVE: I fetched Google's OIDC discovery document myself (https://accounts.google.com/.well-known/openid-configuration). No account, no token.
- SRC: library claims come from the `google-auth-library` source on GitHub (main at commit `a95b827`, file `src/auth/oauth2client.ts`) and from the installed `openid-client` 6.9.0 and `oauth4webapi` 3.8.8 typings in this repo's `node_modules`.
- NPM: versions and sizes come from `npm view`, run 2026-11-16.
- RFC: where Google defers to a standard, I cite the RFC.
- **UNVERIFIED** means no official source I read states it. **INFERRED** means it follows from what the docs say but isn't stated outright.
- I made no live API calls against Calendar.

---

## 1. OAuth for the calendar link

### Endpoints and discovery

Sources: LIVE discovery doc; https://developers.google.com/identity/protocols/oauth2/web-server; https://developers.google.com/identity/openid-connect/openid-connect

| Key | Value (LIVE, from discovery) |
|---|---|
| `issuer` | `https://accounts.google.com` |
| `authorization_endpoint` | `https://accounts.google.com/o/oauth2/v2/auth` |
| `token_endpoint` | `https://oauth2.googleapis.com/token` |
| `revocation_endpoint` | `https://oauth2.googleapis.com/revoke` |
| `code_challenge_methods_supported` | `plain`, `S256` |
| `token_endpoint_auth_methods_supported` | `client_secret_post`, `client_secret_basic` |
| `grant_types_supported` | includes `authorization_code`, `refresh_token` |

- The web-server guide hardcodes the same authorize and token URLs.
- `openid-client`'s `discovery(new URL('https://accounts.google.com'), …)`, which `src/server/auth/google.ts` already uses, reads this document. So the calendar link can reuse the same discovered `Configuration`.

### `access_type=offline` and `prompt=consent`

Source: web-server guide, "Step 1" parameter table, "Step 5" and "Refreshing an access token"; OIDC doc, "Refresh tokens" and "Prompting re-consent"

- `access_type` accepts `online` (the default) or `offline`. Offline "instructs the Google authorization server to return a refresh token and an access token **the first time** that your application exchanges an authorization code for tokens."
- OIDC doc: "you can only obtain a refresh token the first time that you perform the code exchange flow."
- `prompt` is a space-delimited list of `none`, `consent` and `select_account`. Without it, "the user will be prompted only the first time your project requests access."
- With `prompt=consent`, "the consent screen is displayed every time your app requests authorization of scopes of access, even if all scopes were previously granted" (OIDC doc).
- **Is a refresh token re-issued on later consents?** Google says it directly only in a DPoP note: to get a new refresh token when you already have one, "the user must revoke the existing grant or you must use the `prompt=consent` parameter in the initial authorization request to ensure a new refresh token is issued." So `offline` plus `consent` yields a new refresh token on every link. (The rule is stated for DPoP-bound tokens; I'm INFERRING it holds generally, which matches the first-time-only rule.)
- **What happens to the old refresh token after a re-consent** isn't documented, apart from the 100-per-client limit below. **UNVERIFIED**.

### `include_granted_scopes`

Source: web-server guide, parameter table and "Incremental authorization"

- The parameter is optional. With `true`, "the new access token will also cover any scopes to which the user previously granted the application access."
- When you refresh a combined authorization, the access token "can be used for any of the `scope` values included in the response."
- When you revoke a combined authorization, "access to all of that authorization's scopes on behalf of the associated user are revoked simultaneously."
- For us, `true` would fold the admin's `openid email profile` sign-in grant into the calendar token. `false` keeps the token to the two calendar scopes.

### Granular consent (not asked, but it matters)

Source: web-server guide, `enable_granular_consent` row and "Step 6: Check which scopes users granted"

- Granular permissions are "always enabled" for OAuth clients created after 2019.
- "Your app must verify which scopes were actually granted." The admin can untick one of the two scopes on the consent screen.
- The token response's `scope` field lists what was actually granted.

### PKCE for web-server (confidential) clients

Sources: LIVE discovery; https://developers.google.com/identity/protocols/oauth2/native-app (§ "Create a code verifier and challenge", parameter table)

- Discovery advertises `S256`.
- The parameters `code_challenge` and `code_challenge_method` (`S256` or `plain`, default `plain`) are documented only in the installed-app guide. The web-server guide doesn't mention PKCE at all.
- The app's sign-in flow already sends PKCE with the web client (`src/server/auth/google.ts`).
- **UNVERIFIED** whether Google enforces the verifier for a confidential client. Sending it is harmless and matches spec §8.

### Refresh-token behavior

Sources: https://developers.google.com/identity/protocols/oauth2 § "Refresh token expiration"; web-server guide § "Refreshing an access token"; SRC `google-auth-library`

**Refresh request:** `POST https://oauth2.googleapis.com/token` with `client_id`, `client_secret` (marked "Optional"), `grant_type=refresh_token` and `refresh_token`.

**Rotation:**
- No doc says whether refresh tokens rotate. **UNVERIFIED**.
- Evidence they don't (INFERRED):
  - The documented refresh response sample has no `refresh_token`.
  - `google-auth-library`'s `refreshAccessTokenAsync()` overwrites the result with the old token: `tokens.refresh_token = this.credentials.refresh_token` (oauth2client.ts ~L878; also ~L1003).
- Code defensively: keep the stored token, and replace it only if a response ever includes a new one.

**Reasons a refresh token stops working.** The oauth2 overview lists these, quoted:
- "The user has revoked your app's access."
- "The refresh token has not been used for six months."
- "The user changed passwords and the refresh token contains Gmail scopes." Our scopes aren't Gmail scopes, so **a password change doesn't kill our token** (INFERRED from the wording).
- "The user account has exceeded a maximum number of granted (live) refresh tokens."
- Time-based access expired. This only applies if the user granted time-based access; the token response then carries `refresh_token_expires_in`.
- An admin set a requested service to Restricted (`admin_policy_enforced`). This applies to Workspace accounts.
- Session-control expiry. This applies only to GCP/Cloud Platform scopes.

**Testing publishing status:**
- An External project in "Testing" "is issued a refresh token expiring in 7 days," unless only name, email and profile scopes are requested.
- The help center adds: "Authorizations by a test user will expire seven days from the time of consent" (https://support.google.com/cloud/answer/15549945).

**Limit per client and user:**
- "There is currently a limit of 100 refresh tokens per Google Account per OAuth 2.0 client ID. If the limit is reached, creating a new refresh token automatically invalidates the oldest refresh token without warning."
- There's also a larger limit per account across all clients.

**Six months unused:** quoted above. The 5-minute background poll keeps the token in use.

**Token sizes:** refresh tokens up to 512 bytes, access tokens up to 2048 (oauth2 overview, "Token sizes").

### `invalid_grant` response shape

Sources: web-server guide § "Errors" (code exchange) and § "invalid_grant" (refresh); oauth2 overview § "session control"; RFC 6749 §5.2; SRC

- **Code exchange:** `invalid_grant` means "The supplied authorization code is invalid or in the wrong format."
- **Refresh:** "the token may have expired or has been invalidated. … Authenticate the user again." It also says "the user account may have been deleted or disabled."
- **JSON body:**
  - Google's docs don't print a full body.
  - RFC 6749 §5.2 defines `{"error": "...", "error_description": "...", "error_uri": "..."}` with HTTP 400 "(unless specified otherwise)".
  - Google documents an extra `error_subtype` field (for example `"invalid_rapt"` for session-control expiry).
  - `google-auth-library` reads `e.response.data.error_description` when it sees `invalid_grant` (oauth2client.ts ~L835), which shows Google sends `error_description` (SRC).
  - The exact description text (for example "Token has been expired or revoked.") is **UNVERIFIED**.
  - The 400 status is **UNVERIFIED** for Google specifically; the RFC requires it.
- **With `openid-client`:** errors surface as `ResponseBodyError` with `.error`, `.error_description`, `.status` and `.cause` (the parsed JSON) (oauth4webapi 3.8.8 `index.d.ts` L1449).

### Revocation endpoint

Source: web-server guide § "Token revocation" (HTTP/REST, Node.js and Ruby tabs)

- **Method:** `POST https://oauth2.googleapis.com/revoke` with `Content-Type: application/x-www-form-urlencoded`. The curl example puts `token` in the query string; the Node.js sample puts it in the body.
- **Which token:**
  - "The token can be an access token or a refresh token."
  - "If the token is an access token and it has a corresponding refresh token, the refresh token will also be revoked."
- **Responses:** 200 on success, and 400 "along with an error code" on failure. "it might take some time before the revocation has full effect."
- **Scope of revocation:** "Key Point: **Revocation removes all OAuth 2.0 scopes previously granted to a project, invalidating any issued access or refresh tokens for all clients registered under that project.**" See the implications at the end; this one bites.
- **Client authentication:** the docs send no client credentials. `openid-client`'s `tokenRevocation()` follows RFC 7009 and authenticates with `client_secret_post` by default (the `discovery()` typings: "Default is ClientSecretPost"). **UNVERIFIED** whether Google accepts or ignores the extra parameters. A plain `fetch` that matches the docs avoids the question.

### Verification, unverified-app screen, the 100-user cap

Sources: https://support.google.com/cloud/answer/7454865 (Unverified apps); https://support.google.com/cloud/answer/13464323 (When verification is not needed); https://support.google.com/cloud/answer/15549945 (publishing status and user cap); https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification; https://developers.google.com/workspace/guides/configure-oauth-consent § "Scope categories"

**Scope categories:**
- Scopes fall into three categories: non-sensitive, sensitive and restricted. Sensitive scopes need "additional app verification". Restricted scopes also need a security assessment.
- The Cloud console shows each scope's category.

**How our two scopes are classified:**
- `calendar.events`: Google gives "reading events stored in Google Calendar" as an example of a sensitive scope, so `calendar.events` is very likely sensitive (INFERRED). The per-scope classification isn't published on any page I read. **UNVERIFIED**; check the console when adding the scope.
- `calendar.calendarlist.readonly`: classification **UNVERIFIED**.
- Whether either scope is restricted: **UNVERIFIED**. Restricted examples given are Gmail and Drive.

**When the warning appears:**
- The "unverified app" screen shows before consent when the app requests sensitive or restricted scopes that haven't been verified.
- "Google will display an Unverified apps warning message if your project's OAuth clients request authorization of scopes considered sensitive or restricted before your project has completed verification." So sign-in alone (`openid email profile`) shows no warning.

**The personal-use exemption** (13464323): "If the app is for your personal use (fewer than 100 users), you and your limited number of users can continue using the app without going through verification (users will be allowed to click through 'unverified app' warning screens during sign-in)."

**The user cap** (15549945, 7454865):
- The cap is "100 new users in total, after the app presents the unverified app screen."
- It "limits the number of users that can grant permission to your app when requesting unapproved sensitive or restricted scopes."
- It "applies over the entire lifetime of the project, and it cannot be reset or changed."
- So only Google accounts that link the calendar count, not family members who only sign in (INFERRED from "when requesting unapproved sensitive … scopes").

**Exact warning-screen wording:** **UNVERIFIED**. The help pages describe when it appears, not its text.

---

## 2. Scopes

Source: https://developers.google.com/workspace/calendar/api/auth (Calendar API scopes table); method pages' "Authorization" sections

| Scope | Google's description | Relevant methods that accept it |
|---|---|---|
| `calendar.calendarlist.readonly` | "See the list of Google calendars you're subscribed to." | `calendarList.list` |
| `calendar.events` | "View and edit events on all your calendars." | `events.list`, `insert`, `patch`, `update`, `delete`, `instances` |
| `calendar.events.owned` | "See, create, change, and delete events on Google calendars you own." | `events.list`, `insert`, `patch`, `delete` |
| `calendar.events.owned.readonly` | "See the events on Google calendars you own." | `events.list` |
| `calendar.app.created` | "Make secondary Google calendars, and see, create, change, and delete events on them." | events methods |
| `calendar.calendars.readonly` | "See the title, description, default time zone, and other properties of Google calendars you have access to." | (`calendars.get`, not list) |

- **§19.3 is answered.** `https://www.googleapis.com/auth/calendar.calendarlist.readonly` exists, and the `calendarList.list` reference lists it among the accepted scopes. The fallback to `calendar.readonly` isn't needed.
- **No per-calendar scope exists.** The narrowest event scopes are:
  - `calendar.events.owned`, for calendars "you own".
  - `calendar.app.created`, only for calendars the app itself created, which doesn't fit an existing family calendar.
- **What "own" means for `.owned`:**
  - The docs distinguish the `owner` access role from the calendar's single "data owner" (calendarList `accessRole` description).
  - Which of the two `.owned` means isn't stated. **UNVERIFIED**.
  - A family calendar shared to the admin with "Make changes and manage sharing" (role `owner`) might not count as "owned" under `.owned`.
- **`.owned` is listed for `events.patch`, `events.delete` and `events.insert`.** I didn't read the `update` or `instances` authorization lists for `.owned`, so those are **UNVERIFIED**.
- **Recommendation:** `calendar.events` is the safe choice for a calendar the admin may not be the data owner of. Treat `calendar.events.owned` as an optional narrowing to test on the real calendar. Neither changes the verification story, as far as I can tell.
- **Newer recommended scopes:** the docs only say "choose the most narrowly focused scope possible." I found no newer recommendation beyond the `.owned` and `app.created` family.

---

## 3. `calendarList.list`

Sources: https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list; https://developers.google.com/workspace/calendar/api/v3/reference/calendarList (resource)

- **Request:** `GET https://www.googleapis.com/calendar/v3/users/me/calendarList`
- **Query parameters:**
  - `maxResults`: default 100, maximum 250.
  - `pageToken`.
  - `minAccessRole`: `freeBusyReader`, `reader`, `writerWithoutPrivateAccess`, `writer` or `owner`.
  - `showHidden`: default false.
  - `showDeleted`: default false.
- **Response:** `{ kind, etag, nextPageToken?, nextSyncToken?, items[] }`.
  - `nextPageToken` is "Omitted if no further results are available, in which case `nextSyncToken` is provided."
  - Loop until there's no `nextPageToken`.
- **Entry fields:**
  - `id`: "Identifier of the calendar."
  - `summary`: "Title of the calendar." Read-only.
  - `summaryOverride`: the user's own name for the calendar, if set. Show it in preference to `summary`.
  - `timeZone`: "The time zone of the calendar." Optional, read-only.
  - `primary`: boolean, default False.
  - `accessRole`: "The effective access role that the authenticated user has on the calendar." Values:
    - `freeBusyReader`
    - `reader`
    - **`writerWithoutPrivateAccess`**: read and write, but private event details are hidden and private events can't be modified.
    - `writer`
    - `owner`: everything `writer` can do, plus managing access levels. This is different from the calendar's single data owner; `dataOwner` holds the owner's email and is set only for secondary calendars.
  - `hidden`: returned only when true.
  - `deleted`.
- **Missing `minAccessRole` ordering:** the docs don't state that `minAccessRole=writer` excludes `writerWithoutPrivateAccess`. **UNVERIFIED**. Filter on `accessRole` in code.

---

## 4. `events.list`

Sources: https://developers.google.com/workspace/calendar/api/v3/reference/events/list; https://developers.google.com/workspace/calendar/api/v3/reference/events (resource); https://developers.google.com/workspace/calendar/api/concepts/events-calendars; https://developers.google.com/workspace/calendar/api/guides/recurringevents

### Request

`GET https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events`

**`timeMin` and `timeMax`:**
- `timeMax`: "Upper bound (exclusive) for an event's **start** time to filter by."
- `timeMin`: "Lower bound (exclusive) for an event's **end** time to filter by."
- So the semantics are **overlap**: events where `end > timeMin` and `start < timeMax`. An event ending exactly at `timeMin` is excluded, and so is one starting exactly at `timeMax`.
- Both bounds must be RFC 3339 with a mandatory offset. Milliseconds are ignored, and `timeMax` must be greater than `timeMin`.
- Discrepancy: `events.instances` documents its `timeMin` as "(inclusive)". Treat boundary-exact events as an edge case to test.

**`singleEvents`:**
- `true` expands recurring events "into instances and only return single one-off events and instances of recurring events, but not the underlying recurring events themselves." The default is False.
- Without it, a list returns "single events, recurring events, and exceptions" (recurring guide).

**`orderBy`:**
- `startTime` (ascending) "is only available when querying single events (i.e. the parameter `singleEvents` is True)".
- `updated` is the other option. The default is "an unspecified, stable order".

**`maxResults` and paging:**
- The default is 250 and the maximum is 2500.
- "The number of events in the resulting page may be less than this value, **or none at all**, even if there are more events matching … Incomplete pages can be detected by a non-empty `nextPageToken`." Always loop on `nextPageToken`.

**`timeZone`:** "Time zone used in the response." The default is the calendar's time zone.

**`showDeleted`:**
- The default is False.
- "Cancelled instances of recurring events (but not the underlying recurring event) will still be included if `showDeleted` and `singleEvents` are both False."
- With `singleEvents=true` and `showDeleted=false`, cancelled instances are excluded (INFERRED from that sentence plus the `status` description below).

**Other parameters:**
- `eventTypes` filters by `default`, `birthday`, `focusTime`, `fromGmail`, `outOfOffice` or `workingLocation`. Unset returns all types.
- `privateExtendedProperty=name=value` filters on private properties. The list reference says repeated values must "match all"; the extended-properties guide says they're "OR'ed". The docs contradict each other; we don't need the filter.

**Response:** `{ kind, etag, summary, timeZone, accessRole, updated, defaultReminders, nextPageToken?, nextSyncToken?, items[] }`. The response's `timeZone` is "The time zone of the calendar", so we can refresh the stored calendar time zone from each read without another scope.

### Event fields (from the Events resource)

**Identity and status:**
- `id`: "Opaque identifier." Instances of a recurring event each have their own `id`.
- `status`: one of these values:
  - `confirmed` (the default)
  - `tentative`
  - `cancelled`. A cancelled exception of a live series "should no longer be presented"; it's "only guaranteed to have values for the `id`, `recurringEventId` and `originalStartTime` fields". All other cancelled events are deletions.
  - The list method returns cancelled events only on incremental sync or with `showDeleted=true`.

**Start and end:**
- `start` is "(inclusive)" and `end` is "(exclusive)". For a recurring master, they describe the first instance.
- `start.date` / `end.date` ("yyyy-mm-dd") are used for all-day events, and `start.dateTime` / `end.dateTime` (RFC 3339) for timed events.
- A `dateTime` needs an offset "unless a time zone is explicitly specified in `timeZone`."
- "The start and end of the event must both be timed or both be all-day" (concepts page).
- **The all-day end date is exclusive.** A single all-day event on June 1 is `start.date=2015-06-01`, `end.date=2015-06-02` (concepts page example).
- `start.timeZone` / `end.timeZone` take an IANA name. For recurring events this field is required and is the zone the recurrence expands in. For single events it's an optional custom zone.

**Recurrence links:**
- `recurringEventId`: on an instance, "the `id` of the recurring event to which this instance belongs." Immutable.
- `originalStartTime` (`date`, or `dateTime` plus `timeZone`): the instance's start "according to the recurrence data" of the master, and it "uniquely identifies the instance … even if the instance was moved." Immutable.
- `recurrence[]`: "List of RRULE, EXRULE, RDATE and EXDATE lines … This field is omitted for single events or instances of recurring events." It appears only on the master.

**Change tracking:**
- `etag`: "ETag of the resource."
- `updated`: last modification of the main event data. "Updating event reminders will not cause this to change."
- `sequence`: iCalendar sequence number.

**Links and properties:**
- `htmlLink`: "An absolute link to this event in the Google Calendar Web UI." Read-only.
- `extendedProperties.private`: "Properties that are private to the copy of the event that appears on this calendar." A string-to-string map.

**People and type:**
- `creator`: read-only.
- `organizer`: read-only except on import. "To change the organizer, use the move operation."
- Also relevant:
  - `eventType` can't be changed after creation.
  - `locked` is a read-only copy where summary, description, location, start, end and recurrence can't change.
  - `endTimeUnspecified`.

---

## 5. Writes

Sources: reference pages for `events.insert`, `events.patch`, `events.update` and `events.delete` (…/v3/reference/events/{insert,patch,update,delete}); https://developers.google.com/workspace/calendar/api/guides/performance § "Patch (partial update)"; https://developers.google.com/workspace/calendar/api/guides/extended-properties; https://developers.google.com/workspace/calendar/api/guides/version-resources; https://developers.google.com/workspace/calendar/api/guides/errors

### `events.insert`

- **Request:** `POST …/calendars/{calendarId}/events`.
- **Required:** only `start` and `end`.
- **Extended properties:** set `extendedProperties.private` in the body: "like other fields can be set in insert, update, and patch requests" (extended-properties guide).
- **Limits** (same guide):
  - Keys can be up to 44 characters; longer keys are "silently dropped".
  - Values can be up to 1024 characters; longer values are "silently truncated".
  - An event can have at most 300 properties and 32 kB in total, across all copies.
- Private properties "are specific to the `calendarId` and `eventId` used in the request."
- **Client-supplied IDs:** you can supply `id` yourself (base32hex characters a-v and 0-9, 5 to 1024 characters). A duplicate returns 409 `duplicate`. This could make creates idempotent on retry (INFERRED).
- **No conditional insert:** "There is no support for conditional modifications for insert operations" (version-resources guide).

### `events.patch` vs `events.update`

**Patch:**
- The reference says: "This method supports patch semantics. Note that each patch request consumes three quota units; prefer using a `get` followed by an `update`. The field values you specify replace the existing values. **Fields that you don't specify in the request remain unchanged.** Array fields, if specified, overwrite the existing arrays."
- The performance guide (Calendar docs) adds: "The modified data you send is **merged into the data for the parent object**." So nested objects merge. Sending only `extendedProperties.private.dashboardUpdatedBy` keeps `dashboardCreatedBy`.
- The extended-properties guide confirms patch "allows you to manipulate some properties while leaving others untouched."
- **Clearing a field:**
  - "To delete a field, specify the field and set it to `null`."
  - A mutable object can be deleted with `null` too.
  - The guide's example also clears a string by setting it to `""`.
  - For extended properties: `{"extendedProperties":{"private":{"key":null}}}`.
  - An invalid result gives 400 or 422, "and the resource state remains unchanged."
- **Fields a patch leaves alone:**
  - `attendees` is an array, untouched when omitted.
  - `reminders` is an object, untouched when omitted.
  - `conferenceData`: `conferenceDataVersion` defaults to 0, which "assumes no conference data support and ignores conference data in the event's body".
  - All three are left alone if the patch body doesn't include them (INFERRED from the general rule, not tested).

**Update (PUT):**
- "does not support patch semantics and always updates the entire event resource."
- From the performance guide: with PUT, "it clears previously set data if you don't supply optional parameters."
- The errors guide adds that an `update` without shared properties "is equivalent to trying to set them to their default values. Consider using Events: patch instead."
- **For a dashboard that must not touch unmanaged fields, use patch.**

### `events.delete`

- **Request:** `DELETE …/calendars/{calendarId}/events/{eventId}`. It returns an empty body.
- **Parameters:** `sendUpdates` (`sendNotifications` is deprecated).
- **Already deleted:** "This error can also occur if a request attempts to delete an event that has already been deleted." That's a 410 with reason `deleted` (errors guide). Treat it as success.

### Etags and `If-Match` (important)

**What Google says in the Calendar docs:**
- version-resources guide, "Conditional modification": "If you want to **update or delete** a resource only if it has not changed since you last retrieved it, you can specify an `If-Match` header that contains the value of the etag from the previous retrieval. … If the entry (and its etag) has not changed since the last retrieval, the modification succeeds and the new version of the resource with the new etag is returned. **Otherwise, you will get a 412 (Precondition failed) response code.**"
- errors guide, "412: Precondition Failed": "The etag supplied in the If-match header no longer corresponds to the current etag of the resource." Body:
  ```json
  {"error":{"errors":[{"domain":"global","reason":"conditionNotMet","message":"Precondition Failed","locationType":"header","location":"If-Match"}],"code":412,"message":"Precondition Failed"}}
  ```
  The suggested action is "Re-fetch the entity and re-apply the changes."

**Coverage by method:**
- **Update:** explicit. The guide's Java sample is an `update` with `setIfMatch` that catches 412.
- **Delete:** explicit ("update or delete").
- **Patch:**
  - The `events.patch` reference doesn't mention etags.
  - The generic patch section of the Calendar performance guide shows `PATCH` with `If-Match: "ETagString"` and says ETag-using resources need "the current ETag value in the `If-Match` HTTP header."
  - I'm treating patch as covered by "modification". It's documented generally, but **not separately confirmed for `events.patch`**.
- `If-Match: *` forces the write (performance guide).
- `If-None-Match` gives 304 on reads.

**UNVERIFIED (test on first implementation):**
- That an instance's etag from a `singleEvents=true` list is accepted by `If-Match` on that instance's id.
- Whether the etag changes when only reminders change. `updated` doesn't change, per the resource doc.
- That etags come back as quoted strings to be sent back verbatim. I believe they do, but I didn't confirm it in a doc.

### `sendUpdates`

Accepted on insert, patch, update and delete:
- `all`
- `externalOnly`: "non-Google Calendar guests only"
- `none`

The insert page warns that `none` "can have significant adverse effects, including events not syncing to external calendars or events being lost altogether for some users."

The default value isn't clearly stated. The insert page says "The default is `false`", and the patch page gives none. **UNVERIFIED**. For dashboard events with no attendees it doesn't matter. For edits to events that do have guests, pick a value on purpose.

---

## 6. Recurring events

Sources: https://developers.google.com/workspace/calendar/api/guides/recurringevents; https://developers.google.com/workspace/calendar/api/concepts/events-calendars § "Recurring events"; https://developers.google.com/workspace/calendar/api/v3/reference/events/instances; Google Workspace Developers blog, "Calendar API v3 Best Practices: Recurring Events" (2011), https://gsuite-developers.googleblog.com/2011/12/calendar-v3-best-practices-recurring.html; RFC 5545 §3.3.10

### Editing "this event only"

- The official guide: "To modify a single instance (creating an exception), client applications must first retrieve the instance and then update it by sending an authorized PUT request to the instance edit URL": `…/calendars/{calendarId}/events/{instanceId}`.
- The instance `id` from `events.list?singleEvents=true` is that `instanceId`.
- An instance can also be found by its original time: `events.instances` with `originalStart=` "The original start time of the instance in the result."
- **The guide shows PUT, not PATCH, for instances.** PATCH on an instance id is **UNVERIFIED** but expected to work, since an instance is addressed like any event.
- The 2011 blog shows the instance id format `<masterId>_<UTC basic time>` (for example `7n6f…_20111212T090000Z`). Don't parse it; treat it as opaque.

### Deleting one instance

- **Documented:** the guide's example cancels an instance by PUT with `"status": "cancelled"` on the instance id.
- **Also stated:** the 2011 blog says that once you have the instance, "just update or delete the event as above". That suggests `DELETE` on the instance id works. This is an official Google blog, but old, and it isn't in the current reference. **UNVERIFIED** against the current API.

### Editing "all events"

- **INFERRED:** you patch the master. Its id is the instance's `recurringEventId`.
- The guide warns: "Do not modify instances individually when you want to modify the entire recurring event."
- The master's `start` and `end` are the **first** instance's times. To move every instance by the change the user made on one instance, apply the delta to the master's start and end; don't copy the instance's date (INFERRED from the resource docs).

### What happens to changed instances when the master's time changes

- **UNVERIFIED and conflicting.**
- The 2011 blog says exceptions' "changes are preserved even if the recurring event itself is updated".
- Community reports say exceptions disappear after a master time change. Those aren't official sources, and I'm not relying on them.
- Test this on a scratch calendar before relying on either.

### The RRULE format

- `recurrence` is a list of strings:
  - `RRULE:` lines
  - `EXDATE` lines
  - `RDATE` lines
  - `EXRULE` lines (listed in the resource doc)
- DTSTART and DTEND aren't allowed in `recurrence`.
- Components named in the concepts page:
  - `FREQ` (required)
  - `INTERVAL`
  - `COUNT` or `UNTIL` ("Don't use both in the same rule")
  - `BYDAY`, `BYMONTH`, `BYYEARDAY`, `BYHOUR`
- `UNTIL` is inclusive.
- "`EXDATE` and `RDATE` can have a time zone, and must be dates (not date-times) for all-day events." EXDATE "must point to a valid instance generated by the recurrence rule."
- Google's examples:
  - Timed: `RRULE:FREQ=WEEKLY;UNTIL=20110701T170000Z`, with a `start.timeZone`.
  - All-day: `"EXDATE;VALUE=DATE:20150610"`, `"RDATE;VALUE=DATE:20150609,20150611"`, `"RRULE:FREQ=DAILY;UNTIL=20150628;INTERVAL=3"`.

**Does UNTIL have to be UTC?** RFC 5545 §3.3.10:
- "The value of the UNTIL rule part MUST have the same value type as the 'DTSTART' property."
- "If the 'DTSTART' property is specified as a date with UTC time or a date with local time and time zone reference, then the UNTIL rule part MUST be specified as a date with UTC time."
- So **all-day events use `UNTIL=YYYYMMDD`**, and **timed events (which always carry a time zone in Google) use `UNTIL=YYYYMMDDTHHMMSSZ`**.
- Google's own examples follow this. Whether Google tolerates a floating local UNTIL on a timed event is **UNVERIFIED**; don't emit one.

---

## 7. Time zones

Source: https://developers.google.com/workspace/calendar/api/concepts/events-calendars § "Time zones"; Events resource field descriptions

**The calendar's time zone:**
- "Results of the `get()`, `list()`, and `instances()` methods are returned in the time zone that you specify in the `timeZone` parameter. If you omit this parameter, then these methods all use the calendar time zone as the default."
- "**The calendar time zone is used to calculate start and end times of all-day events** to determine whether they fall within the filter specification." The request's `timeZone` parameter doesn't change this.

**The event's time zone (`start.timeZone`):**
- Three forms are equivalent: an offset in `dateTime`; no offset and no `timeZone` ("implicitly uses the default time zone"); or no offset plus `timeZone`.
- "setting the `timeZone` field attaches a time zone to the event."
- Single events can have different start and end zones. "For recurring events, you must always specify a single time zone to expand the recurrences."
- The resource doc says the offset is "required unless a time zone is explicitly specified in `timeZone`". That conflicts with the concepts page's "implicitly uses the default". Always send either an offset or a `timeZone`; I'd send both.

**Floating times:**
- The docs don't describe floating, zone-less timed events. Every timed value resolves to an offset, a `timeZone` or the calendar default.
- **UNVERIFIED** whether events imported from iCal with floating times come back in any special form. INFERRED: they'd show up with an offset in the response zone.

**All-day events:**
- "the timezone field has no significance for all-day events."
- They're plain dates with an exclusive `end.date`.
- Their placement relative to a timed query window is computed in the **calendar's** time zone, per the quote above.

---

## 8. Errors and quotas

Sources: https://developers.google.com/workspace/calendar/api/guides/errors; https://developers.google.com/workspace/calendar/api/guides/quota

### Error shape

Every example in the errors guide uses this shape:
```json
{"error":{"errors":[{"domain":"...","reason":"...","message":"...","locationType":"...","location":"..."}],"code":NNN,"message":"..."}}
```
Newer Google APIs also send `error.status` and `error.details`. **UNVERIFIED** for Calendar; parse `errors[0].reason` defensively and fall back to the HTTP status.

| Status | `reason` (domain) | Meaning per guide | Suggested action |
|---|---|---|---|
| 400 | e.g. `timeRangeEmpty` (calendar) | Bad or missing field or parameter | Don't retry |
| 401 | `authError` (global), "Invalid Credentials", location `Authorization` | "The access token you're using is either expired or invalid." | Refresh; if that fails, re-run OAuth |
| 403 | `userRateLimitExceeded` (usageLimits) | A Developer Console limit was reached | Backoff |
| 403 or 429 | `rateLimitExceeded` (usageLimits) | "maximum request rate per calendar or per authenticated user" | "can return either 403 or 429 … respond … the same way, by using exponential backoff" |
| 403 | `quotaExceeded` (usageLimits), "Calendar usage limits exceeded." | Anti-abuse Calendar usage limits | See the Workspace admin help |
| 403 | `forbiddenForNonOrganizer` (calendar) | A shared property was set on a non-organizer copy | Use patch |
| 404 | `notFound` (global) | The ID never existed, or the calendar isn't accessible | The guide says to "Use exponential backoff" |
| 409 | `duplicate` | A client-supplied id already exists | |
| 410 | `fullSyncRequired` / `updatedMinTooLongAgo` (calendar), or `deleted` (global) "Resource has been deleted" | Sync token is stale, or the event was already deleted | "For already deleted events, no further action is necessary." |
| 412 | `conditionNotMet` (global), location `If-Match` | Stale etag | Re-fetch and re-apply |
| 500 | `backendError` | | Backoff |

- **A plain 403 `forbidden`, or a missing-scope 403, isn't documented** in the Calendar errors guide. **UNVERIFIED**. From memory, Google returns `insufficientPermissions` for a missing scope and `requiredAccessLevel` for a lack of write access; I haven't confirmed either. Treat an unexpected 403 that isn't a rate limit as `error`, or as `needs_reconnect` if the granted scopes look wrong.

### Backoff

From the quota guide:
- Use "truncated exponential backoff": wait `min(2^n + random_ms, maximum_backoff)`, where `random_ms` ≤ 1000 and `maximum_backoff` is "typically 32 or 64 seconds".
- After that, keep retrying at the cap, but stop at some point.
- "If you need to perform an operation on a regular basis, vary the interval +/- 25%."

### Quotas

Quota guide. It notes the limits changed **2026-05-01**; projects created on or after that date get the new limits:
- 10,000 requests per minute per project.
- 600 requests per minute per user per project.
- Daily billing threshold: 1,000,000 requests per day per project before charges apply. "Full billing details will be shared later in 2026."
- Quotas use a sliding per-minute window.
- `events.patch` "consumes three quota units" (patch reference).

---

## 9. Library choice

Sources: NPM `npm view` on 2026-11-16; SRC `google-auth-library` oauth2client.ts; SRC `openid-client` 6.9.0 `build/index.d.ts`

| Package | Latest | `dist.unpackedSize` | Runtime deps |
|---|---|---|---|
| `googleapis` | 190.0.0 | 246,467,646 B (~235 MB) | `googleapis-common`, `google-auth-library` |
| `@googleapis/calendar` | 20.2.0 | 845,986 B | `googleapis-common` |
| `googleapis-common` | 9.3.1 | 117,463 B | `gaxios`, `google-auth-library`, `qs`, `url-template`, `extend`, `google-logging-utils` |
| `google-auth-library` | 11.3.4 | 785,192 B | `gaxios`, `gcp-metadata`, `jws`, … |
| `openid-client` (already used) | 6.9.0 | 230,582 B | `jose`, `oauth4webapi` |

**Transitive size estimate:**
- I walked npm metadata to estimate the full tree. These are rough figures, and **I didn't install anything**.
- `google-auth-library`'s tree is about 9 MB across 23 packages. Most of that is `web-streams-polyfill`, pulled in through `node-fetch`.
- `openid-client`'s tree is about 0.78 MB across 3 packages.
- So `@googleapis/calendar` comes to roughly 10 MB once installed. My walk failed partway for that package, so its total is extrapolated from the components above.

**Can `openid-client` 6 do the code-plus-refresh flow, so we skip `google-auth-library`?** Yes, judging from its typings:
- `buildAuthorizationUrl(config, Record<string,string>)` passes any parameters through, so `access_type=offline`, `prompt=consent`, `include_granted_scopes` and the PKCE parameters all work.
- `authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier, expectedState }, { redirect_uri })` returns a `TokenEndpointResponse` that includes an optional `refresh_token`.
  - Without `openid` in the scope, no ID token comes back, and `expectedNonce` is optional.
  - If we also request `openid email` to record which Google account linked the calendar, pass `expectedNonce` and read `claims()`.
- `refreshTokenGrant(config, refreshToken)` POSTs to the discovered `token_endpoint`, using `client_secret_post` by default.
- `tokenRevocation(config, token)` exists. See the client-auth caveat in §1.
- Errors arrive as `ResponseBodyError` (`.error === 'invalid_grant'`).
- I haven't run any of this against Google for the calendar scopes. The existing sign-in already exercises discovery and the code grant with PKCE on the same client.

**Recommendation: plain `fetch` against REST, with `openid-client` for OAuth.** My reasons:
- We call about six endpoints (`calendarList.list`, and `events.list`, `get`, `insert`, `patch` and `delete`). `If-Match` is just a header, and the error shape is simple JSON.
- `@googleapis/calendar` would bring in `google-auth-library` and `gaxios`. That means a second OAuth stack with its own token lifecycle beside `openid-client`, and roughly 10 MB of dependencies.
- `googleapis` itself is about 235 MB.
- The spec already wants single-flight refresh, `needs_reconnect` handling and encrypted storage (§8). Those are easier to own in one place.

**Costs of going without a library:**
- We write the Event and CalendarListEntry types ourselves. Zod is already a dependency, so we can validate at the boundary.
- We implement backoff on 403/429 `rateLimitExceeded` and on 5xx.
- We handle `nextPageToken` loops.
- The trade is worth it at this size.

---

## 10. Push notifications (`events.watch`), and whether polling is fine

Sources: https://developers.google.com/workspace/calendar/api/guides/push; https://developers.google.com/workspace/calendar/api/guides/quota § "Use push notifications"

**Push:**
- The callback must be HTTPS, with a valid certificate (self-signed, untrusted, revoked or mismatched certificates are rejected).
- Channels have an `expiration`, set by the request or by internal limits, "the more restrictive value is used".
- "there's no automatic way to renew a notification channel."
- **The current Calendar push guide says nothing about domain verification.** The brief's "verified HTTPS domain" is **UNVERIFIED** against current docs.
- Maximum channel lifetime: **UNVERIFIED** (not stated).

**Polling:**
- The quota guide calls polling an anti-pattern at scale. Its example is 5,000 users polled every minute.
- One calendar polled every 5 minutes is 288 `events.list` calls a day for the summary window (more if a page overflows).
- Drill-down reads and writes add a handful more, against 600 per minute per user and 1,000,000 per day per project.
- **That's fine.** Add the documented ±25% jitter to the 5-minute job.

---

## Implications for the design (checked against spec §9, §8, §17, §19)

**Confirmed as written:**
- **§19.3:** `calendar.calendarlist.readonly` exists and is accepted by `calendarList.list`. Mark it verified. The `calendar.readonly` fallback is unnecessary.
- **§9.1 `access_type=offline` + `prompt=consent`:** correct. That's how you get a fresh refresh token on every link or re-link (§1).
- **§9.2 windowed reads with `singleEvents=true&orderBy=startTime`:** valid. `orderBy=startTime` requires `singleEvents=true`.
  - Semantics are overlap (`end > timeMin`, `start < timeMax`).
  - Paginate on `nextPageToken` even for small windows, because pages can be short or empty.
  - Cancelled instances are omitted with the default `showDeleted=false`.
- **§9.2 5-minute cache and polling:** well inside quota. Add ±25% jitter, as the quota guide recommends for regular operations.
- **§9.4 "edits leave unmanaged fields untouched":** achievable only with **`events.patch`**, never `update`.
  - Omitted `attendees`, `reminders` and `conferenceData` stay as they are.
  - Clear location or description with `null` (or `""`).
  - Patch costs 3 quota units, which is irrelevant at this volume.
- **§9.5 private extended properties:**
  - Patch merges nested objects, so writing `dashboardUpdatedBy` keeps `dashboardCreatedBy`.
  - Both names are under the 44-character key limit, and the user IDs are well under 1024 characters.
  - Security note: private properties are per calendar, not per app, so any writer of the calendar using the API can set or spoof them (INFERRED). Treat attribution as informational, not as an audit record.
- **§9.6 `If-Match` and 412:**
  - Documented for update and delete, with the exact 412 `conditionNotMet` body (§5).
  - Patch is covered by the generic patch guide in Calendar's docs, but not stated on the `events.patch` page.
  - Test once early: patch an instance with a stale etag and expect 412.
- **§17 Testing mode, 7-day expiry:** confirmed. Publishing as "In production" while staying unverified is allowed under the personal-use exemption.
  - Refinement: the 100-user cap counts only accounts that grant the unverified sensitive scopes (the calendar link), applies over the project's lifetime, and can't be reset. So the spec is right, and the cap is even less of a concern than stated.

**Contradictions and gaps to fix in the spec:**
1. **Revocation hits every grant for the project (§1, "Key Point").**
   - Revoking any token "removes all OAuth 2.0 scopes previously granted to a project … for all clients registered under that project."
   - On **re-link**, don't revoke the previous refresh token after getting the new one; that would revoke the new one too. Just discard the old token.
   - The `pending_revocations` table (§18) needs the same guard it has for Todoist: if the admin links the same Google account again, drop the pending row. Otherwise a delayed retry kills the new link.
   - Disconnecting also revokes that admin's `openid email profile` consent. Their app session is unaffected; Google just shows the consent screen again at their next sign-in.
2. **Granular consent.** The admin can untick either scope. The callback must check the token response's `scope` and refuse the link (with a clear message) unless both scopes are present.
3. **§9.1 "writer or owner access":**
   - Google also has `writerWithoutPrivateAccess`, which can write but can't see or modify private events.
   - Decide explicitly. I'd exclude it, since edits to private events would fail.
   - Filter on `accessRole`, not on `minAccessRole`, whose ordering isn't documented.
4. **§9.2 windows in the family time zone vs. the calendar time zone.**
   - Google matches all-day events to a window using the **calendar's** time zone, not the request's `timeZone`.
   - If the two zones differ, all-day events near the window edges can be included or dropped unexpectedly.
   - Either warn when they differ, or over-fetch a day on each side and filter locally.
   - Pass `timeZone=<family tz>` so timed values come back in the family zone.
   - The calendar's time zone is returned in every `events.list` response, so the stored value can be refreshed for free.
5. **§9.6 etags for "All events" operations.**
   - The window read (`singleEvents=true`) returns **instance** etags only. An "All events" patch or delete targets the master (`recurringEventId`) and needs the **master's** etag.
   - The server must `events.get` the master (for its etag, `recurrence` and first-instance start) before showing or saving an "All events" edit.
   - The spec should say this.
6. **"All events" time edits.**
   - The master's `start` and `end` are the first instance's.
   - Moving the series means applying the user's change (the delta) to the master. Writing the edited instance's date into the master would wrongly move the series start.
   - What happens to existing exceptions when the master's time changes is **UNVERIFIED**. Test it before committing to UI copy.
7. **"This event" delete.**
   - The documented path is PUT or patch with `status: "cancelled"` on the instance id.
   - `DELETE` on the instance id is only supported by a 2011 Google blog.
   - Prefer patch `{status:"cancelled"}` with `If-Match`, or verify DELETE in testing.
8. **RRULE editor subset (§9.4).**
   - Daily, weekly with `BYDAY`, monthly on the same day (`BYMONTHDAY`), yearly, plus `COUNT` or `UNTIL` (never both), all fit the documented components.
   - Emit `UNTIL=YYYYMMDD` for all-day events and `UNTIL=YYYYMMDDTHHMMSSZ` (UTC) for timed ones (RFC 5545 §3.3.10).
   - Always send `start.timeZone` and `end.timeZone` (the family zone) on recurring timed events, since Google requires them.
   - Treat these as "can't represent" and show them read-only:
     - any `RDATE` or `EXRULE` line
     - more than one `RRULE`
     - any component beyond the subset
   - `EXDATE`s produced by Google when instances are deleted can be preserved untouched, because patch replaces `recurrence` only if you send it.
9. **Non-default event types.**
   - `events.list` returns `birthday`, `outOfOffice`, `workingLocation`, `focusTime` and `fromGmail` events unless you pass `eventTypes`.
   - The spec doesn't mention them. Either filter with `eventTypes=default`, or show them read-only, along with `locked` events.
10. **Token refresh (§8).**
    - Google's refresh tokens don't appear to rotate (INFERRED).
    - Store a new `refresh_token` only if a response includes one.
    - Password changes don't revoke non-Gmail scopes.
    - Six months of non-use does revoke the token, which the 5-minute poll prevents.
    - Re-linking 100 times on one account and client silently invalidates the oldest token, which is harmless here.
11. **`sendUpdates`.** The default isn't clearly documented. Dashboard-created events have no guests. For edits to events that do have guests, pick a value deliberately: I'd omit it and accept Google's default, rather than send `none`, given Google's warning about `none`.
12. **Library:** plain `fetch` plus the existing `openid-client` (§9). No `googleapis` and no `google-auth-library`.

---

## UNVERIFIED items (collected)

1. What happens to the old refresh token after a `prompt=consent` re-link, apart from the 100-token limit.
2. Whether Google enforces PKCE for confidential web clients.
3. Whether refresh tokens rotate. They appear not to.
4. The exact `invalid_grant` body text and HTTP status from Google.
5. Whether `/revoke` accepts client credentials sent by `openid-client`'s `tokenRevocation`.
6. The sensitivity classification of `calendar.events` (very likely sensitive) and `calendar.calendarlist.readonly`.
7. The exact wording of the unverified-app screen.
8. What "own" means for `calendar.events.owned` (data owner or `owner` role), and whether `.owned` covers `update` and `instances`.
9. How `minAccessRole` orders `writerWithoutPrivateAccess`.
10. The `timeMin` boundary: exclusive for `list`, inclusive for `instances`.
11. That patch honors `If-Match` and 412 specifically on `events.patch`.
12. That instance etags from a `singleEvents` list work with `If-Match` on the instance.
13. Whether etags change on reminder-only changes, and whether they're quoted.
14. The default value of `sendUpdates`.
15. PATCH on an instance id. Only PUT is documented.
16. DELETE on an instance id. Only a 2011 Google blog supports it.
17. The fate of exceptions when the master's time changes. Sources conflict.
18. Google's tolerance for a non-UTC `UNTIL` on timed events.
19. Floating times and how they appear in responses.
20. The newer `error.status` and `error.details` fields in Calendar errors.
21. The reason codes for a missing-scope 403 or a no-write-access 403.
22. The domain-verification requirement for push, and the maximum channel lifetime.
23. The transitive install size of `@googleapis/calendar`, estimated at about 10 MB from metadata, not installed.
