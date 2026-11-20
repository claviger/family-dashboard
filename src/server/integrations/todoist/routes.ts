import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { z } from 'zod';
import { ChoresProjectInputSchema, TODOIST_LINK_ERRORS, type TodoistLink, type TodoistLinkError } from '../../../shared/integrations.js';
import type { AppDeps, AppEnv } from '../../app.js';
import { getGrants, getUser } from '../../admin/users.js';
import { AppError, loggableError, parseJson } from '../../core/errors.js';
import { connectionAccount } from '../connections.js';
import { clientIp, rateLimit } from '../../core/rateLimit.js';
import { TodoistHttpError, TodoistOAuthError } from './client.js';
import type { Todoist } from './todoist.js';
import { verifyTodoistSignature } from './webhook.js';

/** Separate from Google's `__Host-oauth-flow`, so the two flows can't overwrite each other. */
const FLOW_COOKIE = '__Host-todoist-flow';
const FlowSchema = z.object({ state: z.string(), codeVerifier: z.string(), userId: z.number(), session: z.string() });

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function settingsWith(error: TodoistLinkError): string {
  return `/settings?todoist_error=${error}`;
}

/**
 * `/connect/todoist/*` (spec §8, §10.6), mounted only when Todoist is configured, so without it
 * these are 404s. Modeled on the Google sign-in flow:
 * - `POST start` puts `state`, a PKCE verifier, the user id, and a hash of the session token in a
 *   signed, 10-minute, `__Host-` cookie, and answers with Todoist's consent-page URL (with `state`
 *   and the S256 challenge), which the page then visits. It's a POST so the CSRF check applies
 *   (`X-Requested-With` and `Origin`): another site can't start a link in someone's browser.
 * - `callback` accepts the result only for the same signed-in user in the same session, with a
 *   matching `state`. So only the signed-in user can link their own account (spec §8), and a
 *   callback URL planted in someone else's browser does nothing.
 *
 * PKCE is advertised by Todoist but UNVERIFIED for confidential apps; if Todoist rejects the
 * exchange for any reason, the person sees a plain error and the log has the OAuth error code,
 * never the code, the verifier, or a token.
 */
