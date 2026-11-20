import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import * as client from 'openid-client';
import type { GoogleEndpoints } from '../../config.js';

/**
 * The Google Calendar link's OAuth (spec §9.1), written against docs/research/google-calendar-v3.md
 * §1. `openid-client` 6 (already used for sign-in) does the authorization URL, the code exchange,
 * and the refresh; revocation is a plain POST that matches Google's docs (see `revoke`). It uses
 * the same OAuth client as sign-in. Nothing here touches the database or logs, and no error
 * message contains a token, a code, or a response body.
 */

export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const CALENDAR_LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
/**
 * Spec §9.1's two calendar scopes, plus `openid email`: the ID token says which Google account
 * linked (shown as "Connected as", and what keeps a waiting revocation from ending a newer link
 * to the same account). Both are already granted for sign-in, and revoking ends every grant for
 * the project anyway (research notes §1), so asking for them costs nothing.
 */
export const CALENDAR_LINK_SCOPES = ['openid', 'email', CALENDAR_EVENTS_SCOPE, CALENDAR_LIST_SCOPE] as const;
/** The two scopes the link can't work without. Granular consent lets the admin untick either. */
export const REQUIRED_CALENDAR_SCOPES = [CALENDAR_EVENTS_SCOPE, CALENDAR_LIST_SCOPE] as const;

export type FetchFn = typeof fetch;

/** Google's token endpoint answered with an OAuth error, e.g. `invalid_grant` (research notes §1). */
export class GoogleOAuthError extends Error {
  constructor(readonly code: string, readonly status: number | null) {
    super(`Google refused the token request (${code}).`);
    this.name = 'GoogleOAuthError';
  }
}

/**
 * No usable answer: `network` (no response, or it timed out), `server` (a 5xx without an OAuth
 * error body), or `bad_response` (the answer wasn't what the docs describe, e.g. an ID token that
 * fails validation). `code` is openid-client's error code, safe to log.
 */
export class GoogleOAuthUnavailable extends Error {
  constructor(readonly kind: 'network' | 'server' | 'bad_response', readonly code: string | null, readonly status: number | null = null) {
    super(kind === 'network' ? "Couldn't reach Google." : "Google's answer wasn't in the expected format.");
    this.name = 'GoogleOAuthUnavailable';
  }
}

export interface LinkTokens {
  accessToken: string;
  /** Null if Google sent none; the link can't work without one. */
  refreshToken: string | null;
  expiresAt: Date | null;
  /**
   * The token response's `scope`, split. Null when Google left it out, which RFC 6749 §5.1 allows
   * only when it's exactly what was asked for.
   */
  grantedScopes: string[] | null;
  /** From the ID token. */
  account: { id: string; email: string | null };
}

export interface RefreshedTokens {
  accessToken: string;
  expiresAt: Date | null;
  /** Google doesn't appear to rotate refresh tokens (research notes §1, INFERRED): null unless it sent a new one. */
  refreshToken: string | null;
}

/** openid-client and oauth4webapi errors, as ours. */
function translate(err: unknown): Error {
  if (err instanceof client.ResponseBodyError) return new GoogleOAuthError(err.error, err.status);
  if (err instanceof client.AuthorizationResponseError) return new GoogleOAuthError(err.error, null);
  if (err instanceof TypeError) return new GoogleOAuthUnavailable('network', null);
  if (err instanceof client.ClientError) {
    if (err.code === 'OAUTH_TIMEOUT') return new GoogleOAuthUnavailable('network', err.code);
    if (err.code === 'OAUTH_RESPONSE_IS_NOT_CONFORM' || err.code === 'OAUTH_RESPONSE_IS_NOT_JSON') return new GoogleOAuthUnavailable('server', err.code);
    return new GoogleOAuthUnavailable('bad_response', err.code ?? null);
  }
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) return new GoogleOAuthUnavailable('network', null);
  return new GoogleOAuthUnavailable('bad_response', null);
}

function expiresAt(expiresIn: number | undefined, now: Date): Date | null {
  return typeof expiresIn === 'number' ? new Date(now.getTime() + expiresIn * 1000) : null;
}

