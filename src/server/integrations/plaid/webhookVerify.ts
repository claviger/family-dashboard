import { createHash, timingSafeEqual } from 'node:crypto';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import type { Clock } from '../../core/clock.js';
import { classifyPlaidError, PlaidApiError, type PlaidClient, type PlaidWebhookKey } from './client.js';

/**
 * Plaid's webhook check (docs/research/plaid-6b.md §7.1, spec §15): `Plaid-Verification` is an
 * ES256 JWT whose payload has `iat` and `request_body_sha256`, the SHA-256 of the body's exact
 * bytes. Each step, in order:
 * 1. The header is there (any case: HTTP/2 sends it lowercase) and is a compact JWS.
 * 2. Its `alg` is `ES256` (a `none` or an HMAC `alg` is refused before anything else), and its
 *    `kid` looks like a key id. The `kid` comes from whoever sent the request, so nothing else is
 *    trusted about it.
 * 3. The key for the `kid` (see "The key cache" below), not past its `expired_at`.
 * 4. The signature, with `jose`, ES256 only.
 * 5. `iat` at most 5 minutes old and at most 30 seconds ahead, checked here rather than with
 *    jose's `maxTokenAge`, which refuses any `iat` ahead of our clock unless `clockTolerance` is
 *    set, and that would stretch the 5 minutes too (the design's departure 5). A refusal is a 401,
 *    which Plaid never retries (research §7.5), so a clock a second behind Plaid's must not lose
 *    webhooks.
 * 6. The body hash, in constant time.
 * 7. The body is a JSON object.
 *
 * A refusal (`{ ok: false }`) is a 401. A key that can't be had right now throws
 * PlaidKeyUnavailable, a 503, so Plaid tries again later. A `kid` Plaid says it doesn't know is one
 * of those: a forger gains nothing from a 401 over a 503, and a real `kid` Plaid hasn't published
 * yet gets Plaid's retries instead of being dropped for good. So no answer from the key endpoint
 * decides anything permanent.
 *
 * The key cache (the design's "The key cache"): keys are kept in memory by `kid`, imported once,
 * since Plaid rotates them (research §7.2) and a single cached key would refuse every webhook after
 * a rotation. A cached key is fetched again when it's used more than a day after it was fetched,
 * so an `expired_at` Plaid sets later is seen within a day; if that fetch fails, the cached key is
 * kept and asked for again 10 minutes later. A `kid` Plaid says it doesn't know is remembered for
 * 10 minutes, each webhook under it a 503 without a fetch (expired entries are swept on each insert, and the oldest dropped past
 * UNKNOWN_KIDS_MAX). A `kid` that isn't cached is fetched at most once a minute per client IP and
 * at most 10 times a minute in all: each fetch is a call to Plaid with our secret, made for anyone
 * who can POST to us, and the per-IP budget keeps one sender from spending the whole minute's.
 * IPv6 senders are counted by their /64, since one host usually has a whole /64 to send from.
 * Plaid's documented webhook addresses (research §7.5, PLAID_WEBHOOK_IPS) don't share that
 * budget: they have their own, PLAID_KEY_FETCHES_PER_MINUTE, which nobody else can spend, so ten
 * other addresses can't use up the minute a real key rotation needs. If Plaid's addresses change,
 * the only effect is that its webhooks fall back to the shared budget (nothing filters by address,
 * since a stale list would drop real webhooks). Past any budget the webhook is a 503, never a 401,
 * so a flood of forged `kid`s can't make us drop a real webhook signed with a new key. Each fetch has the client's 5-second timeout, so the
 * answer stays inside Plaid's 10 seconds.
 *
 * Replays: the SHA-256 of every accepted webhook's signing input (`header.payload`, the JWT up to
 * its last `.`) is kept for REPLAY_WINDOW_MS, as long as that JWT could verify (5 minutes, plus
 * the 30 seconds an `iat` may be ahead). The same signing input again in that time is
 * `replay: true`: the caller answers 200 and doesn't process it twice, whether it's someone
 * resending a captured request or Plaid sending the same delivery again (a replayed "new data"
 * webhook still asks for a sync, folded into any pending one: BankSync's `handleReplayedWebhook`).
 * It's keyed on the signing
 * input, not the whole JWT, because ES256 signatures are malleable: `(r, n - s)` verifies as well
 * as `(r, s)`, and a base64url signature's last character has unused bits, so one delivery has
 * many valid JWTs. The signing input carries `iat` and the body's hash, so two genuine deliveries
 * with the same bytes a second or more apart are still two; two in the same second fold into one,
 * which is harmless: a sync from the stored cursor is idempotent, and the other webhooks set
 * state. A retry Plaid signed afresh is processed again, for the same reason. When the caller
 * fails after a delivery verified, it calls `forget(delivery)`, so Plaid's retry of the same JWT
 * isn't dropped as a replay.
 *
 * Nothing here logs: the caller logs the result's reason and `kid`, never the header or the body.
 */