export function todoistConnectRoutes(deps: AppDeps & { todoist: Todoist }): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const { todoist } = deps;
  const redirectUri = new URL('/connect/todoist/callback', deps.config.baseUrl).href;
  // Like sign-in (spec §15), 10 a minute, but counted per signed-in user: these need a session,
  // and a family often shares one IP address.
  r.use('*', rateLimit({
    windowMs: 60_000,
    max: 10,
    clock: deps.clock,
    key: (c) => {
      const user = (c as Context<AppEnv>).get('user');
      return user ? `user:${user.id}` : clientIp(c);
    },
    // The callback is a page the browser lands on from Todoist: a redirect to /settings with a
    // plain message, not a JSON error.
    onLimited: (c) => (c.req.path.endsWith('/callback') ? c.redirect(settingsWith('rate_limited'), 302) : undefined),
  }));

  r.post('/start', async (c) => {
    const user = c.get('user');
    const session = c.get('sessionToken');
    if (!user || !session) throw new AppError('unauthenticated', 'Sign in to continue.');
    if (!getGrants(deps.db, user.id).includes('todo')) throw new AppError('forbidden', TODOIST_LINK_ERRORS.no_panel);
    // Linking would fail at the end anyway; better to say why before the consent page.
    if (todoist.keyMismatch) throw new AppError('integration_unavailable', TODOIST_LINK_ERRORS.key_mismatch);
    const flow = { state: randomToken(), codeVerifier: randomToken(), userId: user.id, session: sha256(session) };
    await setSignedCookie(c, FLOW_COOKIE, JSON.stringify(flow), deps.config.sessionSecret, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    });
    return c.json({ url: todoist.client.authorizeUrl({ state: flow.state, codeChallenge: sha256(flow.codeVerifier), redirectUri }) });
  });

  r.get('/callback', async (c) => {
    const raw = await getSignedCookie(c, deps.config.sessionSecret, FLOW_COOKIE);
    deleteCookie(c, FLOW_COOKIE, { path: '/', secure: true });
    let flow: z.infer<typeof FlowSchema> | null = null;
    try {
      const parsed = typeof raw === 'string' ? FlowSchema.safeParse(JSON.parse(raw)) : null;
      flow = parsed?.success ? parsed.data : null;
    } catch {
      flow = null;
    }
    const user = c.get('user');
    const session = c.get('sessionToken');
    const state = c.req.query('state') ?? '';
    if (!flow || !user || !session || flow.userId !== user.id || !sameText(flow.session, sha256(session)) || !sameText(flow.state, state)) {
      return c.redirect(settingsWith('expired'), 302);
    }
    // The panel may have been taken away while the person was on Todoist's consent page.
    if (!getGrants(deps.db, user.id).includes('todo')) return c.redirect(settingsWith('no_panel'), 302);
    const oauthError = c.req.query('error');
    if (oauthError) {
      // Todoist's error codes aren't secret (access_denied, invalid_scope, ...).
      deps.logger.warn({ userId: user.id, oauthError }, 'todoist authorization was not granted');
      return c.redirect(settingsWith(oauthError === 'access_denied' ? 'denied' : 'failed'), 302);
    }
    const code = c.req.query('code');
    if (!code) return c.redirect(settingsWith('failed'), 302);
    // Checked before the code is exchanged, so no token is issued that couldn't be stored.
    if (todoist.keyMismatch) return c.redirect(settingsWith('key_mismatch'), 302);
    let result;
    try {
      const tokens = await todoist.client.exchangeCode({ code, codeVerifier: flow.codeVerifier, redirectUri }, deps.clock.now());
      result = await todoist.link(user.id, tokens);
    } catch (err) {
      deps.logger.warn(
        {
          userId: user.id,
          oauthError: err instanceof TodoistOAuthError ? err.code : undefined,
          httpKind: err instanceof TodoistHttpError ? err.kind : undefined,
          status: err instanceof TodoistHttpError || err instanceof TodoistOAuthError ? err.status : undefined,
        },
        'todoist link failed',
      );
      return c.redirect(settingsWith('failed'), 302);
    }
    if (result === 'in_use' || result === 'other_account') return c.redirect(settingsWith(result), 302);
    // Moving existing open to-dos into Todoist can take a while; it runs after the redirect, and
    // `todo.todoistSync` finishes it if anything fails.
    void todoist.migrate(user.id).catch((err: unknown) => deps.logger.warn({ userId: user.id, ...loggableError(err) }, 'moving to-dos into todoist failed; will retry'));
    return c.redirect('/settings?todoist=connected', 302);
  });

  return r;
}

/**
 * `/api/todoist/*`: the signed-in person's own link (spec §7, §10.6), for /settings. Mounted only
 * when Todoist is configured. Only the session is needed, not the To-do panel: someone whose panel
 * was turned off keeps their link (unsynced), and must still be able to see it and disconnect it.
 * Admins can see everyone's status (`GET /api/admin/connections`) but can't link or unlink for
 * anyone else (spec §8).
 *
 *   GET  /                    → TodoistLink
 *   PUT  /chores-project      ChoresProjectInput → 204 (needs the To-do panel: it's a to-do setting)
 *   POST /disconnect          → 204 (CSRF-checked like every mutation; 10 a minute per person)
 */
