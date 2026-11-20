import { z } from 'zod';

/** Spec §8. */
export const CONNECTION_STATUSES = ['ok', 'needs_reconnect', 'error'] as const;
export const ConnectionStatusSchema = z.enum(CONNECTION_STATUSES);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

/** GET /api/admin/connections: every connection's status, never its credentials (spec §5). */
export const ConnectionSummarySchema = z.object({
  id: z.number(),
  kind: z.enum(['google_calendar', 'todoist', 'plaid']),
  scope: z.enum(['family', 'user']),
  ownerUserId: z.number(),
  ownerName: z.string(),
  /** The linked account, as the provider names it (Todoist: its email), if known. */
  account: z.string().nullable(),
  status: ConnectionStatusSchema,
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  /** A Plaid connection only: it waits for the admin to choose its cards (Spend) or accounts (Savings), so it isn't syncing yet (review C-M9). */
  waitingForCards: z.boolean().optional(),
  /** A Plaid connection only: which panel it's for (the Savings spec). */
  plaidPurpose: z.enum(['spend', 'savings']).optional(),
});
export type ConnectionSummary = z.infer<typeof ConnectionSummarySchema>;

/** Todoist's normal refresh interval: the `todo.todoistSync` job runs every 10 minutes (spec §3.5). */
export const TODOIST_SYNC_INTERVAL_MS = 10 * 60_000;
/** Spec §8: data is stale when it's older than twice its source's normal refresh interval. */
export const TODOIST_STALE_AFTER_MS = 2 * TODOIST_SYNC_INTERVAL_MS;

export const TodoistProjectSchema = z.object({ id: z.string(), name: z.string() });
export type TodoistProject = z.infer<typeof TodoistProjectSchema>;

/** Sent with the to-do list and home card of someone linked to Todoist. */
export const TodoistFreshnessSchema = z.object({
  status: ConnectionStatusSchema,
  /** The last successful sync, ISO. Null before the first one. */
  lastSyncAt: z.string().nullable(),
  /**
   * Project names, sorted with Inbox first, for the project tags and grouping (spec §10.4): only
   * the Inbox, the chores project, and projects the list's items are in. Admins see this for
   * other people's lists, so it never names the account's other projects.
   */
  projects: z.array(TodoistProjectSchema),
  /**
   * The server's clock when it answered, ISO. The page works out how old `lastSyncAt` is from this
   * (plus the time since), so a device whose clock is wrong still shows the right age.
   */
  serverNow: z.string(),
});
export type TodoistFreshness = z.infer<typeof TodoistFreshnessSchema>;

/** GET /api/todoist: the signed-in person's own link (spec §7, §10.6). It needs only a session, not the To-do panel. */
export const TodoistLinkSchema = z.discriminatedUnion('linked', [
  z.object({ linked: z.literal(false) }),
  z.object({
    linked: z.literal(true),
    /** The Todoist account's email, if Todoist sent one. */
    account: z.string().nullable(),
    status: ConnectionStatusSchema,
    lastSyncAt: z.string().nullable(),
    /** A plain message about the last failure, if the link isn't `ok`. */
    lastError: z.string().nullable(),
    projects: z.array(TodoistProjectSchema),
    inboxProjectId: z.string().nullable(),
    /** Null means Inbox. */
    choresProjectId: z.string().nullable(),
    /** The chores project's name, if it was deleted or archived in Todoist and chore to-dos went back to Inbox. */
    choresProjectLost: z.string().nullable(),
    /** Open to-dos from before linking that aren't in Todoist yet (spec §10.6, "On linking"). */
    waitingToMove: z.number(),
    /** The server's clock when it answered, as in TodoistFreshness. */
    serverNow: z.string(),
  }),
]);
export type TodoistLink = z.infer<typeof TodoistLinkSchema>;

/** PUT /api/todoist/chores-project. Null means Inbox. */
export const ChoresProjectInputSchema = z.object({
  projectId: z.string({ error: 'Pick a project' }).min(1, 'Pick a project').max(100, 'Pick a project').nullable(),
});
export type ChoresProjectInput = z.infer<typeof ChoresProjectInputSchema>;

/** `?todoist_error=` on /settings after a failed link, and what to tell the person. */
export const TODOIST_LINK_ERRORS = {
  denied: "Todoist wasn't connected, because access wasn't allowed. Try again and choose Agree.",
  expired: 'That connection attempt expired or came from another session. Try connecting again.',
  failed: "Couldn't finish connecting to Todoist. Try again in a few minutes.",
  in_use: "That Todoist account is already linked to someone else's dashboard account.",
  other_account: 'That is a different Todoist account from the one linked before. Disconnect first, then connect the other account.',
  no_panel: 'You need the To-do panel to connect Todoist. Ask your admin.',
  rate_limited: 'Too many connection attempts. Wait a minute and try again.',
  key_mismatch: "Todoist can't be connected right now because the server's encryption key changed. Ask your admin to fix it.",
} as const;
export type TodoistLinkError = keyof typeof TODOIST_LINK_ERRORS;