/** Research §7.1: "not more than 5 minutes old". */
export const WEBHOOK_MAX_AGE_SEC = 5 * 60;
/** How far ahead of our clock Plaid's may be (departure 5). */
export const WEBHOOK_MAX_SKEW_SEC = 30;
/** How long a `kid` Plaid doesn't know is answered from memory. */
export const UNKNOWN_KID_TTL_MS = 10 * 60_000;
/** Fetches of `kid`s that aren't cached, per minute, in all. */
export const KEY_FETCHES_PER_MINUTE = 10;
/** Fetches of `kid`s that aren't cached, per minute, for one client IP (an IPv6 /64). */
export const KEY_FETCHES_PER_IP_PER_MINUTE = 1;
/**
 * Plaid's webhook source addresses, "subject to change" (research §7.5). Used only to give Plaid a
 * budget of its own, never to refuse anyone.
 */
export const PLAID_WEBHOOK_IPS: readonly string[] = ['52.21.26.131', '52.21.47.157', '52.41.247.19', '52.88.82.239'];
/** Fetches of `kid`s that aren't cached, per minute, for Plaid's own addresses together. */
export const PLAID_KEY_FETCHES_PER_MINUTE = 10;
/** At most this many unknown `kid`s are remembered; past it the oldest is dropped (that can only cost a fetch). */
export const UNKNOWN_KIDS_MAX = 256;
/** A cached key used this long after it was fetched is fetched again, for a later `expired_at`. */
export const KEY_RECHECK_MS = 24 * 60 * 60_000;
/** After a failed recheck, the cached key is kept and asked for again this much later. */
export const KEY_RECHECK_RETRY_MS = 10 * 60_000;
/** How long an accepted JWT's hash is kept: as long as it could still verify. */
export const REPLAY_WINDOW_MS = (WEBHOOK_MAX_AGE_SEC + WEBHOOK_MAX_SKEW_SEC) * 1000;
const FETCH_WINDOW_MS = 60_000;
/** Far longer than any JWT Plaid sends; a bigger header isn't parsed. */
const MAX_HEADER_LENGTH = 4096;
/** Plaid's key ids look like UUIDs. This only keeps junk out of a call to Plaid. */
const KID = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Why a webhook was refused (each a 401). */
export type WebhookRejection =
  | 'missing' | 'malformed' | 'alg' | 'bad_key' | 'key_expired' | 'signature' | 'stale' | 'future' | 'body_hash' | 'body';

/**
 * `replay`: the same delivery (its signing input) was accepted within REPLAY_WINDOW_MS. Answer
 * 200, and don't process it again. `delivery` is its key in the replay set, for `forget`.
 */
export type WebhookVerifyResult =
  | { ok: true; payload: Record<string, unknown>; kid: string; replay: boolean; delivery: string }
  | { ok: false; reason: WebhookRejection; kid: string | null };

/**
 * The webhook's key couldn't be had now (a 503): Plaid didn't answer or refused our keys
 * (`unreachable`), Plaid said it has no key by that id, now or in the last 10 minutes
 * (`unknown_kid`), or too many unknown `kid`s were fetched this minute, in all or for this client's
 * IP (`limited`). `errorCode` is Plaid's, when it answered with one.
 */
export class PlaidKeyUnavailable extends Error {
  constructor(readonly reason: 'unreachable' | 'unknown_kid' | 'limited', readonly errorCode: string | null = null) {
    super(
      reason === 'limited' ? 'Too many unknown Plaid webhook keys were asked for this minute.'
        : reason === 'unknown_kid' ? "Plaid doesn't know the webhook's key id (yet)." : "Couldn't get the Plaid webhook key.",
    );
    this.name = 'PlaidKeyUnavailable';
  }
}

export interface PlaidWebhookVerifierDeps {
  client: Pick<PlaidClient, 'getWebhookVerificationKey'>;
  clock: Clock;
  /** For tests: a smaller cap on remembered unknown `kid`s than UNKNOWN_KIDS_MAX. */
  maxUnknownKids?: number;
}

type ImportedKey = Awaited<ReturnType<typeof importJWK>>;

