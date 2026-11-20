import { describe, expect, it } from 'vitest';
import { fakeGoogleEndpoints } from '../../config.js';
import { FakeGoogleCalendar, SCOPES } from '../../test/fakeGoogleCalendar.js';
import { CALENDAR_EVENTS_SCOPE, CALENDAR_LIST_SCOPE, GoogleCalendarOAuth, GoogleOAuthError, GoogleOAuthUnavailable, pkceChallenge } from './oauth.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const REDIRECT = 'http://localhost:3000/connect/google-calendar/callback';

function setup() {
  const fake = new FakeGoogleCalendar('client-id', 'client-secret');
  const account = fake.createAccount({ email: 'family@example.com' });
  const endpoints = fakeGoogleEndpoints(fake.origins.oauth, fake.origins.api);
  const oauth = new GoogleCalendarOAuth({ clientId: 'client-id', clientSecret: 'client-secret', endpoints }, fake.fetch);
  return { fake, account, oauth };
}

/** Goes through the consent page and back, as the browser would. */
async function link(t: ReturnType<typeof setup>, nonce = 'nonce-1') {
  const flow = { state: 'state-1', nonce: 'nonce-1', codeVerifier: 'v'.repeat(43) };
  const url = new URL(t.oauth.authorizationUrl({ state: flow.state, nonce: flow.nonce, codeChallenge: pkceChallenge(flow.codeVerifier), redirectUri: REDIRECT }));
  const back = t.fake.authorize(url.searchParams);
  return t.oauth.exchange({ callbackUrl: back, state: flow.state, nonce, codeVerifier: flow.codeVerifier, redirectUri: REDIRECT }, NOW);
}

describe('GoogleCalendarOAuth', () => {
  it('asks for offline access with re-consent, both calendar scopes plus openid email, PKCE S256, state, and nonce', () => {
    const { oauth, fake } = setup();
    const url = new URL(oauth.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c', redirectUri: REDIRECT }));
    expect(url.origin + url.pathname).toBe(`${fake.origins.oauth}/o/oauth2/v2/auth`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'client-id', response_type: 'code', redirect_uri: REDIRECT, state: 's', nonce: 'n',
      code_challenge: 'c', code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account',
      scope: `openid email ${CALENDAR_EVENTS_SCOPE} ${CALENDAR_LIST_SCOPE}`,
    });
    expect(url.searchParams.has('include_granted_scopes')).toBe(false);
  });

  it('exchanges the code for tokens, the granted scopes, and the account from the ID token', async () => {
    const t = setup();
    const tokens = await link(t);
    expect(tokens).toMatchObject({ refreshToken: expect.stringMatching(/^1\/\//), account: { id: t.account.sub, email: 'family@example.com' } });
    expect(tokens.expiresAt).toEqual(new Date(NOW.getTime() + 3599_000));
    expect(tokens.grantedScopes).toEqual(expect.arrayContaining([SCOPES.events, SCOPES.calendarList]));
    // client_secret_post, the PKCE verifier, and the same redirect URI.
    const exchange = t.fake.requests.find((r) => r.path === '/token')!;
    expect(exchange.body).toMatchObject({ grant_type: 'authorization_code', client_id: 'client-id', client_secret: 'client-secret', code_verifier: 'v'.repeat(43), redirect_uri: REDIRECT });
  });

  it('reports what granular consent left out, and no scope field at all as null', async () => {
    const t = setup();
    t.fake.grantOnly = ['openid', 'email', SCOPES.events];
    expect((await link(t)).grantedScopes).not.toContain(SCOPES.calendarList);
    t.fake.omitScope = true;
    expect((await link(t)).grantedScopes).toBeNull();
  });

  it('refuses an ID token whose nonce is not the one sent', async () => {
    const t = setup();
    await expect(link(t, 'another-nonce')).rejects.toBeInstanceOf(GoogleOAuthUnavailable);
  });

  it.each([
    ['another issuer', { iss: 'https://accounts.evil.test' }],
    ['another audience', { aud: 'someone-elses-client', azp: 'someone-elses-client' }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 }],
  ])('refuses an ID token from %s (R2-M17)', async (_, claims) => {
    const t = setup();
    t.fake.idTokenClaims = claims;
    const err = await link(t).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleOAuthUnavailable);
    expect(err).toMatchObject({ kind: 'bad_response' });
    // Without the override, the same flow works.
    t.fake.idTokenClaims = null;
    await expect(link(t)).resolves.toMatchObject({ account: { id: t.account.sub } });
  });

  it('refreshes without rotating the refresh token, and reports invalid_grant once the grant is gone', async () => {
    const t = setup();
    const { refreshToken } = await link(t);
    const refreshed = await t.oauth.refresh(refreshToken!, NOW);
    expect(refreshed).toMatchObject({ accessToken: expect.stringMatching(/^ya29\./), refreshToken: null });
    t.fake.revokeAccount(t.account);
    const err = await t.oauth.refresh(refreshToken!, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleOAuthError);
    expect(err).toMatchObject({ code: 'invalid_grant', status: 400 });
  });

  it('tells a server error and no answer apart from an OAuth error', async () => {
    const t = setup();
    const { refreshToken } = await link(t);
    t.fake.failures.push({ path: 'token', status: 503, body: 'down' });
    await expect(t.oauth.refresh(refreshToken!, NOW)).rejects.toMatchObject({ name: 'GoogleOAuthUnavailable', kind: 'server' });
    const offline = new GoogleCalendarOAuth(
      { clientId: 'client-id', clientSecret: 'client-secret', endpoints: fakeGoogleEndpoints(t.fake.origins.oauth, t.fake.origins.api) },
      () => Promise.reject(new TypeError('fetch failed')),
    );
    await expect(offline.refresh(refreshToken!, NOW)).rejects.toMatchObject({ name: 'GoogleOAuthUnavailable', kind: 'network' });
  });

  it('revokes with a form body and no client credentials, which ends the whole grant', async () => {
    const t = setup();
    const { refreshToken } = await link(t);
    await t.oauth.revoke(refreshToken!);
    const req = t.fake.requests.find((r) => r.path === '/revoke')!;
    expect(req.body).toEqual({ token: refreshToken });
    expect(req.authorization).toBeNull();
    expect(t.fake.revocations).toEqual([{ sub: t.account.sub, kind: 'refresh' }]);
    expect(t.fake.liveRefreshTokens(t.account)).toBe(0);
    await expect(t.oauth.revoke(refreshToken!)).rejects.toMatchObject({ name: 'GoogleOAuthError', code: 'invalid_token', status: 400 });
    t.fake.failures.push({ path: 'revoke', status: 500 });
    await expect(t.oauth.revoke('anything')).rejects.toMatchObject({ name: 'GoogleOAuthUnavailable', kind: 'server' });
  });
});