export function todoistLinkRoutes(deps: AppDeps & { todoist: Todoist }): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const { todoist } = deps;

  r.get('/', (c) => {
    const userId = c.get('user')!.id;
    const conn = todoist.connection(userId);
    const state = todoist.state(userId);
    const fresh = todoist.freshness(userId);
    if (!conn || !state || !fresh) return c.json({ linked: false } satisfies TodoistLink);
    const body: TodoistLink = {
      linked: true,
      account: connectionAccount(conn.meta),
      status: conn.status,
      lastSyncAt: fresh.lastSyncAt,
      lastError: conn.status === 'ok' ? null : conn.lastError,
      // Every project, not just the ones the list uses: this is the person's own link, and the
      // chores project picker needs them all.
      projects: todoist.allProjects(userId),
      inboxProjectId: state.inboxProjectId,
      choresProjectId: state.choresProjectId,
      choresProjectLost: state.choresProjectLost,
      waitingToMove: todoist.waitingToMove(userId),
      serverNow: fresh.serverNow,
    };
    return c.json(body);
  });

  r.put('/chores-project', async (c) => {
    const userId = c.get('user')!.id;
    if (!getGrants(deps.db, userId).includes('todo')) throw new AppError('forbidden', "You don't have access to this panel.");
    const { projectId } = await parseJson(c, ChoresProjectInputSchema);
    todoist.setChoresProject(userId, projectId);
    return c.body(null, 204);
  });

  // Each disconnect calls Todoist to revoke the tokens, so it's limited like linking.
  r.post(
    '/disconnect',
    rateLimit({ windowMs: 60_000, max: 10, clock: deps.clock, key: (c) => `user:${(c as Context<AppEnv>).get('user')!.id}` }),
    async (c) => {
      await todoist.unlink(c.get('user')!.id);
      return c.body(null, 204);
    },
  );

  return r;
}

/** Only what's needed to find the account. Everything else in a webhook is ignored (research notes §5: notifications, not data). */
const WebhookSchema = z.object({
  event_name: z.string(),
  user_id: z.union([z.string(), z.number()]).transform(String),
});

/**
 * `POST /webhooks/todoist` (spec §14, §15). No session and no CSRF check (the CSRF middleware skips
 * `/webhooks/`); the signature is the authentication. Limited to 600 requests a minute per IP (spec §15)
 * and 1 MiB, before the signature is checked. Every delivery comes from Todoist, one per change,
 * so the count covers every linked person's edits together and needs room for bursts; 600 still
 * stops a flood before each request costs an HMAC.
 *
 * A validly signed request always gets exactly 200 (Todoist treats anything else as a failed
 * delivery, research notes §5), even for an account nobody here has linked. A sync for the linked
 * person starts in the background, at most one every WEBHOOK_SYNC_GAP_MS per person
 * (`syncFromWebhook`); deliveries in between are folded into one sync when the gap ends. So
 * duplicates do no harm, and `X-Todoist-Delivery-ID` is logged but not de-duplicated. A bad
 * signature gets 401.
 */
export function todoistWebhookRoutes(deps: AppDeps & { todoist: Todoist }): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const { todoist } = deps;
  r.use('*', rateLimit({ windowMs: 60_000, max: 600, clock: deps.clock }));
  r.post('/', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.body(null, 413) }), async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    const deliveryId = c.req.header('x-todoist-delivery-id');
    if (!verifyTodoistSignature(body, c.req.header('x-todoist-hmac-sha256'), deps.config.todoist!.clientSecret)) {
      deps.logger.warn({ deliveryId }, 'todoist webhook with a bad signature');
      return c.body(null, 401);
    }
    let payload: z.infer<typeof WebhookSchema> | null = null;
    try {
      const parsed = WebhookSchema.safeParse(JSON.parse(Buffer.from(body).toString('utf8')));
      payload = parsed.success ? parsed.data : null;
    } catch {
      payload = null;
    }
    const userId = payload ? todoist.userForTodoistId(payload.user_id) : null;
    deps.logger.info({ deliveryId, event: payload?.event_name, userId }, 'todoist webhook');
    // Only for someone who'd see it: active, with the To-do panel, and a link that works.
    if (userId !== null && getUser(deps.db, userId)?.active && getGrants(deps.db, userId).includes('todo') && !todoist.needsReconnect(userId)) {
      todoist.syncFromWebhook(userId); // at most one every few seconds; a failure is recorded on the connection
    }
    return c.body(null, 200);
  });
  return r;
}