interface CachedKey {
  key: ImportedKey;
  /** Unix seconds, or null when Plaid set none. */
  expiredAt: number | null;
  /** When to fetch it again (epoch ms): a day after it was fetched, sooner after a failed recheck. */
  recheckAt: number;
}

type KeyLookup = { key: CachedKey } | { refused: 'bad_key' };

/** A `kid` remembered as unusable: Plaid didn't know it (a 503 each time), or served a key we can't use (a 401). */
interface UnknownKid {
  until: number;
  refused: 'unknown_kid' | 'bad_key';
}

/** The `Plaid-Verification` header from Headers or a plain record, whatever its case. */
export function plaidVerificationHeader(headers: Headers | Record<string, string | string[] | undefined>): string | null {
  if (headers instanceof Headers) return headers.get('plaid-verification');
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'plaid-verification' || value === undefined) continue;
    return Array.isArray(value) ? (value[0] ?? null) : value;
  }
  return null;
}

export class PlaidWebhookVerifier {
  private readonly keys = new Map<string, CachedKey>();
  /** `kid`s Plaid said it doesn't know (or served unusable), until when (epoch ms), oldest first. */
  private readonly unknown = new Map<string, UnknownKid>();
  /** When each recent fetch of a `kid` that wasn't cached started (epoch ms), for anyone but Plaid's addresses. */
  private fetchedAt: number[] = [];
  /** The same for Plaid's addresses (PLAID_WEBHOOK_IPS). */
  private plaidFetchedAt: number[] = [];
  /** The last fetch of a `kid` that wasn't cached, per client IP (epoch ms). */
  private readonly fetchedByIp = new Map<string, number>();
  /** Fetches in flight, so webhooks arriving together under a new `kid` share one. */
  private readonly inFlight = new Map<string, Promise<KeyLookup>>();
  /** Rechecks of cached keys in flight, shared the same way. */
  private readonly rechecking = new Map<string, Promise<CachedKey>>();
  /** Accepted JWTs' SHA-256 (hex), until when (epoch ms), oldest first. */
  private readonly accepted = new Map<string, number>();

  constructor(private readonly deps: PlaidWebhookVerifierDeps) {}

  /** How many unknown `kid`s are remembered now (for tests). */
  get unknownKidCount(): number {
    return this.unknown.size;
  }

  /**
   * `body` is the request's raw bytes, exactly as received; `ip` is the client's (`clientIp`), for
   * the per-IP budget of key fetches. Callers that don't pass one share a budget. Throws
   * PlaidKeyUnavailable (a 503).
   */
  async verify(
    body: Uint8Array,
    headers: Headers | Record<string, string | string[] | undefined>,
    ip?: string,
  ): Promise<WebhookVerifyResult> {
    const token = plaidVerificationHeader(headers)?.trim();
    if (!token) return { ok: false, reason: 'missing', kid: null };
    if (token.length > MAX_HEADER_LENGTH || token.split('.').length !== 3) return { ok: false, reason: 'malformed', kid: null };
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      return { ok: false, reason: 'malformed', kid: null };
    }
    if (header.alg !== 'ES256') return { ok: false, reason: 'alg', kid: null };
    const kid = header.kid;
    if (typeof kid !== 'string' || !KID.test(kid)) return { ok: false, reason: 'malformed', kid: null };

    const found = await this.key(kid, ip ?? 'unknown');
    if ('refused' in found) return { ok: false, reason: found.refused, kid };
    const now = this.deps.clock.now();
    const nowSec = Math.floor(now.getTime() / 1000);
    if (found.key.expiredAt !== null && found.key.expiredAt <= nowSec) return { ok: false, reason: 'key_expired', kid };

