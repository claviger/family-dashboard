import * as client from 'openid-client';
import type { Config } from '../config.js';
import type { GoogleClaims } from './identity.js';

export interface AuthorizationParams {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
}

/** Google sign-in, behind an interface so tests can use a fake (src/server/test/helpers.ts). */
export interface GoogleOidc {
  authorizationUrl(params: AuthorizationParams): Promise<string>;
  /** `callbackUrl` is the redirect URI plus the query string Google returned. */
  exchange(params: AuthorizationParams & { callbackUrl: URL }): Promise<GoogleClaims>;
}

export function createGoogleOidc(config: Config): GoogleOidc {
  let discovered: Promise<client.Configuration> | undefined;
  const getConfig = () => {
    discovered ??= client.discovery(
      new URL('https://accounts.google.com'),
      config.googleClientId,
      config.googleClientSecret,
    ).catch((e) => {
      discovered = undefined;
      throw e;
    });
    return discovered;
  };

  return {
    async authorizationUrl({ state, nonce, codeVerifier, redirectUri }) {
      const oidc = await getConfig();
      return client.buildAuthorizationUrl(oidc, {
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      }).href;
    },

    async exchange({ state, nonce, codeVerifier, redirectUri, callbackUrl }) {
      const oidc = await getConfig();
      const tokens = await client.authorizationCodeGrant(
        oidc,
        callbackUrl,
        { pkceCodeVerifier: codeVerifier, expectedState: state, expectedNonce: nonce },
        { redirect_uri: redirectUri },
      );
      const claims = tokens.claims();
      if (!claims) throw new Error('Google returned no ID token');
      return {
        sub: claims.sub,
        email: String(claims.email ?? ''),
        emailVerified: claims.email_verified === true,
      };
    },
  };
}
