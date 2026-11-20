import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { PlaidConfig } from '../../config.js';
import { FakeClock } from '../../core/clock.js';
import { FAKE_PLAID_CLIENT_ID, FAKE_PLAID_ERRORS, FAKE_PLAID_SECRET, FakePlaid } from '../../test/fakePlaid.js';
import { PlaidClient } from './client.js';
import {
  KEY_FETCHES_PER_MINUTE, KEY_RECHECK_MS, PLAID_KEY_FETCHES_PER_MINUTE, PLAID_WEBHOOK_IPS, KEY_RECHECK_RETRY_MS, PlaidKeyUnavailable, PlaidWebhookVerifier, REPLAY_WINDOW_MS, UNKNOWN_KID_TTL_MS,
  WEBHOOK_MAX_AGE_SEC, WEBHOOK_MAX_SKEW_SEC,
} from './webhookVerify.js';

// Everything here is synthetic: the keys, the Item ids, and the webhooks.
const ORIGIN = 'https://plaid.test';
const config: PlaidConfig = {
  clientId: FAKE_PLAID_CLIENT_ID, secret: FAKE_PLAID_SECRET, env: 'sandbox', apiBaseUrl: ORIGIN,
  linkScriptUrl: 'https://cdn.plaid.com/link/v2/stable/link-initialize.js',
};
const PAYLOAD = { webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item-synthetic', environment: 'sandbox' };
const KEY_PATH = '/webhook_verification_key/get';

function setup(opts: { maxUnknownKids?: number } = {}) {
  const clock = new FakeClock(new Date('2026-11-15T12:00:00Z'));
  const fake = new FakePlaid();
  fake.origin = ORIGIN;
  fake.now = () => clock.now().getTime();
  const client = new PlaidClient(config, fake.fetch, { sleep: async () => {} });
  const verifier = new PlaidWebhookVerifier({ client, clock, maxUnknownKids: opts.maxUnknownKids });
  const verify = (signed: { body: string; headers: Record<string, string> }, ip = '192.0.2.1') =>
    verifier.verify(Buffer.from(signed.body, 'utf8'), signed.headers, ip);
  return { clock, fake, verifier, verify };
}

/** Documentation addresses (RFC 5737), one per sender. */
const ipNo = (n: number) => `198.51.100.${n}`;

/** P-256's group order. For any ECDSA signature (r, s), (r, n - s) verifies too. */
const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

/** The same JWT with its ES256 signature's `s` replaced by `n - s`. */
function highS(jwt: string): string {
  const [h, p, s] = jwt.split('.') as [string, string, string];
  const sig = Buffer.from(s, 'base64url');
  const other = (P256_N - BigInt(`0x${sig.subarray(32).toString('hex')}`)).toString(16).padStart(64, '0');
  return `${h}.${p}.${Buffer.concat([sig.subarray(0, 32), Buffer.from(other, 'hex')]).toString('base64url')}`;
}

/** The same JWT with the low bit of its last base64url character flipped: 64 bytes leave 4 unused bits there. */
function flipPaddingBit(jwt: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(jwt.at(-1)!);
  return jwt.slice(0, -1) + alphabet[last ^ 1]!;
}

/** A kid Plaid said it doesn't know: a 503, so a real one Plaid hasn't published yet is retried. */
const UNKNOWN = { name: 'PlaidKeyUnavailable', reason: 'unknown_kid' };

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('PlaidWebhookVerifier', () => {
  it('accepts a webhook Plaid signed, and gives back its parsed body and kid', async () => {
    const { fake, verify } = setup();
    const result = await verify(fake.signWebhook(PAYLOAD));
    expect(result).toEqual({ ok: true, payload: PAYLOAD, kid: fake.webhookKid, replay: false, delivery: expect.any(String) });
    expect(fake.lastBody(KEY_PATH)).toEqual({ key_id: fake.webhookKid });
  });

  it('finds the header whatever its case (HTTP/2 sends it lowercase), in Headers or a plain record', async () => {
    const { fake, verifier } = setup();
    const signed = fake.signWebhook(PAYLOAD);
    const jwt = signed.headers['Plaid-Verification']!;
    const body = Buffer.from(signed.body);
    expect(await verifier.verify(body, { 'plaid-verification': jwt })).toMatchObject({ ok: true });
    expect(await verifier.verify(body, { 'PLAID-VERIFICATION': jwt })).toMatchObject({ ok: true });
    expect(await verifier.verify(body, new Headers({ 'plaid-verification': jwt }))).toMatchObject({ ok: true });
  });

  it('refuses a missing or malformed header without asking Plaid for a key', async () => {
    const { fake, verifier, verify } = setup();
    const body = Buffer.from(JSON.stringify(PAYLOAD));
    expect(await verifier.verify(body, {})).toEqual({ ok: false, reason: 'missing', kid: null });
    expect(await verifier.verify(body, { 'plaid-verification': 'not a jwt' })).toMatchObject({ ok: false, reason: 'malformed' });
    expect(await verifier.verify(body, { 'plaid-verification': 'a.b.c' })).toMatchObject({ ok: false, reason: 'malformed' });
    // A kid that couldn't be Plaid's (too long, odd characters) is never sent to Plaid.
    expect(await verify(fake.signWebhook(PAYLOAD, { kid: 'x'.repeat(300) }))).toMatchObject({ ok: false, reason: 'malformed' });
    expect(await verify(fake.signWebhook(PAYLOAD, { kid: '../../etc' }))).toMatchObject({ ok: false, reason: 'malformed' });
    expect(fake.count(KEY_PATH)).toBe(0);
  });

  it('refuses any alg but ES256, none included, before fetching a key', async () => {
    const { fake, verify } = setup();
    expect(await verify(fake.signWebhook(PAYLOAD, { alg: 'none' }))).toMatchObject({ ok: false, reason: 'alg' });
    expect(await verify(fake.signWebhook(PAYLOAD, { alg: 'HS256' }))).toMatchObject({ ok: false, reason: 'alg' });
    expect(await verify(fake.signWebhook(PAYLOAD, { alg: 'ES384' }))).toMatchObject({ ok: false, reason: 'alg' });
    expect(fake.count(KEY_PATH)).toBe(0);
  });

  it('refuses a signature made with another key under a real kid', async () => {
    const { fake, verify } = setup();
    const forger = new FakePlaid();
    expect(await verify(forger.signWebhook(PAYLOAD, { kid: fake.webhookKid }))).toMatchObject({ ok: false, reason: 'signature', kid: fake.webhookKid });
  });

  it('refuses a body changed by one byte, or re-serialized, since the hash is over the exact bytes', async () => {
    const { fake, verifier } = setup();
    const signed = fake.signWebhook(PAYLOAD);
    const changed = signed.body.replace('item-synthetic', 'item-synthetiC');
    expect(changed.length).toBe(signed.body.length);
    expect(await verifier.verify(Buffer.from(changed), signed.headers)).toMatchObject({ ok: false, reason: 'body_hash' });
    // The same JSON without Plaid's 2-space indents is other bytes.
    expect(await verifier.verify(Buffer.from(JSON.stringify(PAYLOAD)), signed.headers)).toMatchObject({ ok: false, reason: 'body_hash' });
    expect(await verifier.verify(Buffer.from(signed.body), signed.headers)).toMatchObject({ ok: true });
  });

  it('takes the hash in either case, and refuses a hash that is not a SHA-256', async () => {
    const { fake, verify } = setup();
    const body = JSON.stringify(PAYLOAD);
    const { createHash } = await import('node:crypto');
    const upper = createHash('sha256').update(body).digest('hex').toUpperCase();
    expect(await verify(fake.signWebhook(body, { bodySha256: upper }))).toMatchObject({ ok: true });
    expect(await verify(fake.signWebhook(body, { bodySha256: 'abc' }))).toMatchObject({ ok: false, reason: 'body_hash' });
  });

  it('allows an iat up to 5 minutes old and 30 seconds ahead, and refuses beyond either', async () => {
    const { clock, fake, verify } = setup();
    const now = Math.floor(clock.now().getTime() / 1000);
    expect(await verify(fake.signWebhook(PAYLOAD, { iat: now - WEBHOOK_MAX_AGE_SEC }))).toMatchObject({ ok: true });
    expect(await verify(fake.signWebhook(PAYLOAD, { iat: now - WEBHOOK_MAX_AGE_SEC - 1 }))).toMatchObject({ ok: false, reason: 'stale' });
    expect(await verify(fake.signWebhook(PAYLOAD, { iat: now + WEBHOOK_MAX_SKEW_SEC }))).toMatchObject({ ok: true });
    expect(await verify(fake.signWebhook(PAYLOAD, { iat: now + WEBHOOK_MAX_SKEW_SEC + 1 }))).toMatchObject({ ok: false, reason: 'future' });
  });

  it('refuses an iat that is not a number', async () => {
    const { clock, fake, verify } = setup();
    const now = Math.floor(clock.now().getTime() / 1000);
    for (const iat of [String(now), null, [now]]) {
      expect(await verify(fake.signWebhook(PAYLOAD, { claims: { iat } })), JSON.stringify(iat)).toMatchObject({ ok: false, reason: 'malformed' });
    }
  });

  it('checks exp and nbf when Plaid sends them, with the same 30 seconds of skew', async () => {
    const { clock, fake, verify } = setup();
    const now = Math.floor(clock.now().getTime() / 1000);
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 1 }, { claims: { exp: now + 60, nbf: now - 60 } }))).toMatchObject({ ok: true });
    // Inside the skew either way: a clock a few seconds off Plaid's mustn't drop the webhook.
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 2 }, { claims: { exp: now - 10 } }))).toMatchObject({ ok: true });
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 3 }, { claims: { nbf: now + 10 } }))).toMatchObject({ ok: true });
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 4 }, { claims: { exp: now - WEBHOOK_MAX_SKEW_SEC - 1 } }))).toMatchObject({ ok: false, reason: 'stale' });
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 5 }, { claims: { nbf: now + WEBHOOK_MAX_SKEW_SEC + 1 } }))).toMatchObject({ ok: false, reason: 'future' });
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 6 }, { claims: { exp: 'soon' } }))).toMatchObject({ ok: false, reason: 'malformed' });
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 7 }, { claims: { nbf: 'later' } }))).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('refuses a body that verifies but is not a JSON object', async () => {
    const { fake, verify } = setup();
    expect(await verify(fake.signWebhook('[1, 2]'))).toMatchObject({ ok: false, reason: 'body' });
    expect(await verify(fake.signWebhook('not json'))).toMatchObject({ ok: false, reason: 'body' });
  });

  it('caches keys by kid: one fetch for many webhooks', async () => {
    const { fake, verify } = setup();
    for (let i = 0; i < 5; i++) expect(await verify(fake.signWebhook({ ...PAYLOAD, n: i }))).toMatchObject({ ok: true });
    expect(fake.count(KEY_PATH)).toBe(1);
  });

  it('fetches one key once when webhooks with a new kid arrive together', async () => {
    const { fake, verify } = setup();
    const results = await Promise.all([1, 2, 3].map((n) => verify(fake.signWebhook({ ...PAYLOAD, n }))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(fake.count(KEY_PATH)).toBe(1);
  });

  it('follows a key rotation: the new kid is fetched, and the old one still verifies until it expires', async () => {
    const { clock, fake, verify } = setup();
    const oldKid = fake.webhookKid;
    const old = fake.signWebhook(PAYLOAD);
    expect(await verify(old)).toMatchObject({ ok: true, kid: oldKid });
    const newKid = fake.rotateKey();
    expect(newKid).not.toBe(oldKid);
    // A minute on: one address gets one new kid fetched a minute (see the per-IP budget below).
    clock.advance(60_000);
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 1 }))).toMatchObject({ ok: true, kid: newKid });
    expect(await verify(old)).toMatchObject({ ok: true, kid: oldKid });
    expect(fake.count(KEY_PATH)).toBe(2);
  });

  it("refuses a webhook signed with a key whose expired_at has passed, once it's past", async () => {
    const { clock, fake, verify } = setup();
    const kid = fake.webhookKid;
    const at = Math.floor(clock.now().getTime() / 1000) + 60;
    fake.expireKey(kid, at);
    expect(await verify(fake.signWebhook(PAYLOAD))).toMatchObject({ ok: true });
    clock.advance(60_000);
    expect(await verify(fake.signWebhook(PAYLOAD))).toEqual({ ok: false, reason: 'key_expired', kid });
    expect(fake.count(KEY_PATH)).toBe(1);
  });

  it('refuses a key that had already expired when it was first fetched', async () => {
    const { clock, fake, verify } = setup();
    const kid = fake.webhookKid;
    fake.expireKey(kid, Math.floor(clock.now().getTime() / 1000) - 1);
    expect(await verify(fake.signWebhook(PAYLOAD))).toEqual({ ok: false, reason: 'key_expired', kid });
  });

  it('is a 503 for a kid Plaid does not know, so a real new key gets retries, and remembers it for 10 minutes', async () => {
    const { clock, fake, verify } = setup();
    const forged = fake.signWebhook(PAYLOAD, { kid: 'kid-nobody-issued' });
    const err = await caught(verify(forged));
    expect(err).toBeInstanceOf(PlaidKeyUnavailable);
    expect(err).toMatchObject({ reason: 'unknown_kid', errorCode: 'INVALID_FIELD' });
    expect(await caught(verify(forged))).toMatchObject(UNKNOWN);
    expect(fake.count(KEY_PATH)).toBe(1);
    clock.advance(UNKNOWN_KID_TTL_MS);
    expect(await caught(verify(forged))).toMatchObject(UNKNOWN);
    expect(fake.count(KEY_PATH)).toBe(2);
  });

  it('fetches at most 10 new kids a minute in all: past that a webhook is a 503 (PlaidKeyUnavailable), never refused', async () => {
    const { clock, fake, verify } = setup();
    const known = fake.signWebhook(PAYLOAD);
    expect(await verify(known, ipNo(0))).toMatchObject({ ok: true });
    for (let i = 1; i < KEY_FETCHES_PER_MINUTE; i++) {
      expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: `forged-${i}` }), ipNo(i)))).toMatchObject(UNKNOWN);
    }
    expect(fake.count(KEY_PATH)).toBe(KEY_FETCHES_PER_MINUTE);
    // A real webhook under a new kid, in the same minute, from a sender with budget left, must be
    // retried by Plaid, not dropped.
    fake.rotateKey();
    const real = fake.signWebhook({ ...PAYLOAD, n: 1 });
    const err = await caught(verify(real, ipNo(50)));
    expect(err).toBeInstanceOf(PlaidKeyUnavailable);
    expect(err).toMatchObject({ reason: 'limited' });
    expect(fake.count(KEY_PATH)).toBe(KEY_FETCHES_PER_MINUTE);
    // Kids already cached, or already known to be unknown, still answer.
    expect(await verify(known, ipNo(50))).toMatchObject({ ok: true });
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'forged-1' }), ipNo(50)))).toMatchObject(UNKNOWN);
    clock.advance(60_000);
    expect(await verify(real, ipNo(50))).toMatchObject({ ok: true, replay: false });
  });

  it('fetches at most one new kid a minute per client IP, without spending the budget of others', async () => {
    const { clock, fake, verify } = setup();
    const sender = ipNo(7);
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'forged-a' }), sender))).toMatchObject(UNKNOWN);
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'forged-b' }), sender))).toMatchObject({ name: 'PlaidKeyUnavailable', reason: 'limited' });
    expect(fake.count(KEY_PATH)).toBe(1);
    // Plaid, from its own address, still gets its new key fetched in the same minute.
    expect(await verify(fake.signWebhook(PAYLOAD), ipNo(8))).toMatchObject({ ok: true });
    expect(fake.count(KEY_PATH)).toBe(2);
    // The refused attempt cost the overall budget nothing: 8 more senders still fetch.
    for (let i = 10; i < 18; i++) {
      expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: `forged-${i}` }), ipNo(i)))).toMatchObject(UNKNOWN);
    }
    expect(fake.count(KEY_PATH)).toBe(KEY_FETCHES_PER_MINUTE);
    // A kid already known to be unknown answers from memory, whatever the budget.
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'forged-a' }), sender))).toMatchObject(UNKNOWN);
    clock.advance(60_000);
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'forged-b' }), sender))).toMatchObject(UNKNOWN);
    expect(fake.count(KEY_PATH)).toBe(KEY_FETCHES_PER_MINUTE + 1);
  });

  it("keeps a reserved budget for Plaid's documented webhook addresses that other senders can't use up", async () => {
    const { clock, fake, verify } = setup();
    // Ten other senders spend the whole shared budget on forged kids.
    for (let i = 0; i < KEY_FETCHES_PER_MINUTE; i++) {
      expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: `forged-${i}` }), ipNo(i)))).toMatchObject(UNKNOWN);
    }
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'forged-x' }), ipNo(99)))).toMatchObject({ name: 'PlaidKeyUnavailable', reason: 'limited' });
    // Plaid, from its own address, still gets its new key fetched, and more than one a minute.
    const [plaidIp, otherPlaidIp] = PLAID_WEBHOOK_IPS;
    expect(await verify(fake.signWebhook(PAYLOAD), plaidIp)).toMatchObject({ ok: true });
    fake.rotateKey();
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 1 }), plaidIp)).toMatchObject({ ok: true });
    expect(fake.count(KEY_PATH)).toBe(KEY_FETCHES_PER_MINUTE + 2);
    // Its budget is its own, and limited too: Plaid's addresses can't fetch without end.
    for (let i = 2; i < PLAID_KEY_FETCHES_PER_MINUTE; i++) {
      expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: `plaid-${i}` }), otherPlaidIp))).toMatchObject(UNKNOWN);
    }
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'plaid-x' }), otherPlaidIp))).toMatchObject({ name: 'PlaidKeyUnavailable', reason: 'limited' });
    clock.advance(60_000);
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'forged-x' }), ipNo(99)))).toMatchObject(UNKNOWN);
  });

  it('counts IPv6 senders by their /64, and an IPv4-mapped address as its IPv4 address', async () => {
    const { fake, verify } = setup();
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'forged-a' }), '2001:db8:1:2::1'))).toMatchObject(UNKNOWN);
    // Another address in the same /64, however it's written, shares the budget.
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'forged-b' }), '2001:DB8:1:2:ffff:0:0:9'))).toMatchObject({ reason: 'limited' });
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'forged-c' }), '2001:0db8:0001:0002::abcd'))).toMatchObject({ reason: 'limited' });
    // The next /64 has its own.
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'forged-d' }), '2001:db8:1:3::1'))).toMatchObject(UNKNOWN);
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'forged-e' }), '198.51.100.40'))).toMatchObject(UNKNOWN);
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'forged-f' }), '::ffff:198.51.100.40'))).toMatchObject({ reason: 'limited' });
    // A Plaid address mapped into IPv6 is still Plaid's.
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'forged-g' }), `::ffff:${PLAID_WEBHOOK_IPS[0]}`))).toMatchObject(UNKNOWN);
    expect(await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'forged-h' }), `::ffff:${PLAID_WEBHOOK_IPS[0]}`))).toMatchObject(UNKNOWN);
  });

  it('sweeps unknown kids past their 10 minutes whenever one is added, and caps how many it keeps, dropping the oldest', async () => {
    const { clock, fake, verifier, verify } = setup({ maxUnknownKids: 3 });
    for (let i = 1; i <= 2; i++) await caught(verify(fake.signWebhook(PAYLOAD, { kid: `old-${i}` }), ipNo(i)));
    expect(verifier.unknownKidCount).toBe(2);
    clock.advance(UNKNOWN_KID_TTL_MS);
    await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'new-1' }), ipNo(1)));
    expect(verifier.unknownKidCount).toBe(1);
    for (let i = 2; i <= 4; i++) await caught(verify(fake.signWebhook(PAYLOAD, { kid: `new-${i}` }), ipNo(i)));
    expect(verifier.unknownKidCount).toBe(3);
    const fetched = fake.count(KEY_PATH);
    // new-1, the oldest, was dropped: asking for it fetches again; new-4 is still remembered.
    await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'new-4' }), ipNo(9)));
    expect(fake.count(KEY_PATH)).toBe(fetched);
    await caught(verify(fake.signWebhook(PAYLOAD, { kid: 'new-1' }), ipNo(9)));
    expect(fake.count(KEY_PATH)).toBe(fetched + 1);
  });

  it('fetches a cached key again a day after it was fetched, so an expired_at Plaid sets later is honored', async () => {
    const { clock, fake, verify } = setup();
    const kid = fake.webhookKid;
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 1 }))).toMatchObject({ ok: true });
    const fetchedAt = Math.floor(clock.now().getTime() / 1000);
    // Plaid retires the key after we cached it, as of a day and a minute after we fetched it.
    fake.expireKey(kid, fetchedAt + KEY_RECHECK_MS / 1000 + 60);
    clock.advance(KEY_RECHECK_MS - 1000);
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 2 }))).toMatchObject({ ok: true });
    expect(fake.count(KEY_PATH)).toBe(1);
    clock.advance(1000);
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 3 }))).toMatchObject({ ok: true });
    expect(fake.count(KEY_PATH)).toBe(2);
    clock.advance(60_000);
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 4 }))).toEqual({ ok: false, reason: 'key_expired', kid });
    expect(fake.count(KEY_PATH)).toBe(2);
  });

  it('keeps the cached key when the daily recheck fails, and asks again 10 minutes later', async () => {
    const { clock, fake, verify } = setup();
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 1 }))).toMatchObject({ ok: true });
    clock.advance(KEY_RECHECK_MS);
    for (let i = 0; i < 3; i++) fake.failNext(KEY_PATH, FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 2 }))).toMatchObject({ ok: true });
    expect(fake.count(KEY_PATH)).toBe(4); // the first fetch, and the client's 3 tries
    clock.advance(KEY_RECHECK_RETRY_MS - 1000);
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 3 }))).toMatchObject({ ok: true });
    expect(fake.count(KEY_PATH)).toBe(4);
    // Plaid saying it doesn't know the key keeps it too: what it answers for a retired key is UNVERIFIED.
    clock.advance(1000);
    fake.failNext(KEY_PATH, { status: 400, error_type: 'INVALID_INPUT', error_code: 'INVALID_WEBHOOK_VERIFICATION_KEY_ID' });
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 4 }))).toMatchObject({ ok: true });
    expect(fake.count(KEY_PATH)).toBe(5);
    clock.advance(KEY_RECHECK_RETRY_MS);
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 5 }))).toMatchObject({ ok: true });
    expect(fake.count(KEY_PATH)).toBe(6);
    // That one worked: the next is a day away.
    clock.advance(KEY_RECHECK_RETRY_MS);
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 6 }))).toMatchObject({ ok: true });
    expect(fake.count(KEY_PATH)).toBe(6);
  });

  it('marks the same JWT accepted again within the replay window as a replay', async () => {
    const { clock, fake, verify } = setup();
    const signed = fake.signWebhook(PAYLOAD);
    expect(await verify(signed)).toEqual({ ok: true, payload: PAYLOAD, kid: fake.webhookKid, replay: false, delivery: expect.any(String) });
    expect(await verify(signed)).toEqual({ ok: true, payload: PAYLOAD, kid: fake.webhookKid, replay: true, delivery: expect.any(String) });
    clock.advance(60_000);
    expect(await verify(signed)).toMatchObject({ ok: true, replay: true });
    expect(await verify(fake.signWebhook({ ...PAYLOAD, n: 1 }))).toMatchObject({ ok: true, replay: false });
    // Two copies at once: one is new, the other a replay.
    const twin = fake.signWebhook({ ...PAYLOAD, n: 2 });
    const both = await Promise.all([verify(twin), verify(twin)]);
    expect(both.map((r) => r.ok && r.replay).sort()).toEqual([false, true]);
    // A refused request is never a replay, and doesn't count as accepted: the same JWT sent first
    // with a changed body, then with its own, is new the second time.
    const forged = new FakePlaid().signWebhook({ ...PAYLOAD, n: 3 }, { kid: fake.webhookKid });
    expect(await verify(forged)).toMatchObject({ ok: false, reason: 'signature' });
    const real = fake.signWebhook({ ...PAYLOAD, n: 4 });
    expect(await verify({ ...real, body: real.body.replace('"n": 4', '"n": 5') })).toMatchObject({ ok: false, reason: 'body_hash' });
    expect(await verify(real)).toMatchObject({ ok: true, replay: false });
    // Past the window the old JWT is stale, never a replay.
    clock.advance(REPLAY_WINDOW_MS);
    expect(await verify(signed)).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('takes two deliveries with the same body a second or more apart as two webhooks', async () => {
    const { clock, fake, verify } = setup();
    // Two SYNC_UPDATES_AVAILABLE for one Item a minute apart: the same bytes, another iat.
    const first = fake.signWebhook(PAYLOAD);
    expect(await verify(first)).toMatchObject({ ok: true, replay: false });
    clock.advance(60_000);
    const second = fake.signWebhook(PAYLOAD);
    expect(second.body).toBe(first.body);
    expect(await verify(second)).toMatchObject({ ok: true, replay: false });
    expect(await verify(second)).toMatchObject({ ok: true, replay: true });
  });

  it('folds two deliveries with the same body in the same iat second into one, whatever their signatures', async () => {
    const { fake, verify } = setup();
    // ES256 signs each one differently, but the signed header and claims are the same bytes. A
    // sync is idempotent, so taking the second as a replay costs nothing.
    const sameSecond = [fake.signWebhook(PAYLOAD), fake.signWebhook(PAYLOAD)];
    expect(sameSecond[0]!.headers['Plaid-Verification']).not.toBe(sameSecond[1]!.headers['Plaid-Verification']);
    expect(await verify(sameSecond[0]!)).toMatchObject({ ok: true, replay: false });
    expect(await verify(sameSecond[1]!)).toMatchObject({ ok: true, replay: true });
  });

  it('takes a re-encoded signature of an accepted JWT as a replay: (r, n - s), and a flipped padding bit', async () => {
    const { fake, verify } = setup();
    const signed = fake.signWebhook(PAYLOAD);
    const jwt = signed.headers['Plaid-Verification']!;
    const withJwt = (token: string) => ({ ...signed, headers: { ...signed.headers, 'Plaid-Verification': token } });
    const high = highS(jwt);
    const padded = flipPaddingBit(jwt);
    expect(high).not.toBe(jwt);
    expect(padded).not.toBe(jwt);
    expect(await verify(signed)).toMatchObject({ ok: true, replay: false });
    // Each is still a valid signature over the same input, so each verifies, and each is the same delivery.
    expect(await verify(withJwt(high))).toMatchObject({ ok: true, replay: true });
    expect(await verify(withJwt(padded))).toMatchObject({ ok: true, replay: true });
    expect(await verify(withJwt(flipPaddingBit(high)))).toMatchObject({ ok: true, replay: true });
  });

  it('lets a delivery be processed again after forget, so a retry of one that failed after verifying is not dropped', async () => {
    const { fake, verifier, verify } = setup();
    const signed = fake.signWebhook(PAYLOAD);
    const first = await verify(signed);
    expect(first).toMatchObject({ ok: true, replay: false });
    verifier.forget((first as { delivery: string }).delivery);
    expect(await verify(signed)).toMatchObject({ ok: true, replay: false });
    expect(await verify(signed)).toMatchObject({ ok: true, replay: true });
  });

  it("is a 503 (PlaidKeyUnavailable) when the key can't be fetched, and forgets nothing, so Plaid's retry verifies", async () => {
    const { fake, verify } = setup();
    for (let i = 0; i < 3; i++) fake.failNext(KEY_PATH, FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    const signed = fake.signWebhook(PAYLOAD);
    expect(await caught(verify(signed, ipNo(1)))).toMatchObject({ name: 'PlaidKeyUnavailable', reason: 'unreachable', errorCode: 'INTERNAL_SERVER_ERROR' });
    expect(fake.count(KEY_PATH)).toBe(3); // the client's own retries
    for (let i = 0; i < 3; i++) fake.dropNext(KEY_PATH);
    expect(await caught(verify(signed, ipNo(2)))).toMatchObject({ name: 'PlaidKeyUnavailable', reason: 'unreachable', errorCode: null });
    expect(await verify(signed, ipNo(3))).toMatchObject({ ok: true, replay: false });
  });

  it('is a 503, not a refusal, when Plaid refuses our own keys: a misconfiguration must not drop webhooks', async () => {
    const { fake, verify } = setup();
    fake.failNext(KEY_PATH, { status: 400, error_type: 'INVALID_INPUT', error_code: 'INVALID_API_KEYS' });
    expect(await caught(verify(fake.signWebhook(PAYLOAD)))).toMatchObject({ name: 'PlaidKeyUnavailable', errorCode: 'INVALID_API_KEYS' });
  });

  it('refuses a key Plaid serves that is not an ES256 P-256 key for that kid', async () => {
    for (const change of [{ crv: 'P-384' }, { alg: 'ES384' }, { alg: 'RS256' }, { kty: 'RSA' }, { kid: 'another-kid' }]) {
      const { fake, verify } = setup();
      const kid = fake.webhookKid;
      // Served under the webhook's kid, whatever the key itself says.
      fake.webhookKeys.set(kid, { ...fake.webhookKeys.get(kid)!, ...change });
      expect(await verify(fake.signWebhook(PAYLOAD)), JSON.stringify(change)).toEqual({ ok: false, reason: 'bad_key', kid });
    }
  });
});

describe('FakePlaid.fireWebhook', () => {
  it('posts the signed body over HTTP, byte for byte, with Plaid-Verification', async () => {
    const { fake, verifier } = setup();
    const received: { body: Buffer; header: string | undefined }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ body: Buffer.concat(chunks), header: req.headers['plaid-verification'] as string | undefined });
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fake.fireWebhook(`http://127.0.0.1:${port}/webhooks/plaid`, PAYLOAD);
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const [got] = received;
    expect(await verifier.verify(got!.body, { 'plaid-verification': got!.header })).toEqual({ ok: true, payload: PAYLOAD, kid: fake.webhookKid, replay: false, delivery: expect.any(String) });
  });
});