    let claims: Record<string, unknown>;
    try {
      // No exp or nbf is expected; if one is there, jose checks it against our clock, with the
      // same skew allowed as for iat. (Without maxTokenAge, the tolerance touches nothing else.)
      claims = (await jwtVerify(token, found.key.key, { algorithms: ['ES256'], currentDate: now, clockTolerance: WEBHOOK_MAX_SKEW_SEC })).payload;
    } catch (err) {
      const { code, claim, reason } = err as { code?: unknown; claim?: unknown; reason?: unknown };
      if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') return { ok: false, reason: 'signature', kid };
      if (code === 'ERR_JWT_EXPIRED') return { ok: false, reason: 'stale', kid };
      if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && claim === 'nbf' && reason === 'check_failed') return { ok: false, reason: 'future', kid };
      return { ok: false, reason: 'malformed', kid };
    }

    const iat = claims.iat;
    if (typeof iat !== 'number' || !Number.isFinite(iat)) return { ok: false, reason: 'malformed', kid };
    if (nowSec - iat > WEBHOOK_MAX_AGE_SEC) return { ok: false, reason: 'stale', kid };
    if (iat - nowSec > WEBHOOK_MAX_SKEW_SEC) return { ok: false, reason: 'future', kid };

    const claimed = claims.request_body_sha256;
    const actual = createHash('sha256').update(body).digest('hex');
    if (typeof claimed !== 'string' || !SHA256_HEX.test(claimed.toLowerCase())) return { ok: false, reason: 'body_hash', kid };
    // Both are 64 hex characters here, so the comparison is constant time over equal lengths.
    if (!timingSafeEqual(Buffer.from(claimed.toLowerCase()), Buffer.from(actual))) return { ok: false, reason: 'body_hash', kid };

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body).toString('utf8'));
    } catch {
      return { ok: false, reason: 'body', kid };
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'body', kid };

    // Checked last, so a forged request is still a 401. Nothing is awaited from here on, so two
    // copies arriving together can't both pass as new.
    const nowMs = now.getTime();
    const delivery = createHash('sha256').update(token.slice(0, token.lastIndexOf('.'))).digest('hex');
    const result = { ok: true as const, payload: payload as Record<string, unknown>, kid, delivery };
    const seenUntil = this.accepted.get(delivery);
    if (seenUntil !== undefined && seenUntil > nowMs) return { ...result, replay: true };
    sweep(this.accepted, nowMs, (v) => v);
    this.accepted.delete(delivery);
    this.accepted.set(delivery, nowMs + REPLAY_WINDOW_MS);
    return { ...result, replay: false };
  }

  /**
   * Takes a delivery out of the replay set: the caller failed after it verified (and answered
   * Plaid with a 5xx), so Plaid's retry of the same JWT must be processed, not ignored.
   */
  forget(delivery: string): void {
    this.accepted.delete(delivery);
  }

  private async key(kid: string, ip: string): Promise<KeyLookup> {
    const now = this.deps.clock.now().getTime();
    const cached = this.keys.get(kid);
    if (cached) return { key: cached.recheckAt <= now ? await this.recheck(kid, cached) : cached };
    const remembered = this.unknown.get(kid);
    if (remembered !== undefined) {
      if (remembered.until > now) {
        if (remembered.refused === 'unknown_kid') throw new PlaidKeyUnavailable('unknown_kid');
        return { refused: remembered.refused };
      }
      this.unknown.delete(kid);
    }
    const pending = this.inFlight.get(kid);
    if (pending) return pending;
    const sender = ipBucket(ip);
    if (PLAID_IPS.has(sender)) {
      this.plaidFetchedAt = this.plaidFetchedAt.filter((t) => now - t < FETCH_WINDOW_MS);
      if (this.plaidFetchedAt.length >= PLAID_KEY_FETCHES_PER_MINUTE) throw new PlaidKeyUnavailable('limited');
      this.plaidFetchedAt.push(now);
    } else {
      // Both budgets are checked before either is spent, so a refusal by one costs the other nothing.
      const lastFromIp = this.fetchedByIp.get(sender);
      if (lastFromIp !== undefined && now - lastFromIp < FETCH_WINDOW_MS / KEY_FETCHES_PER_IP_PER_MINUTE) throw new PlaidKeyUnavailable('limited');
      this.fetchedAt = this.fetchedAt.filter((t) => now - t < FETCH_WINDOW_MS);
      if (this.fetchedAt.length >= KEY_FETCHES_PER_MINUTE) throw new PlaidKeyUnavailable('limited');
      this.fetchedAt.push(now);
      // Swept on each insert; at most KEY_FETCHES_PER_MINUTE entries are ever younger than a minute.
      for (const [other, at] of this.fetchedByIp) if (now - at >= FETCH_WINDOW_MS) this.fetchedByIp.delete(other);
      this.fetchedByIp.set(sender, now);
    }
    const fetching = this.fetchKey(kid).finally(() => this.inFlight.delete(kid));
    this.inFlight.set(kid, fetching);
    return fetching;
  }

  private async fetchKey(kid: string): Promise<KeyLookup> {
    let jwk: PlaidWebhookKey;
    try {
      jwk = await this.deps.client.getWebhookVerificationKey(kid);
    } catch (err) {
      const errorCode = err instanceof PlaidApiError ? err.errorCode : null;
      if (isUnknownKid(err)) {
        this.rememberUnknown(kid, 'unknown_kid');
        throw new PlaidKeyUnavailable('unknown_kid', errorCode);
      }
      throw new PlaidKeyUnavailable('unreachable', errorCode);
    }
    const entry = await this.usableKey(kid, jwk);
    if (!entry) {
      this.rememberUnknown(kid, 'bad_key');
      return { refused: 'bad_key' };
    }
    this.keys.set(kid, entry);
    return { key: entry };
  }

  /**
   * A cached key used a day after it was fetched is fetched again, so an `expired_at` Plaid set
   * since then is honored. If that fails in any way (Plaid down, or an answer we can't use: what
   * Plaid answers for a retired key is UNVERIFIED), the cached key is kept, since refusing real
   * webhooks for good over a failed recheck would be worse, and it's asked for again 10 minutes
   * later. Only keys Plaid served are rechecked, at most that often, so these fetches aren't
   * counted in the budgets above.
   */
  private recheck(kid: string, cached: CachedKey): Promise<CachedKey> {
    const pending = this.rechecking.get(kid);
    if (pending) return pending;
    const checking = (async () => {
      let entry: CachedKey | null = null;
      try {
        entry = await this.usableKey(kid, await this.deps.client.getWebhookVerificationKey(kid));
      } catch {
        // Kept as it is, below.
      }
      const kept = entry ?? { ...cached, recheckAt: this.deps.clock.now().getTime() + KEY_RECHECK_RETRY_MS };
      this.keys.set(kid, kept);
      return kept;
    })().finally(() => this.rechecking.delete(kid));
    this.rechecking.set(kid, checking);
    return checking;
  }

  /** Plaid's keys are ES256 on P-256 (research §7.1). Anything else isn't used, whatever it claims: null. */
  private async usableKey(kid: string, jwk: PlaidWebhookKey): Promise<CachedKey | null> {
    if (jwk.kid !== kid || jwk.alg !== 'ES256' || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
    let key: ImportedKey;
    try {
      key = await importJWK({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, 'ES256');
    } catch {
      return null;
    }
    if (key instanceof Uint8Array) return null;
    return { key, expiredAt: jwk.expired_at, recheckAt: this.deps.clock.now().getTime() + KEY_RECHECK_MS };
  }

  private rememberUnknown(kid: string, refused: UnknownKid['refused']): void {
    const now = this.deps.clock.now().getTime();
    sweep(this.unknown, now, (v) => v.until);
    this.unknown.delete(kid);
    const max = this.deps.maxUnknownKids ?? UNKNOWN_KIDS_MAX;
    // Every entry lives as long, so the first in the map is the oldest.
    while (this.unknown.size >= max) {
      const oldest = this.unknown.keys().next().value;
      if (oldest === undefined) break;
      this.unknown.delete(oldest);
    }
    this.unknown.set(kid, { until: now + UNKNOWN_KID_TTL_MS, refused });
  }
}

const PLAID_IPS: ReadonlySet<string> = new Set(PLAID_WEBHOOK_IPS);

/**
 * Who a client address counts as, for the key-fetch budgets: an IPv4 address as itself (an
 * IPv4-mapped IPv6 one too), an IPv6 address as its /64 (`v6:` and the first four groups, written
 * in full), and anything that doesn't parse as itself, lowercased.
 */
export function ipBucket(ip: string): string {
  const a = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return mapped[1]!;
  if (!a.includes(':')) return a;
  const halves = a.replace(/%.*$/, '').split('::');
  if (halves.length > 2) return a;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return a;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return a;
  return `v6:${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}`;
}

/**
 * Drops the entries whose time (epoch ms) has passed, from a map whose entries all live as long
 * and are set in time order (a re-set one deleted first), so they're oldest first: it stops at the
 * first that's still good.
 */
function sweep<V>(map: Map<string, V>, now: number, until: (v: V) => number): void {
  for (const [key, value] of map) {
    if (until(value) > now) return;
    map.delete(key);
  }
}

/**
 * Plaid answered that it has no key by that id. What exactly it answers is UNVERIFIED (research's
 * list), so any 4xx counts, except a rate limit and a refusal of our own keys: those say nothing
 * about the `kid`, so they aren't remembered. Either way the webhook is a 503.
 */
function isUnknownKid(err: unknown): boolean {
  if (!(err instanceof PlaidApiError)) return false;
  if (err.status < 400 || err.status >= 500 || err.status === 429) return false;
  if (err.errorCode === 'INVALID_API_KEYS' || err.errorType === 'RATE_LIMIT_EXCEEDED') return false;
  return classifyPlaidError(err) === 'other';
}