/** PKCE S256 (RFC 7636): what `client.calculatePKCECodeChallenge` computes, without the await. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export class GoogleCalendarOAuth {
  private readonly config: client.Configuration;
  /** A caller's deadline for the request openid-client is making now, as a signal (R2-M7). */
  private readonly callSignal = new AsyncLocalStorage<AbortSignal>();

  constructor(
    cfg: { clientId: string; clientSecret: string; endpoints: GoogleEndpoints },
    private readonly fetchFn: FetchFn,
    private readonly revokeTimeoutMs = 10_000,
  ) {
    // Google's metadata as its discovery document gives it (research notes §1), so the link
    // needs no discovery request. The fake's metadata in tests, at its own origins.
    this.config = new client.Configuration(
      {
        issuer: cfg.endpoints.issuer,
        authorization_endpoint: cfg.endpoints.authorization,
        token_endpoint: cfg.endpoints.token,
        revocation_endpoint: cfg.endpoints.revocation,
        id_token_signing_alg_values_supported: ['RS256'],
      },
      cfg.clientId,
      cfg.clientSecret,
    );
    this.config[client.customFetch] = (url, options) => {
      const deadline = this.callSignal.getStore();
      const own = (options as RequestInit).signal ?? undefined;
      const signal = deadline ? (own ? AbortSignal.any([own, deadline]) : deadline) : own;
      return this.fetchFn(url, { ...(options as RequestInit), signal });
    };
    // Seconds, per request. Someone is usually waiting (a callback, a page load), and a refresh that
    // times out is simply tried again: Google's refresh tokens don't rotate.
    this.config.timeout = 10;
    // The tests' fake answers on http://localhost; loadConfig allows that only in test mode.
    if (new URL(cfg.endpoints.token).protocol === 'http:') client.allowInsecureRequests(this.config);
  }

  /**
   * The consent page (spec §9.1, research notes §1): offline access with `prompt=consent`, so a
   * new refresh token comes back on every link, and `select_account`, so the admin picks which
   * Google account deliberately; PKCE S256, `state`, and a `nonce` for the ID token.
   * `include_granted_scopes` is left out, so the grant is just these scopes.
   */
  authorizationUrl(p: { state: string; nonce: string; codeChallenge: string; redirectUri: string }): string {
    return client.buildAuthorizationUrl(this.config, {
      redirect_uri: p.redirectUri,
      scope: CALENDAR_LINK_SCOPES.join(' '),
      state: p.state,
      nonce: p.nonce,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent select_account',
    }).href;
  }

  /**
   * Exchanges the callback's code. `callbackUrl` is the redirect URI plus the query string Google
   * returned, rebuilt from BASE_URL (behind nginx the request URL is the internal one). Checks
   * `state` and the ID token (its issuer, audience, expiry, and `nonce`), as sign-in does.
   * `opts.deadline` (epoch ms, the real clock) ends the request early, as GoogleOAuthUnavailable
   * with code `deadline`, as for `refresh` (R4-M2).
   */
  async exchange(p: { callbackUrl: URL; state: string; nonce: string; codeVerifier: string; redirectUri: string }, now: Date, opts: { deadline?: number } = {}): Promise<LinkTokens> {
    const left = opts.deadline === undefined ? null : opts.deadline - Date.now();
    if (left !== null && left <= 0) throw new GoogleOAuthUnavailable('network', 'deadline');
    let tokens;
    try {
      const grant = () => client.authorizationCodeGrant(
        this.config,
        p.callbackUrl,
        { pkceCodeVerifier: p.codeVerifier, expectedState: p.state, expectedNonce: p.nonce, idTokenExpected: true },
        { redirect_uri: p.redirectUri },
      );
      tokens = left === null ? await grant() : await this.callSignal.run(AbortSignal.timeout(left), grant);
    } catch (err) {
      if (opts.deadline !== undefined && Date.now() >= opts.deadline) throw new GoogleOAuthUnavailable('network', 'deadline');
      throw translate(err);
    }
    const claims = tokens.claims();
    if (!claims) throw new GoogleOAuthUnavailable('bad_response', 'no_id_token');
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: expiresAt(tokens.expires_in, now),
      grantedScopes: typeof tokens.scope === 'string' ? tokens.scope.split(' ').filter((s) => s !== '') : null,
      account: { id: claims.sub, email: typeof claims.email === 'string' ? claims.email : null },
    };
  }

  /**
   * A new access token. Throws GoogleOAuthError (`invalid_grant`: the grant is gone) or
   * GoogleOAuthUnavailable. `opts.deadline` (epoch ms, the real clock) ends the request early, as
   * GoogleOAuthUnavailable with code `deadline` (R2-M7).
   */
  async refresh(refreshToken: string, now: Date, opts: { deadline?: number } = {}): Promise<RefreshedTokens> {
    const left = opts.deadline === undefined ? null : opts.deadline - Date.now();
    if (left !== null && left <= 0) throw new GoogleOAuthUnavailable('network', 'deadline');
    let tokens;
    try {
      const grant = () => client.refreshTokenGrant(this.config, refreshToken);
      tokens = left === null ? await grant() : await this.callSignal.run(AbortSignal.timeout(left), grant);
    } catch (err) {
      if (opts.deadline !== undefined && Date.now() >= opts.deadline) throw new GoogleOAuthUnavailable('network', 'deadline');
      throw translate(err);
    }
    return { accessToken: tokens.access_token, expiresAt: expiresAt(tokens.expires_in, now), refreshToken: tokens.refresh_token ?? null };
  }

  /**
   * Revokes a token (research notes §1, "Revocation endpoint"): `POST` to the revocation endpoint
   * with `token` in a form body, as Google's Node.js sample does, and no client credentials, as
   * the docs send none. openid-client's `tokenRevocation` would add `client_secret_post`
   * credentials, and whether Google accepts those is UNVERIFIED. A refresh token's revocation also
   * ends its grant. Google answers 200, or 400 with an error code.
   *
   * Revoking ends every grant the Google account has given this project, sign-in included, so
   * only disconnecting calls this; relinking and reconnecting never do.
   */
  async revoke(token: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchFn(this.config.serverMetadata().revocation_endpoint!, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(this.revokeTimeoutMs),
      });
    } catch {
      throw new GoogleOAuthUnavailable('network', null);
    }
    if (res.ok) return;
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (res.status >= 500) throw new GoogleOAuthUnavailable('server', null, res.status);
    throw new GoogleOAuthError(typeof body?.error === 'string' ? body.error : 'revocation_failed', res.status);
  }
}
