/**
 * Recorded Todoist responses (spec §16, "tested against recorded API responses"). Two sources,
 * both from docs/research/todoist-api-v1.md:
 * - LIVE_*: the shapes the architect observed against the real API on 2026-11-16 ("Verified
 *   live"), with ids replaced by others in the same opaque format.
 * - The rest: the documented examples the notes quote from the official v1 docs, not captured
 *   from a live account. Placeholder values ("...") in the docs are filled in with plausible strings.
 */

/** Verified live: a command on a deleted task (HTTP 200; this is its sync_status entry). */
export const LIVE_ITEM_NOT_FOUND = { error: 'Item not found', error_code: 22, error_tag: 'ITEM_NOT_FOUND', http_code: 400, error_extra: {} };

/** Verified live: a bad token (HTTP 401). */
export const LIVE_INVALID_TOKEN = {
  error: 'Invalid token',
  error_code: 401,
  error_tag: 'AUTH_INVALID_TOKEN',
  http_code: 401,
  error_extra: { access_type: 'access_token', retry_after: 4 },
};

/** Verified live: a deleted item in an incremental sync has its fields blanked. */
export const LIVE_DELETED_ITEM = {
  id: '6j2qXvH9v8wQ2gQr',
  project_id: '2222222222222222',
  content: '',
  description: '',
  due: null,
  checked: false,
  is_deleted: true,
  completed_at: null,
};

/** Verified live: the three due formats. */
export const LIVE_DUE_DATE = { date: '2026-12-02', timezone: null, is_recurring: false, string: '2026-12-02', lang: 'en' };
export const LIVE_DUE_FLOATING = { date: '2026-12-01T09:30:00', timezone: null, is_recurring: false, string: 'Dec 1 9:30', lang: 'en' };
export const LIVE_DUE_FIXED = { date: '2026-12-01T17:30:00Z', timezone: 'America/Los_Angeles', is_recurring: false, string: 'Dec 1 9:30am', lang: 'en' };

/** Research notes §1, "Token exchange": a new app's token response. */
export const TOKEN_RESPONSE = {
  access_token: 'doc-access-token',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'doc-refresh-token',
  scope: 'data:read_write',
};

/** Research notes §1: token-exchange errors. */
export const TOKEN_ERROR_BAD_CODE = { error: 'bad_authorization_code' };
export const TOKEN_ERROR_INVALID_GRANT = { error: 'invalid_grant' };

/** Research notes §1, "Expiry and refresh" and §4, "Error format": an expired or revoked token. */
export const UNAUTHORIZED_BODY = {
  error: 'Unauthorized',
  error_code: 477,
  error_extra: { event_id: 'abc123', retry_after: 4 },
  error_tag: 'UNAUTHORIZED',
  http_code: 401,
};

/** Research notes §3, "Response": a command response. */
export const COMMAND_RESPONSE = {
  sync_token: 'doc-sync-token-2',
  sync_status: { 'cmd-uuid-1': 'ok' },
  temp_id_mapping: { 'temp-1': '6X7rM8997g3RQmvh' },
};

/** Research notes §3: a failed command's sync_status entry. */
export const COMMAND_ERROR = {
  error_tag: 'INVALID_ARGUMENT_VALUE',
  error_code: 20,
  error: 'Invalid argument value',
  http_code: 400,
  error_extra: { argument: 'content', explanation: 'Too long' },
};

/**
 * Research notes §4, "Error format": the documented error body of a REST endpoint (here a 404 for
 * a missing task). It's an HTTP response body, not a `sync_status` entry: a command on a missing
 * task reports ITEM_NOT_FOUND instead (LIVE_ITEM_NOT_FOUND, verified live).
 */
export const REST_ERROR_BODY = {
  error: 'Task not found',
  error_code: 478,
  error_extra: { event_id: 'def456', retry_after: 3 },
  error_tag: 'NOT_FOUND',
  http_code: 404,
};

/** Research notes §2, "Item (task) object", with the field types the table documents. */
export const ITEM = {
  id: '6X7rM8997g3RQmvh',
  user_id: '2671355',
  project_id: '6Jf8VQXxpwv56VQ7',
  section_id: null,
  parent_id: null,
  content: 'Buy milk',
  description: 'Oat, if they have it',
  checked: false,
  is_deleted: false,
  completed_at: null,
  added_at: '2026-11-15T09:00:00.000000Z',
  updated_at: '2026-11-15T09:00:00.000000Z',
  priority: 1,
  labels: [],
  due: { date: '2026-11-20', timezone: null, string: 'Nov 20', lang: 'en', is_recurring: false },
  deadline: null,
  duration: null,
  child_order: 1,
  day_order: -1,
  is_collapsed: false,
  added_by_uid: '2671355',
  assigned_by_uid: null,
  responsible_uid: null,
};

/** Research notes §2, "due object": the three documented formats. */
export const DUE_FULL_DAY = { date: '2026-11-20', timezone: null, string: 'Nov 20', lang: 'en', is_recurring: false };
export const DUE_FLOATING = { date: '2026-11-20T10:00:00', timezone: null, string: 'Nov 20 10:00', lang: 'en', is_recurring: false };
export const DUE_FIXED = { date: '2026-11-20T15:00:00Z', timezone: 'America/Los_Angeles', string: 'Nov 20 7am', lang: 'en', is_recurring: false };
export const DUE_RECURRING = { date: '2026-11-20', timezone: null, string: 'every day', lang: 'en', is_recurring: true };

/** Research notes §2, "Projects and Inbox". `inbox_project` is sent only when true. */
export const INBOX_PROJECT = { id: '6Jf8VQXxpwv56VQ7', name: 'Inbox', is_deleted: false, is_archived: false, parent_id: null, color: 'grey', inbox_project: true };
export const PROJECT = { id: '6Jf8VQXxpwv56VQ8', name: 'Chores', is_deleted: false, is_archived: false, parent_id: null, color: 'blue' };

/** Research notes §5, "Payload". */
export const WEBHOOK_PAYLOAD = {
  event_name: 'item:added',
  user_id: '2671355',
  event_data: ITEM,
  initiator: { id: '2671355', email: 'someone@example.com', full_name: 'Someone', image_id: 'img', is_premium: true },
  triggered_at: '2025-02-10T10:39:38.000000Z',
  version: '10',
  event_data_extra: {},
};

/**
 * Verified live ("Telling completed from deleted"): `GET /api/v1/tasks/{id}` for a completed task
 * is 200 with `checked: true` and `completed_at`. The other fields are the documented task object.
 */
export const LIVE_TASK_COMPLETED = { ...ITEM, id: '6j2qXvH9v8wQ2gQs', checked: true, completed_at: '2026-11-16T18:04:11.123456Z' };

/** Verified live: `GET /api/v1/tasks/{id}` for a deleted task (HTTP 404). */
export const LIVE_TASK_NOT_FOUND = { error: 'Task not found', error_code: 478, error_tag: 'NOT_FOUND', http_code: 404 };

/** Verified live: `GET /api/v1/tasks/{id}` with an id that isn't in Todoist's format (HTTP 400, not 404). */
export const LIVE_TASK_BAD_ID = { error: 'Invalid argument value', error_code: 20, error_tag: 'INVALID_ARGUMENT_VALUE', http_code: 400 };
