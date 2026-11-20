import { asc, eq } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { PLAID_LINK_ERRORS, PLAID_MESSAGES } from '../../../shared/plaid.js';
import type { PlaidConfig } from '../../config.js';
import { decryptSecret, encryptSecret, familyRevocationAad, singleKeyring } from '../../core/crypto.js';
import { AppError } from '../../core/errors.js';
import {
  cards, connections, csvImports, pendingRevocations, plaidItems, plaidLinkPending, savingsAccounts, savingsBalances, settings, transactions, type PlaidItemAccount,
} from '../../db/schema.js';
import { putSnapshot } from '../../panels/savings/store.js';
import { addSavingsAccount, linkSavingsForTest } from '../../test/savingsFixtures.js';
import { getPlaidItemsCreated } from '../../settings.js';
import { FAKE_PLAID_CLIENT_ID, FAKE_PLAID_ERRORS, FAKE_PLAID_SECRET, FakePlaid, type FakeAccountInput, type FakeInstitution } from '../../test/fakePlaid.js';
import { addUser, makeTestApp, TEST_BASE_URL, TEST_ENCRYPTION_KEY } from '../../test/helpers.js';
import { addCard, addTransaction, categoryId, transaction } from '../../test/spendFixtures.js';
import { decryptCredentials, encryptCredentials } from '../connections.js';
import {
  BACKOFF_FIRST_MS, BACKOFF_MAX_MS, linkError, PENDING_LINK_TTL_MS, Plaid, plaidAppError, PlaidLinkRefused, REVOCATION_ATTEMPTS,
} from './plaid.js';

// Everything here is synthetic: the keys, institutions, accounts, tokens, and transactions.
const ORIGIN = 'https://plaid.test';
const ring = singleKeyring(TEST_ENCRYPTION_KEY);
const config: PlaidConfig = {
  clientId: FAKE_PLAID_CLIENT_ID, secret: FAKE_PLAID_SECRET, env: 'sandbox', apiBaseUrl: ORIGIN,
  linkScriptUrl: 'https://cdn.plaid.com/link/v2/stable/link-initialize.js',
};
const BANK: FakeInstitution = { institution_id: 'ins_fake_bank', name: 'Example Bank' };
const CARD_A: FakeAccountInput = { name: 'Example Rewards', mask: '1111' };
const CARD_B: FakeAccountInput = { name: 'Example Cash Back', mask: '2222' };

/** Collects log lines, parsed, with the raw text kept to check nothing secret was written. */
function logLines() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const logger = pino({ level: 'debug' }, { write: (l: string) => { raw.push(l); lines.push(JSON.parse(l) as Record<string, unknown>); } });
  return { lines, raw, logger };
}

function setup(opts: { keyMismatch?: boolean; t?: ReturnType<typeof makeTestApp>; fake?: FakePlaid; admin?: number } = {}) {
  const t = opts.t ?? makeTestApp();
  const admin = opts.admin ?? addUser(t.db, t.clock, { email: 'alex@example.com', displayName: 'Alex', role: 'admin' });
  const fake = opts.fake ?? new FakePlaid();
  fake.origin = ORIGIN;
  fake.now = () => t.clock.now().getTime();
  const log = logLines();
  const plaid = new Plaid({
    db: t.db, clock: t.clock, logger: log.logger, keyring: ring, fetch: fake.fetch, config, baseUrl: TEST_BASE_URL,
    keyMismatch: opts.keyMismatch, clientOptions: { sleep: async () => {} },
  });
  return { t, admin, fake, plaid, log };
}
type Setup = ReturnType<typeof setup>;

/** The admin goes through Link (the fake's) and the exchange, in session `session`. */
async function link(s: Setup, opts: { institution?: FakeInstitution | null; accounts?: FakeAccountInput[]; session?: string } = {}) {
  const session = opts.session ?? 'session-a';
  const { linkToken } = await s.plaid.createLinkToken(s.admin, session, {});
  const { publicToken, metadata } = s.fake.completeLink(linkToken, { institution: opts.institution === undefined ? BANK : opts.institution, accounts: opts.accounts ?? [CARD_A] });
  const { itemId } = await s.plaid.exchange(s.admin, session, publicToken, metadata);
  const row = s.plaid.item(itemId)!;
  return { itemId, row, fakeItem: s.fake.item(row.plaidItemId), metadata, publicToken };
}

function connectionOf(s: Setup, itemId: number) {
  const item = s.plaid.item(itemId)!;
  return item.connectionId === null ? undefined : s.t.db.select().from(connections).where(eq(connections.id, item.connectionId)).get();
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('link tokens and the pending link', () => {
  it("asks for a new Item's link token as the design says, with a random per-install client_user_id", async () => {
    const s = setup();
    const { linkToken, mode, itemId } = await s.plaid.createLinkToken(s.admin, 'session-a', {});
    expect({ mode, itemId }).toEqual({ mode: 'new', itemId: null });
    const body = s.fake.lastBody('/link/token/create')!;
    const userId = s.t.db.select().from(settings).where(eq(settings.key, 'plaid_client_user_id')).get()!.value;
    expect(userId).toMatch(/^[0-9a-f]{32}$/);
    expect(body).toEqual({
      client_name: 'Family Dashboard',
      language: 'en',
      country_codes: ['US'],
      user: { client_user_id: userId },
      products: ['transactions'],
      required_if_supported_products: ['liabilities'],
      transactions: { days_requested: 730 },
      account_filters: { credit: { account_subtypes: ['credit card'] } },
      webhook: `${TEST_BASE_URL}/webhooks/plaid`,
      redirect_uri: `${TEST_BASE_URL}/connect/plaid/oauth-return`,
    });
    // The same id every time.
    await s.plaid.createLinkToken(s.admin, 'session-a', {});
    expect((s.fake.lastBody('/link/token/create')!.user as { client_user_id: string }).client_user_id).toBe(userId);

    const row = s.t.db.select().from(plaidLinkPending).get()!;
    expect(row).toMatchObject({ userId: s.admin, sessionHash: 'session-a', mode: 'new', plaidItemId: null, addAccounts: false });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(PENDING_LINK_TTL_MS);
    expect(linkToken).not.toBe(row.linkToken); // the second token replaced the first
  });

  it('resumes only in the same session, until it expires, for the OAuth return page', async () => {
    const s = setup();
    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', {});
    expect(s.plaid.resume(s.admin, 'session-a')).toEqual({ linkToken, mode: 'new', itemId: null, purpose: 'spend' });
    expect(() => s.plaid.resume(s.admin, 'session-b')).toThrow(PLAID_MESSAGES.linkExpired);
    const other = addUser(s.t.db, s.t.clock, { email: 'jordan@example.com', role: 'admin' });
    expect(() => s.plaid.resume(other, 'session-a')).toThrow(PlaidLinkRefused);
    s.t.clock.advance(PENDING_LINK_TTL_MS);
    expect(() => s.plaid.resume(s.admin, 'session-a')).toThrow(PLAID_MESSAGES.linkExpired);
    expect(s.plaid.prunePending()).toBe(1);
  });

  it("asks for update mode with the Item's access token and redirect URI only, and Account Select for Add accounts", async () => {
    const s = setup();
    const { itemId, fakeItem } = await link(s);
    expect(await s.plaid.createLinkToken(s.admin, 'session-b', { itemId })).toMatchObject({ mode: 'update', itemId });
    const base = {
      client_name: 'Family Dashboard', language: 'en', country_codes: ['US'], user: expect.any(Object),
      access_token: fakeItem.accessToken, redirect_uri: `${TEST_BASE_URL}/connect/plaid/oauth-return`,
    };
    expect(s.fake.lastBody('/link/token/create')).toEqual(base);
    expect(s.t.db.select().from(plaidLinkPending).get()).toMatchObject({ mode: 'update', plaidItemId: itemId, addAccounts: false, sessionHash: 'session-b' });

    await s.plaid.createLinkToken(s.admin, 'session-b', { itemId, addAccounts: true });
    expect(s.fake.lastBody('/link/token/create')).toEqual({
      ...base, update: { account_selection_enabled: true }, account_filters: { credit: { account_subtypes: ['credit card'] } },
    });
    expect(s.t.db.select().from(plaidLinkPending).get()).toMatchObject({ addAccounts: true });
  });

  it('refuses update mode for an Item that is removed or unknown', async () => {
    const s = setup();
    const { itemId } = await link(s);
    await s.plaid.remove(s.admin, itemId, { deleteTransactions: false });
    expect(await caught(s.plaid.createLinkToken(s.admin, 's', { itemId }))).toMatchObject({ code: 'not_found', link: 'failed' });
    expect(await caught(s.plaid.createLinkToken(s.admin, 's', { itemId: 999 }))).toMatchObject({ code: 'not_found' });
  });

  it("turns Plaid's refusals into plain messages, Trial limit first", async () => {
    const s = setup();
    s.fake.failNext('/link/token/create', FAKE_PLAID_ERRORS.TRIAL_CONNECTION_LIMIT);
    const err = await caught(s.plaid.createLinkToken(s.admin, 's', {}));
    expect(err).toMatchObject({ link: 'trial_limit', message: PLAID_MESSAGES.trialLimit });
    expect(s.fake.count('/link/token/create')).toBe(1); // never retried
    s.fake.failNext('/link/token/create', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    expect(await caught(s.plaid.createLinkToken(s.admin, 's', {}))).toMatchObject({ link: 'failed', message: PLAID_MESSAGES.unreachable });
    // A bank Plaid can't link for us yet, or at all, says so, though it isn't retried.
    for (const error_code of ['INSTITUTION_REGISTRATION_REQUIRED', 'UNAUTHORIZED_INSTITUTION']) {
      s.fake.failNext('/link/token/create', { status: 400, error_type: 'INSTITUTION_ERROR', error_code });
      expect(await caught(s.plaid.createLinkToken(s.admin, 's', {})), error_code).toMatchObject({ link: 'institution', message: PLAID_MESSAGES.institution });
    }
    expect(s.fake.count('/link/token/create')).toBe(4);
    expect(s.t.db.select().from(plaidLinkPending).all()).toEqual([]);
  });

  it('cancels (exit) only the same session, and names what went wrong', async () => {
    const s = setup();
    await s.plaid.createLinkToken(s.admin, 'session-a', {});
    expect(s.plaid.exit(s.admin, 'session-b', null)).toEqual({ itemId: null, error: 'expired', purpose: 'spend' });
    expect(s.t.db.select().from(plaidLinkPending).all()).toHaveLength(1);
    expect(s.plaid.exit(s.admin, 'session-a', null)).toEqual({ itemId: null, error: 'exited', purpose: 'spend' });
    expect(s.t.db.select().from(plaidLinkPending).all()).toEqual([]);
    for (const [code, error] of [['TRIAL_CONNECTION_LIMIT', 'trial_limit'], ['INSTITUTION_DOWN', 'institution'], ['UNAUTHORIZED_INSTITUTION', 'institution'], ['INVALID_CREDENTIALS', 'failed'], ['not a code!', 'failed']] as const) {
      await s.plaid.createLinkToken(s.admin, 'session-a', {});
      expect(s.plaid.exit(s.admin, 'session-a', code).error).toBe(error);
    }
    expect(Object.keys(PLAID_LINK_ERRORS)).toContain('exited');
  });
});

describe('the exchange', () => {
  it('stores the Item as a family connection bound to its row, with what /item/get and /accounts/get say', async () => {
    const s = setup();
    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', {});
    const { publicToken, metadata } = s.fake.completeLink(linkToken, { institution: BANK, accounts: [CARD_A, { ...CARD_B, official_name: 'Example Cash Back Card' }] });
    const fakeItem = [...s.fake.items.values()].at(-1)!;
    s.fake.setConsentExpiration(fakeItem.itemId, '2027-11-15T12:00:00Z');
    const { itemId } = await s.plaid.exchange(s.admin, 'session-a', publicToken, metadata);

    const row = s.plaid.item(itemId)!;
    expect(row).toMatchObject({
      plaidItemId: fakeItem.itemId, institutionId: 'ins_fake_bank', institutionName: 'Example Bank', consentExpirationTime: '2027-11-15T12:00:00Z',
      cursor: null, pickedAt: null, removedAt: null,
    });
    expect(row.accounts).toEqual(fakeItem.accounts.map((a) => ({
      accountId: a.account_id, name: a.name, officialName: a.official_name, mask: a.mask, type: 'credit', subtype: 'credit card',
      isoCurrencyCode: 'USD', unofficialCurrencyCode: null,
    })));
    const conn = connectionOf(s, itemId)!;
    expect(conn).toMatchObject({ kind: 'plaid', scope: 'family', ownerUserId: s.admin, status: 'ok', meta: { itemId: fakeItem.itemId, institutionName: 'Example Bank' } });
    expect(conn.credentialsEnc).not.toContain(fakeItem.accessToken!);
    expect(decryptCredentials(ring, conn)).toEqual({ accessToken: fakeItem.accessToken });
    // Bound to the row: moved to another row, it doesn't decrypt.
    expect(() => decryptCredentials(ring, { ...conn, id: conn.id + 1 })).toThrow();

    expect(s.plaid.trialCount()).toBe(1);
    expect(s.t.db.select().from(plaidLinkPending).all()).toEqual([]);
    // The pending link is used up.
    expect(await caught(s.plaid.exchange(s.admin, 'session-a', publicToken, metadata))).toMatchObject({ link: 'expired' });
  });

  it('exchanges only for the session that started the link, before it expires', async () => {
    const s = setup();
    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', {});
    const { publicToken, metadata } = s.fake.completeLink(linkToken, { institution: BANK, accounts: [CARD_A] });
    expect(await caught(s.plaid.exchange(s.admin, 'session-b', publicToken, metadata))).toMatchObject({ code: 'not_found', link: 'expired' });
    const other = addUser(s.t.db, s.t.clock, { email: 'jordan@example.com', role: 'admin' });
    expect(await caught(s.plaid.exchange(other, 'session-a', publicToken, metadata))).toMatchObject({ link: 'expired' });
    expect(s.fake.count('/item/public_token/exchange')).toBe(0);
    // The right session's link is still waiting.
    expect(s.t.db.select().from(plaidLinkPending).all()).toHaveLength(1);
    s.t.clock.advance(PENDING_LINK_TTL_MS);
    expect(await caught(s.plaid.exchange(s.admin, 'session-a', publicToken, metadata))).toMatchObject({ link: 'expired' });
    expect(s.fake.count('/item/public_token/exchange')).toBe(0);
  });

  it("refuses an update-mode link's exchange", async () => {
    const s = setup();
    const { itemId } = await link(s);
    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', { itemId });
    const { publicToken, metadata } = s.fake.completeLink(linkToken);
    expect(await caught(s.plaid.exchange(s.admin, 'session-a', publicToken, metadata))).toMatchObject({ link: 'expired' });
    expect(s.fake.count('/item/public_token/exchange')).toBe(1);
  });

  it('leaves a pending link alone when a call of the other mode is refused, and deletes one that expired when it is claimed', async () => {
    const s = setup();
    const { itemId } = await link(s);
    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', { itemId });
    const { publicToken, metadata } = s.fake.completeLink(linkToken);
    // A new-mode exchange against an update-mode pending link: refused, and the link is still there.
    expect(await caught(s.plaid.exchange(s.admin, 'session-a', publicToken, metadata))).toMatchObject({ link: 'expired' });
    expect(s.t.db.select().from(plaidLinkPending).all()).toHaveLength(1);
    expect(await s.plaid.completeUpdate(s.admin, 'session-a')).toMatchObject({ itemId });

    await s.plaid.createLinkToken(s.admin, 'session-a', { itemId });
    s.t.clock.advance(PENDING_LINK_TTL_MS);
    expect(await caught(s.plaid.completeUpdate(s.admin, 'session-a'))).toMatchObject({ link: 'expired' });
    expect(s.t.db.select().from(plaidLinkPending).all()).toEqual([]);
  });

  describe('the duplicate check', () => {
    it('refuses the same login at the same bank without exchanging, naming the connection', async () => {
      const s = setup();
      await link(s, { accounts: [CARD_A, CARD_B] });
      const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', {});
      // Plaid makes a new Item with new account ids, but the same names and masks (research §4.1).
      const { publicToken, metadata } = s.fake.completeLink(linkToken, { institution: BANK, accounts: [{ ...CARD_B }] });
      const err = await caught(s.plaid.exchange(s.admin, 'session-a', publicToken, metadata));
      expect(err).toMatchObject({ code: 'conflict', link: 'duplicate', message: PLAID_MESSAGES.duplicate('Example Bank') });
      expect(s.fake.count('/item/public_token/exchange')).toBe(1);
      expect(s.plaid.trialCount()).toBe(1);
      expect(s.t.db.select().from(plaidItems).all()).toHaveLength(1);
      expect(s.log.lines.some((l) => l.msg === 'plaid link refused: a duplicate')).toBe(true);
    });

    it("allows another login at the same bank (other cards), a removed Item's login, and metadata with no institution", async () => {
      const s = setup();
      const first = await link(s, { accounts: [CARD_A] });
      // A spouse's cards at the same bank.
      await link(s, { accounts: [{ name: 'Example Rewards', mask: '9999' }] });
      // Same mask, another name, isn't the same account either.
      await link(s, { accounts: [{ name: 'Example Travel', mask: '1111' }] });
      // Another bank with the same card names.
      await link(s, { institution: { institution_id: 'ins_other', name: 'Other Bank' }, accounts: [CARD_A] });
      await s.plaid.remove(s.admin, first.itemId, { deleteTransactions: false });
      await link(s, { accounts: [CARD_A] });
      // Nothing to compare: the link goes ahead.
      await link(s, { institution: null, accounts: [CARD_A] });
      expect(s.plaid.trialCount()).toBe(6);
    });
  });

  it('counts every Item Plaid created, removed ones included, and never lowers the count', async () => {
    const s = setup();
    const { itemId } = await link(s);
    await s.plaid.remove(s.admin, itemId, { deleteTransactions: false });
    expect(s.plaid.trialCount()).toBe(1);
    await link(s, { accounts: [CARD_B] });
    expect(s.plaid.trialCount()).toBe(2);
    expect(getPlaidItemsCreated(s.t.db)).toBe(s.fake.itemsCreated);
  });

  it("doesn't count a refused exchange, and says when Plaid's Trial has no connections left", async () => {
    const s = setup();
    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', {});
    const { publicToken, metadata } = s.fake.completeLink(linkToken, { institution: BANK, accounts: [CARD_A] });
    s.fake.trialLimit = s.fake.itemsCreated;
    const err = await caught(s.plaid.exchange(s.admin, 'session-a', publicToken, metadata));
    expect(err).toMatchObject({ link: 'trial_limit', message: PLAID_MESSAGES.trialLimit });
    expect(linkError(err)).toBe('trial_limit');
    expect(s.plaid.trialCount()).toBe(0);
    expect(s.fake.count('/item/public_token/exchange')).toBe(1);
  });

  describe('an exchange whose answer never came (review C-S-M4)', () => {
    async function linked(s: Setup) {
      const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', {});
      return s.fake.completeLink(linkToken, { institution: BANK, accounts: [CARD_A] });
    }

    it("counts against the Trial when it timed out after it was sent, since Plaid may have made the connection", async () => {
      const s = setup();
      const { publicToken, metadata } = await linked(s);
      s.fake.hangNext('/item/public_token/exchange');
      // Cut off by the request's deadline, once sent.
      const err = await caught(s.plaid.exchange(s.admin, 'session-a', publicToken, metadata, { deadline: Date.now() + 1_200 }));
      expect(err).toMatchObject({ link: 'maybe_connected', message: PLAID_LINK_ERRORS.maybe_connected });
      expect(PLAID_LINK_ERRORS.maybe_connected).toBe('Plaid may have made this connection. Check Spend settings in a minute before linking again.');
      expect(s.plaid.trialCount()).toBe(1);
      expect(s.t.db.select().from(plaidItems).all()).toEqual([]);
      expect(s.log.lines.some((l) => l.msg === 'plaid exchange may have finished; counted against the Trial')).toBe(true);
    });

    it("counts its own timeout too, with no request deadline", async () => {
      const t = makeTestApp();
      const fake = new FakePlaid();
      const s0 = setup({ t, fake });
      const s = { ...s0, plaid: new Plaid({ db: t.db, clock: t.clock, logger: s0.log.logger, keyring: ring, fetch: fake.fetch, config, baseUrl: TEST_BASE_URL, clientOptions: { sleep: async () => {}, timeoutMs: 50 } }) };
      const { publicToken, metadata } = await linked(s);
      s.fake.hangNext('/item/public_token/exchange');
      expect(await caught(s.plaid.exchange(s.admin, 'session-a', publicToken, metadata))).toMatchObject({ link: 'maybe_connected' });
      expect(s.plaid.trialCount()).toBe(1);
    });

    it("doesn't count one that was never sent, or a refusal", async () => {
      const s = setup();
      const { publicToken, metadata } = await linked(s);
      // No time left to send it at all.
      expect(await caught(s.plaid.exchange(s.admin, 'session-a', publicToken, metadata, { deadline: Date.now() + 10 }))).toMatchObject({ link: 'busy' });
      expect(s.fake.count('/item/public_token/exchange')).toBe(0);
      expect(s.plaid.trialCount()).toBe(0);
    });
  });

  it('removes the Item at Plaid when something fails after the exchange, keeping nothing but the count', async () => {
    const s = setup();
    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', {});
    const { publicToken, metadata } = s.fake.completeLink(linkToken, { institution: BANK, accounts: [CARD_A] });
    s.fake.failNext('/accounts/get', FAKE_PLAID_ERRORS.ACCESS_NOT_GRANTED);
    const err = await caught(s.plaid.exchange(s.admin, 'session-a', publicToken, metadata));
    expect(err).toMatchObject({ link: 'failed' });
    expect(s.fake.removals).toHaveLength(1);
    expect(s.t.db.select().from(connections).all()).toEqual([]);
    expect(s.t.db.select().from(plaidItems).all()).toEqual([]);
    expect(s.t.db.select().from(pendingRevocations).all()).toEqual([]);
    expect(s.plaid.trialCount()).toBe(1);
  });

  it('queues the revocation when that removal fails too, bound to its row', async () => {
    const s = setup();
    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', {});
    const { publicToken, metadata } = s.fake.completeLink(linkToken, { institution: BANK, accounts: [CARD_A] });
    const fakeItem = [...s.fake.items.values()].at(-1)!;
    s.fake.failNext('/item/get', FAKE_PLAID_ERRORS.ITEM_LOGIN_REQUIRED);
    s.fake.failNext('/item/remove', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    expect(await caught(s.plaid.exchange(s.admin, 'session-a', publicToken, metadata))).toMatchObject({ link: 'failed', message: PLAID_MESSAGES.failed });
    expect(s.fake.removals).toEqual([]);
    const [row] = s.t.db.select().from(pendingRevocations).all();
    expect(row).toMatchObject({ kind: 'plaid', ownerUserId: s.admin, accountId: fakeItem.itemId, attempts: 0 });
    expect(JSON.parse(decryptSecret(ring, row!.credentialsEnc, familyRevocationAad('plaid', row!.id)))).toEqual({ accessToken: fakeItem.accessToken });
    expect(s.t.db.select().from(connections).all()).toEqual([]);
    expect(s.t.db.select().from(plaidItems).all()).toEqual([]);

    expect(await s.plaid.retryRevocations()).toEqual({ total: 1, failed: 0, gaveUp: 0 });
    expect(s.fake.removals).toEqual([fakeItem.itemId]);
    expect(s.t.db.select().from(pendingRevocations).all()).toEqual([]);
  });
});

describe('a passing failure after the exchange', () => {
  it("keeps the Item when /accounts/get can't be had right now, with what /item/get said, for loadAccounts later", async () => {
    const s = setup();
    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', {});
    const { publicToken, metadata } = s.fake.completeLink(linkToken, { institution: BANK, accounts: [CARD_A] });
    const fakeItem = [...s.fake.items.values()].at(-1)!;
    s.fake.setConsentExpiration(fakeItem.itemId, '2027-11-15T12:00:00Z');
    for (let i = 0; i < 3; i++) s.fake.failNext('/accounts/get', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    const { itemId, accountsLoaded } = await s.plaid.exchange(s.admin, 'session-a', publicToken, metadata);
    expect(accountsLoaded).toBe(false);
    expect(s.plaid.item(itemId)).toMatchObject({ plaidItemId: fakeItem.itemId, accounts: null, pickedAt: null, consentExpirationTime: '2027-11-15T12:00:00Z', removedAt: null });
    expect(connectionOf(s, itemId)).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
    expect(s.fake.removals).toEqual([]);
    expect(s.t.db.select().from(pendingRevocations).all()).toEqual([]);
    expect(s.log.lines.some((l) => l.msg === "plaid exchange done, but the bank's details couldn't be fetched yet; the item waits for them" && l.errorCode === 'INTERNAL_SERVER_ERROR')).toBe(true);

    expect(await s.plaid.loadAccounts(s.admin, itemId)).toEqual({ accounts: 1, newAccounts: 1 });
    expect(s.plaid.item(itemId)!.accounts!.map((a) => a.accountId)).toEqual(fakeItem.accounts.map((a) => a.account_id));
    expect(s.plaid.item(itemId)!.pickedAt).toBeNull();
  });

  it("keeps the Item when /item/get can't be had right now, named from Link's metadata until loadAccounts", async () => {
    const s = setup();
    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', {});
    const { publicToken, metadata } = s.fake.completeLink(linkToken, { institution: BANK, accounts: [CARD_A] });
    for (let i = 0; i < 3; i++) s.fake.dropNext('/item/get');
    const { itemId, accountsLoaded } = await s.plaid.exchange(s.admin, 'session-a', publicToken, metadata);
    expect(accountsLoaded).toBe(false);
    expect(s.plaid.item(itemId)).toMatchObject({ institutionName: 'Example Bank', accounts: null });
    expect(s.fake.count('/accounts/get')).toBe(0);
    expect(s.plaid.trialCount()).toBe(1);
    await s.plaid.loadAccounts(s.admin, itemId);
    expect(s.plaid.item(itemId)!.accounts).toHaveLength(1);
  });

  it('still undoes the exchange for a failure that is not a passing one', async () => {
    const s = setup();
    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', {});
    const { publicToken, metadata } = s.fake.completeLink(linkToken, { institution: BANK, accounts: [CARD_A] });
    s.fake.failNext('/accounts/get', FAKE_PLAID_ERRORS.ITEM_NOT_FOUND);
    expect(await caught(s.plaid.exchange(s.admin, 'session-a', publicToken, metadata))).toMatchObject({ link: 'failed', message: PLAID_MESSAGES.failed });
    expect(s.t.db.select().from(plaidItems).all()).toEqual([]);
    expect(s.t.db.select().from(connections).all()).toEqual([]);
  });
});

describe('loadAccounts', () => {
  it("stores the bank's account list again: a new account waits for the pick and clears the notice, without touching sync health", async () => {
    const s = setup();
    const { itemId, row } = await link(s, { accounts: [CARD_A] });
    const picked = s.t.clock.now();
    s.t.db.update(plaidItems).set({ pickedAt: picked, newAccountsAt: picked }).where(eq(plaidItems.id, itemId)).run();
    s.t.db.update(connections).set({ consecutiveFailures: 2, lastError: 'earlier' }).where(eq(connections.id, row.connectionId!)).run();
    s.t.clock.advance(60_000);
    // Nothing new yet: the notice and the pick stay.
    expect(await s.plaid.loadAccounts(s.admin, itemId)).toEqual({ accounts: 1, newAccounts: 0 });
    expect(s.plaid.item(itemId)).toMatchObject({ pickedAt: picked, newAccountsAt: picked });
    // The bank now shares a second card (as if Plaid changed an account's id, or one was added).
    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', { itemId, addAccounts: true });
    const kept = row.accounts![0]!;
    s.fake.completeLink(linkToken, { accounts: [{ name: kept.name, mask: kept.mask, account_id: kept.accountId }, { name: 'Example New Card', mask: '3333' }] });
    expect(await s.plaid.loadAccounts(s.admin, itemId)).toEqual({ accounts: 2, newAccounts: 1 });
    expect(s.plaid.item(itemId)).toMatchObject({ pickedAt: null, newAccountsAt: null });
    expect(s.plaid.item(itemId)!.accounts!.map((a) => a.name)).toEqual(['Example Rewards', 'Example New Card']);
    // A call beside the sync: the connection's health is the sync's to say.
    expect(connectionOf(s, itemId)).toMatchObject({ consecutiveFailures: 2, lastError: 'earlier' });
  });

  it("refuses with a plain message, recording only what's true of the whole connection", async () => {
    const s = setup();
    const { itemId } = await link(s);
    for (let i = 0; i < 3; i++) s.fake.failNext('/accounts/get', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    expect(await caught(s.plaid.loadAccounts(s.admin, itemId))).toMatchObject({ code: 'integration_unavailable', message: PLAID_MESSAGES.unreachable });
    expect(connectionOf(s, itemId)).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
    expect(s.plaid.item(itemId)!.backoffUntil).toBeNull();
    s.fake.failNext('/item/get', FAKE_PLAID_ERRORS.ITEM_LOGIN_REQUIRED);
    expect(await caught(s.plaid.loadAccounts(s.admin, itemId))).toMatchObject({ message: PLAID_MESSAGES.reconnect });
    expect(connectionOf(s, itemId)!.status).toBe('needs_reconnect');
  });
});

describe('lock deadlines', () => {
  /** Holds the Item's lock, as a sync run would, until `release`. */
  async function held(s: Setup, itemId: number) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const run = s.plaid.withItem(itemId, async () => {
      started();
      await gate;
    });
    await running;
    return async () => {
      release();
      await run;
    };
  }

  it('refuses remove past its deadline with "busy syncing", changing nothing', async () => {
    const s = setup();
    const { itemId } = await link(s);
    const release = await held(s, itemId);
    const err = await caught(s.plaid.remove(s.admin, itemId, { deleteTransactions: false, deadline: Date.now() + 20 }));
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'integration_unavailable', message: PLAID_MESSAGES.itemBusy });
    await release();
    expect(s.plaid.item(itemId)!.removedAt).toBeNull();
    expect(s.fake.count('/item/remove')).toBe(0);
    expect(await s.plaid.remove(s.admin, itemId, { deleteTransactions: false, deadline: Date.now() + 5000 })).toMatchObject({ revoked: true });
  });

  it("refuses completeUpdate past its deadline as the link error 'busy'", async () => {
    const s = setup();
    const { itemId } = await link(s);
    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', { itemId });
    s.fake.completeLink(linkToken);
    const release = await held(s, itemId);
    const err = await caught(s.plaid.completeUpdate(s.admin, 'session-a', { deadline: Date.now() + 20 }));
    expect(err).toMatchObject({ link: 'busy', code: 'integration_unavailable', message: PLAID_MESSAGES.itemBusy });
    expect(PLAID_LINK_ERRORS.busy).toBe(PLAID_MESSAGES.itemBusy);
    expect(linkError(err)).toBe('busy');
    await release();
    // The pending link waited for the lock, so "try again in a minute" works with the same one.
    expect(s.t.db.select().from(plaidLinkPending).all()).toHaveLength(1);
    expect(await s.plaid.completeUpdate(s.admin, 'session-a', { deadline: Date.now() + 5000 })).toMatchObject({ itemId });
    expect(s.t.db.select().from(plaidLinkPending).all()).toEqual([]);
  });
});

describe('update mode', () => {
  it('reconnects in place: status ok, the item and accounts refreshed, no new Trial Item', async () => {
    const s = setup();
    const { itemId, row, fakeItem } = await link(s, { accounts: [CARD_A] });
    s.t.db.update(plaidItems).set({ pickedAt: s.t.clock.now(), newAccountsAt: s.t.clock.now(), disconnectAt: '2026-12-01T00:00:00Z', backoffUntil: s.t.clock.now() }).where(eq(plaidItems.id, itemId)).run();
    s.fake.breakItem(fakeItem.itemId);
    await expect(s.plaid.withItem(itemId, (x) => x.client.getAccounts(x.accessToken))).rejects.toMatchObject({ errorCode: 'ITEM_LOGIN_REQUIRED' });
    expect(connectionOf(s, itemId)!.status).toBe('needs_reconnect');

    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', { itemId });
    s.fake.setConsentExpiration(fakeItem.itemId, '2027-12-01T00:00:00Z');
    s.fake.completeLink(linkToken, { accounts: [{ ...CARD_A, account_id: row.accounts![0]!.accountId }] });
    expect(await s.plaid.completeUpdate(s.admin, 'session-a')).toEqual({ itemId, newAccounts: 0 });

    expect(connectionOf(s, itemId)).toMatchObject({ status: 'ok', consecutiveFailures: 0, lastError: null });
    expect(s.plaid.item(itemId)).toMatchObject({
      consentExpirationTime: '2027-12-01T00:00:00Z', newAccountsAt: null, disconnectAt: null, backoffUntil: null, pickedAt: s.t.clock.now(),
    });
    expect(s.fake.count('/item/public_token/exchange')).toBe(1);
    expect(s.plaid.trialCount()).toBe(1);
    expect(s.t.db.select().from(plaidLinkPending).all()).toEqual([]);
  });

  it('refreshes the account list: a new account waits for the pick, a dropped one stays on it as no longer listed', async () => {
    const s = setup();
    const { itemId, row } = await link(s, { accounts: [CARD_A, CARD_B] });
    s.t.db.update(plaidItems).set({ pickedAt: s.t.clock.now() }).where(eq(plaidItems.id, itemId)).run();
    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', { itemId, addAccounts: true });
    const [kept, dropped] = row.accounts! as [PlaidItemAccount, PlaidItemAccount];
    s.fake.completeLink(linkToken, { accounts: [{ name: kept.name, mask: kept.mask, account_id: kept.accountId }, { name: 'Example New Card', mask: '3333' }] });
    expect(await s.plaid.completeUpdate(s.admin, 'session-a')).toEqual({ itemId, newAccounts: 1 });
    const after = s.plaid.item(itemId)!;
    expect(after.accounts!.map((a) => [a.name, a.listed ?? true])).toEqual([['Example Rewards', true], ['Example New Card', true], ['Example Cash Back', false]]);
    expect(after.accounts![2]).toEqual({ ...dropped, listed: false });
    expect(after.pickedAt).toBeNull();

    // Listed again later (the admin shared it again): it's listed, and not new.
    const again = await s.plaid.createLinkToken(s.admin, 'session-a', { itemId, addAccounts: true });
    s.fake.completeLink(again.linkToken, { accounts: [kept, dropped].map((a) => ({ name: a.name, mask: a.mask, account_id: a.accountId })) });
    expect(await s.plaid.completeUpdate(s.admin, 'session-a')).toEqual({ itemId, newAccounts: 0 });
    expect(s.plaid.item(itemId)!.accounts!.map((a) => [a.name, a.listed ?? true])).toEqual([['Example Rewards', true], ['Example Cash Back', true], ['Example New Card', false]]);
  });

  it('finishes only in the same session, and records a failure like any call', async () => {
    const s = setup();
    const { itemId, fakeItem } = await link(s);
    await s.plaid.createLinkToken(s.admin, 'session-a', { itemId });
    expect(await caught(s.plaid.completeUpdate(s.admin, 'session-b'))).toMatchObject({ link: 'expired' });
    s.fake.breakItem(fakeItem.itemId); // the admin didn't finish fixing it
    expect(await caught(s.plaid.completeUpdate(s.admin, 'session-a'))).toMatchObject({ link: 'failed', message: PLAID_MESSAGES.reconnect });
    expect(connectionOf(s, itemId)!.status).toBe('needs_reconnect');
    // A new-link session can't finish as an update.
    await s.plaid.createLinkToken(s.admin, 'session-a', {});
    expect(await caught(s.plaid.completeUpdate(s.admin, 'session-a'))).toMatchObject({ link: 'expired' });
  });
});

describe('withItem and status', () => {
  it('gives the decrypted access token under a per-Item lock, and a success records ok and clears the backoff', async () => {
    const s = setup();
    const a = await link(s);
    const b = await link(s, { accounts: [CARD_B] });
    s.t.db.update(plaidItems).set({ backoffUntil: s.t.clock.now() }).where(eq(plaidItems.id, a.itemId)).run();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = s.plaid.withItem(a.itemId, async (x) => {
      expect(x.accessToken).toBe(a.fakeItem.accessToken);
      expect(x.item.id).toBe(a.itemId);
      order.push('a1 start');
      await gate;
      order.push('a1 end');
    });
    const second = s.plaid.withItem(a.itemId, async () => void order.push('a2'));
    // Another Item isn't held up.
    await s.plaid.withItem(b.itemId, async () => void order.push('b'));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a1 start', 'b', 'a1 end', 'a2']);
    expect(s.plaid.item(a.itemId)!.backoffUntil).toBeNull();
    // Re-entering the same Item's lock is refused, not a deadlock.
    await expect(s.plaid.withItem(a.itemId, () => s.plaid.withItem(a.itemId, async () => 1))).rejects.toThrow(/re-entered/);
  });

  it('sets needs_reconnect for login errors, and refuses further calls without asking Plaid', async () => {
    const s = setup();
    const { itemId, fakeItem } = await link(s);
    for (const code of ['ITEM_LOGIN_REQUIRED', 'PASSWORD_RESET_REQUIRED', 'ITEM_LOCKED', 'NO_ACCOUNTS', 'ACCESS_NOT_GRANTED'] as const) {
      s.fake.failNext('/accounts/get', { status: 400, error_type: 'ITEM_ERROR', error_code: code });
      await expect(s.plaid.withItem(itemId, (x) => x.client.getAccounts(x.accessToken))).rejects.toMatchObject({ errorCode: code });
      expect(connectionOf(s, itemId)).toMatchObject({ status: 'needs_reconnect', consecutiveFailures: 0 });
      const calls = s.fake.requests.length;
      // A call that would ask Plaid: it never gets to.
      const err = await caught(s.plaid.withItem(itemId, (x) => x.client.getAccounts(x.accessToken)));
      expect(err).toMatchObject({ code: 'integration_unavailable', message: PLAID_MESSAGES.reconnect });
      expect(s.fake.requests.length).toBe(calls);
      s.plaid.clearReconnect(itemId);
    }
    // Cleared, the same call reaches Plaid again.
    await s.plaid.withItem(itemId, (x) => x.client.getAccounts(x.accessToken));
    expect(s.fake.lastBody('/accounts/get')).toEqual({ access_token: fakeItem.accessToken });
  });

  it('marks an Item Plaid no longer has as needing a new link, not a reconnect', async () => {
    const s = setup();
    const { itemId } = await link(s);
    s.fake.failNext('/accounts/get', FAKE_PLAID_ERRORS.ITEM_NOT_FOUND);
    await expect(s.plaid.withItem(itemId, (x) => x.client.getAccounts(x.accessToken))).rejects.toMatchObject({ errorCode: 'ITEM_NOT_FOUND' });
    expect(connectionOf(s, itemId)).toMatchObject({ status: 'needs_reconnect', lastError: PLAID_MESSAGES.gone });
    expect(await caught(s.plaid.withItem(itemId, async () => 1))).toMatchObject({ message: PLAID_MESSAGES.gone });
    expect(plaidAppError(await caught(s.plaid.withItem(itemId, async () => 1)))).toMatchObject({ message: PLAID_MESSAGES.gone });
  });

  it('backs off after transient failures, doubling to an hour, with error after three in a row, and any success clears it', async () => {
    const s = setup();
    const { itemId } = await link(s);
    const fail = () => {
      for (let i = 0; i < 3; i++) s.fake.failNext('/accounts/get', FAKE_PLAID_ERRORS.INSTITUTION_DOWN);
      return s.plaid.withItem(itemId, (x) => x.client.getAccounts(x.accessToken)).catch((err: unknown) => err);
    };
    const waits: number[] = [];
    for (let n = 1; n <= 6; n++) {
      expect(await fail()).toMatchObject({ errorCode: 'INSTITUTION_DOWN' });
      waits.push(s.plaid.item(itemId)!.backoffUntil!.getTime() - s.t.clock.now().getTime());
      expect(connectionOf(s, itemId)).toMatchObject({ consecutiveFailures: n, status: n >= 3 ? 'error' : 'ok' });
    }
    expect(waits).toEqual([BACKOFF_FIRST_MS, 2 * BACKOFF_FIRST_MS, 4 * BACKOFF_FIRST_MS, 8 * BACKOFF_FIRST_MS, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
    expect(connectionOf(s, itemId)!.lastError).toBe("Couldn't reach Plaid or the bank.");
    await s.plaid.withItem(itemId, (x) => x.client.getAccounts(x.accessToken));
    expect(connectionOf(s, itemId)).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
    expect(s.plaid.item(itemId)!.backoffUntil).toBeNull();
  });

  it('records only a login problem or a gone Item for a call beside the sync (sideCall), and never its success', async () => {
    const s = setup();
    const { itemId, row } = await link(s);
    const conn = () => connectionOf(s, itemId)!;
    s.t.db.update(connections).set({ status: 'error', consecutiveFailures: 3, lastError: 'sync failed' }).where(eq(connections.id, row.connectionId!)).run();
    const successAt = conn().lastSuccessAt;
    s.t.clock.advance(60_000);
    await s.plaid.withItem(itemId, (x) => x.client.getAccounts(x.accessToken), { sideCall: true });
    expect(conn()).toMatchObject({ status: 'error', consecutiveFailures: 3, lastError: 'sync failed', lastSuccessAt: successAt });
    for (let i = 0; i < 3; i++) s.fake.failNext('/accounts/get', FAKE_PLAID_ERRORS.INSTITUTION_DOWN);
    await expect(s.plaid.withItem(itemId, (x) => x.client.getAccounts(x.accessToken), { sideCall: true })).rejects.toMatchObject({ errorCode: 'INSTITUTION_DOWN' });
    expect(conn()).toMatchObject({ consecutiveFailures: 3, lastError: 'sync failed' });
    expect(s.plaid.item(itemId)!.backoffUntil).toBeNull();
    s.fake.failNext('/accounts/get', FAKE_PLAID_ERRORS.ITEM_NOT_FOUND);
    await expect(s.plaid.withItem(itemId, (x) => x.client.getAccounts(x.accessToken), { sideCall: true })).rejects.toMatchObject({ errorCode: 'ITEM_NOT_FOUND' });
    expect(conn()).toMatchObject({ status: 'needs_reconnect', lastError: PLAID_MESSAGES.gone });
    // A sync's success is what sets ok again (here a plain call stands in for one, after a reconnect).
    s.plaid.clearReconnect(itemId);
    await s.plaid.withItem(itemId, (x) => x.client.getAccounts(x.accessToken));
    expect(conn()).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
  });

  it("doesn't record the app's own errors, or a failure after the credentials changed", async () => {
    const s = setup();
    const { itemId } = await link(s);
    await expect(s.plaid.withItem(itemId, async () => { throw new Error('a local bug'); })).rejects.toThrow('a local bug');
    expect(connectionOf(s, itemId)).toMatchObject({ consecutiveFailures: 0, lastError: null });

    s.fake.failNext('/accounts/get', FAKE_PLAID_ERRORS.ITEM_LOGIN_REQUIRED);
    await expect(s.plaid.withItem(itemId, async (x) => {
      // Something rewrote the credentials meanwhile (a fresh ciphertext of the same token).
      const conn = connectionOf(s, itemId)!;
      s.t.db.update(connections).set({ credentialsEnc: encryptCredentials(ring, conn, { accessToken: x.accessToken }) }).where(eq(connections.id, conn.id)).run();
      return x.client.getAccounts(x.accessToken);
    })).rejects.toMatchObject({ errorCode: 'ITEM_LOGIN_REQUIRED' });
    expect(connectionOf(s, itemId)!.status).toBe('ok');
  });

  it("keeps a needs_reconnect a webhook set during a call that then succeeded", async () => {
    const s = setup();
    const { itemId } = await link(s);
    await s.plaid.withItem(itemId, async (x) => {
      s.plaid.markNeedsReconnect(itemId, 'ITEM_LOGIN_REQUIRED');
      return x.client.getAccounts(x.accessToken);
    });
    expect(connectionOf(s, itemId)!.status).toBe('needs_reconnect');
  });

  it('marks credentials that no longer decrypt with the right key as needing a new link', async () => {
    const s = setup();
    const { itemId } = await link(s);
    const conn = connectionOf(s, itemId)!;
    s.t.db.update(connections).set({ credentialsEnc: encryptSecret(ring, '{"accessToken":"x"}', 'some other row') }).where(eq(connections.id, conn.id)).run();
    expect(await caught(s.plaid.withItem(itemId, async () => 1))).toMatchObject({ code: 'integration_unavailable', message: PLAID_MESSAGES.unreadable });
    expect(connectionOf(s, itemId)).toMatchObject({ status: 'needs_reconnect', lastError: PLAID_MESSAGES.unreadable });
  });

  it('refuses a removed or unknown Item', async () => {
    const s = setup();
    const { itemId } = await link(s);
    await s.plaid.remove(s.admin, itemId, { deleteTransactions: false });
    expect(await caught(s.plaid.withItem(itemId, async () => 1))).toMatchObject({ code: 'not_found' });
    expect(await caught(s.plaid.withItem(12345, async () => 1))).toMatchObject({ code: 'not_found' });
  });
});

describe('remove', () => {
  function withCards(s: Setup, itemId: number) {
    const item = s.plaid.item(itemId)!;
    const accountId = item.accounts![0]!.accountId;
    const card = addCard(s.t, { nickname: 'Rewards', plaidItemId: itemId, plaidAccountId: accountId });
    const plaidRow = addTransaction(s.t, card.id, { source: 'plaid', plaidTransactionId: 'tx-synthetic-1', plaidAccountId: accountId });
    const csvRow = addTransaction(s.t, card.id, { source: 'csv', csvReference: '1001' });
    const otherCard = addCard(s.t, { nickname: 'Other' });
    const otherRow = addTransaction(s.t, otherCard.id, { source: 'plaid', plaidTransactionId: 'tx-synthetic-2' });
    return { card, plaidRow, csvRow, otherCard, otherRow };
  }

  it('revokes first, then deletes the connection and marks the Item and its cards removed, keeping every transaction', async () => {
    const s = setup();
    const { itemId, fakeItem } = await link(s);
    const { card, plaidRow, csvRow, otherRow } = withCards(s, itemId);
    await s.plaid.createLinkToken(s.admin, 'session-a', { itemId });
    expect(await s.plaid.remove(s.admin, itemId, { deleteTransactions: false })).toEqual({ revoked: true, revocation: 'done', deletedTransactions: 0, restoredTransactions: 0 });
    expect(s.fake.removals).toEqual([fakeItem.itemId]);
    expect(s.t.db.select().from(connections).all()).toEqual([]);
    expect(s.plaid.item(itemId)).toMatchObject({ connectionId: null, removedAt: s.t.clock.now(), removedReason: 'removed' });
    expect(s.t.db.select().from(cards).where(eq(cards.id, card.id)).get()!.removedAt).toEqual(s.t.clock.now());
    expect(s.t.db.select().from(transactions).all().map((r) => r.id).sort((a, b) => a - b)).toEqual([plaidRow.id, csvRow.id, otherRow.id].sort((a, b) => a - b));
    expect(s.t.db.select().from(plaidLinkPending).all()).toEqual([]);
    expect(await caught(s.plaid.remove(s.admin, itemId, { deleteTransactions: false }))).toMatchObject({ code: 'not_found' });
  });

  it("with deleteTransactions, hard-deletes only that Item's Plaid rows: CSV history and other cards stay", async () => {
    const s = setup();
    const { itemId } = await link(s);
    const { plaidRow, csvRow, otherRow } = withCards(s, itemId);
    expect(await s.plaid.remove(s.admin, itemId, { deleteTransactions: true })).toEqual({ revoked: true, revocation: 'done', deletedTransactions: 1, restoredTransactions: 0 });
    const left = s.t.db.select().from(transactions).all().map((r) => r.id);
    expect(left).not.toContain(plaidRow.id);
    expect(left).toEqual(expect.arrayContaining([csvRow.id, otherRow.id]));
    expect(s.plaid.item(itemId)!.removedReason).toBe('removed_with_transactions');
  });

  it("with deleteTransactions, deletes the Item's rows by account, and brings back what they replaced", async () => {
    const s = setup();
    const { itemId } = await link(s);
    const accountId = s.plaid.item(itemId)!.accounts![0]!.accountId;
    const now = s.t.clock.now();
    // An earlier connection to the same bank, removed with its transactions kept.
    s.t.db.insert(plaidItems).values({ plaidItemId: 'item-old-synthetic', institutionName: 'Example Bank', removedAt: now, removedReason: 'removed', createdAt: now, updatedAt: now }).run();
    const card = addCard(s.t, { nickname: 'Rewards', plaidItemId: itemId, plaidAccountId: accountId });
    const imported = s.t.db.insert(csvImports)
      .values({ cardId: card.id, fileSha256: 'synthetic', uploadedByUserId: s.admin, uploadedAt: now, rowCount: 2, importedCount: 2, skippedCount: 0 })
      .returning().get();
    const dining = categoryId(s.t, 'Dining');
    const own = (id: string, f: Parameters<typeof addTransaction>[2] = {}) =>
      addTransaction(s.t, card.id, { source: 'plaid', plaidTransactionId: id, plaidAccountId: accountId, ...f });
    const old = (id: string, f: Parameters<typeof addTransaction>[2] = {}) =>
      addTransaction(s.t, card.id, { source: 'plaid', plaidTransactionId: id, plaidAccountId: 'acct-old-synthetic', ...f });

    // A row from the old connection that nothing replaced: not this bank's, so it stays.
    const ancient = old('tx-old-1', { date: '2024-01-05' });
    // A CSV row replaced by one of ours, set by hand on the pair afterwards.
    const p1 = own('tx-1', { categoryId: dining, categorySource: 'manual', personUserId: s.admin, personSource: 'manual', note: 'edited on the bank row' });
    const csv = addTransaction(s.t, card.id, { csvImportId: imported.id, csvReference: 'R1', note: 'from the file', deletedAt: now, replacedById: p1.id });
    // A CSV row whose import was undone after it was replaced.
    const p2 = own('tx-2');
    const undone = addTransaction(s.t, card.id, { csvImportId: null, csvReference: 'R2', deletedAt: now, replacedById: p2.id });
    // The old connection's posted row, and its pending row, each replaced by one of ours.
    const p3 = own('tx-3');
    const oldPosted = old('tx-old-2', { categoryId: dining, categorySource: 'rule', deletedAt: now, replacedById: p3.id });
    const p4 = own('tx-4');
    const oldPending = old('tx-old-3', { pending: true, deletedAt: now, replacedById: p4.id });
    // Our own pending row and its posted version: both ours, both go.
    const p6 = own('tx-6');
    const p5 = own('tx-5', { pending: true, deletedAt: now, replacedById: p6.id });
    // A Plaid row of another card with no account: not ours.
    const other = addTransaction(s.t, addCard(s.t, { nickname: 'Other' }).id, { source: 'plaid', plaidTransactionId: 'tx-other' });

    s.t.clock.advance(60_000);
    const later = s.t.clock.now();
    expect(await s.plaid.remove(s.admin, itemId, { deleteTransactions: true })).toEqual({ revoked: true, revocation: 'done', deletedTransactions: 6, restoredTransactions: 2 });
    const left = new Set(s.t.db.select({ id: transactions.id }).from(transactions).all().map((r) => r.id));
    for (const gone of [p1, p2, p3, p4, p5, p6, undone]) expect(left.has(gone.id)).toBe(false);
    for (const kept of [ancient, csv, oldPosted, oldPending, other]) expect(left.has(kept.id)).toBe(true);
    expect(transaction(s.t, csv.id)).toMatchObject({
      deletedAt: null, replacedById: null, categoryId: dining, categorySource: 'manual', personUserId: s.admin, personSource: 'manual', updatedAt: later,
      // Both notes, its own first (review C-S-M1).
      note: 'from the file\nedited on the bank row',
    });
    // Nothing set by hand on the replacing row: the old row keeps its own category.
    expect(transaction(s.t, oldPosted.id)).toMatchObject({ deletedAt: null, replacedById: null, categoryId: dining, categorySource: 'rule' });
    // The old connection's pending row will never post: it stays deleted, for the prune.
    expect(transaction(s.t, oldPending.id)).toMatchObject({ deletedAt: now, removedAt: later });
    expect(transaction(s.t, ancient.id)).toMatchObject({ deletedAt: null });
  });

  it("with deleteTransactions after an account id change, deletes the rows under both ids and restores only what wasn't this bank's", async () => {
    const s = setup();
    const { itemId, row } = await link(s, { accounts: [CARD_A] });
    const oldId = row.accounts![0]!.accountId;
    const now = s.t.clock.now();
    s.t.db.insert(plaidItems).values({ plaidItemId: 'item-older-synthetic', institutionName: 'Example Bank', removedAt: now, removedReason: 'removed', createdAt: now, updatedAt: now }).run();
    const card = addCard(s.t, { nickname: 'Rewards', mask: '1111', plaidItemId: itemId, plaidAccountId: oldId });
    const imported = s.t.db.insert(csvImports)
      .values({ cardId: card.id, fileSha256: 'synthetic', uploadedByUserId: s.admin, uploadedAt: now, rowCount: 1, importedCount: 1, skippedCount: 0 })
      .returning().get();
    // Before the change: our row under the old id, which replaced a CSV row.
    const underOld = addTransaction(s.t, card.id, { source: 'plaid', plaidTransactionId: 'tx-old-id', plaidAccountId: oldId, note: 'set on the bank row' });
    const csv = addTransaction(s.t, card.id, { csvImportId: imported.id, csvReference: 'R1', deletedAt: now, replacedById: underOld.id });

    // Plaid changes the card's account id: /accounts/get lists the new one only.
    const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', { itemId, addAccounts: true });
    s.fake.completeLink(linkToken, { accounts: [{ ...CARD_A, account_id: 'acct-new-synthetic' }] });
    await s.plaid.completeUpdate(s.admin, 'session-a');
    expect(s.plaid.item(itemId)!.accounts!.map((a) => [a.accountId, a.listed ?? true])).toEqual([['acct-new-synthetic', true], [oldId, false]]);
    // The pick moves the card onto the new id (banks.ts), and the new rows replace the old-id ones
    // (they look like a gone bank's now) and an older connection's row.
    s.t.db.update(cards).set({ plaidAccountId: 'acct-new-synthetic' }).where(eq(cards.id, card.id)).run();
    const underNew = addTransaction(s.t, card.id, { source: 'plaid', plaidTransactionId: 'tx-new-id', plaidAccountId: 'acct-new-synthetic', note: 'set on the new row' });
    s.t.db.update(transactions).set({ deletedAt: now, replacedById: underNew.id }).where(eq(transactions.id, underOld.id)).run();
    const older = addTransaction(s.t, card.id, { source: 'plaid', plaidTransactionId: 'tx-older', plaidAccountId: 'acct-older-synthetic', deletedAt: now, replacedById: underNew.id });

    expect(await s.plaid.remove(s.admin, itemId, { deleteTransactions: true })).toEqual({ revoked: true, revocation: 'done', deletedTransactions: 2, restoredTransactions: 2 });
    const left = new Set(s.t.db.select({ id: transactions.id }).from(transactions).all().map((r) => r.id));
    // Both of this bank's rows go: the old-id one isn't "restored" as if another bank's.
    expect(left.has(underOld.id)).toBe(false);
    expect(left.has(underNew.id)).toBe(false);
    expect(transaction(s.t, csv.id)).toMatchObject({ deletedAt: null, replacedById: null, note: 'set on the bank row' });
    expect(transaction(s.t, older.id)).toMatchObject({ deletedAt: null, replacedById: null, note: 'set on the new row' });
  });

  it("keeping transactions, soft-deletes the Item's pending rows (it will never post them) and keeps the rest", async () => {
    const s = setup();
    const { itemId } = await link(s);
    const accountId = s.plaid.item(itemId)!.accounts![0]!.accountId;
    const card = addCard(s.t, { plaidItemId: itemId, plaidAccountId: accountId });
    const posted = addTransaction(s.t, card.id, { source: 'plaid', plaidTransactionId: 'tx-1', plaidAccountId: accountId });
    const pending = addTransaction(s.t, card.id, { source: 'plaid', plaidTransactionId: 'tx-2', plaidAccountId: accountId, pending: true });
    const otherBank = await link(s, { accounts: [CARD_B] });
    const otherAccount = s.plaid.item(otherBank.itemId)!.accounts![0]!.accountId;
    const otherPending = addTransaction(s.t, addCard(s.t, { plaidItemId: otherBank.itemId, plaidAccountId: otherAccount }).id, {
      source: 'plaid', plaidTransactionId: 'tx-3', plaidAccountId: otherAccount, pending: true,
    });
    expect(await s.plaid.remove(s.admin, itemId, { deleteTransactions: false })).toMatchObject({ deletedTransactions: 0 });
    const now = s.t.clock.now();
    expect(transaction(s.t, pending.id)).toMatchObject({ deletedAt: now, removedAt: now });
    expect(transaction(s.t, posted.id)).toMatchObject({ deletedAt: null, removedAt: null });
    expect(transaction(s.t, otherPending.id)).toMatchObject({ deletedAt: null, removedAt: null });
    expect(s.plaid.item(itemId)!.removedReason).toBe('removed');
  });

  it("names the bank in a lasting notice when its token can't be read to revoke it", async () => {
    const s = setup();
    const { itemId } = await link(s);
    const conn = connectionOf(s, itemId)!;
    s.t.db.update(connections).set({ credentialsEnc: encryptSecret(ring, '{"accessToken":"x"}', 'some other row') }).where(eq(connections.id, conn.id)).run();
    expect(await s.plaid.remove(s.admin, itemId, { deleteTransactions: false })).toMatchObject({ revoked: false, revocation: 'not_asked' });
    expect(s.fake.count('/item/remove')).toBe(0);
    const [row] = s.t.db.select().from(pendingRevocations).all();
    expect(row).toMatchObject({ kind: 'plaid', credentialsEnc: '', gaveUpAt: s.t.clock.now(), accountId: s.plaid.item(itemId)!.plaidItemId });
    expect(s.plaid.revocationNotices()).toEqual([{ id: row!.id, message: expect.stringContaining('Example Bank') }]);
    // Nothing for the hourly retry: there's no token to try.
    expect(s.plaid.warnings()).toEqual([]);
    expect(await s.plaid.retryRevocations()).toEqual({ total: 0, failed: 0, gaveUp: 0 });
  });

  it('counts an Item Plaid already removed as revoked', async () => {
    const s = setup();
    const { itemId } = await link(s);
    s.fake.failNext('/item/remove', FAKE_PLAID_ERRORS.ITEM_NOT_FOUND);
    expect(await s.plaid.remove(s.admin, itemId, { deleteTransactions: false })).toMatchObject({ revoked: true, revocation: 'done' });
    expect(s.t.db.select().from(pendingRevocations).all()).toEqual([]);
  });

  it("doesn't count INSTITUTION_NO_LONGER_SUPPORTED from /item/remove as revoked, though it's a gone Item elsewhere", async () => {
    const s = setup();
    const { itemId } = await link(s);
    s.fake.failNext('/item/remove', { status: 400, error_type: 'INSTITUTION_ERROR', error_code: 'INSTITUTION_NO_LONGER_SUPPORTED' });
    expect(await s.plaid.remove(s.admin, itemId, { deleteTransactions: false })).toMatchObject({ revoked: false });
    expect(s.t.db.select().from(pendingRevocations).all()).toHaveLength(1);
  });

  it('queues a revocation Plaid did not confirm, retries it hourly, and gives up after 12 tries with a notice naming the bank', async () => {
    const s = setup();
    const { itemId, fakeItem } = await link(s);
    s.fake.failNext('/item/remove', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    expect(await s.plaid.remove(s.admin, itemId, { deleteTransactions: false })).toEqual({ revoked: false, revocation: 'waiting', deletedTransactions: 0, restoredTransactions: 0 });
    expect(s.fake.count('/item/remove')).toBe(1); // never retried by the client
    expect(s.t.db.select().from(connections).all()).toEqual([]);
    expect(s.plaid.warnings()).toEqual([expect.stringContaining('tried again every hour')]);

    for (let i = 1; i < REVOCATION_ATTEMPTS; i++) {
      s.fake.dropNext('/item/remove');
      expect(await s.plaid.retryRevocations()).toEqual({ total: 1, failed: 1, gaveUp: 0 });
    }
    expect(s.t.db.select().from(pendingRevocations).get()).toMatchObject({ attempts: REVOCATION_ATTEMPTS - 1, lastError: "Couldn't reach Plaid." });
    s.fake.failNext('/item/remove', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    expect(await s.plaid.retryRevocations()).toEqual({ total: 1, failed: 0, gaveUp: 1 });
    const row = s.t.db.select().from(pendingRevocations).get()!;
    expect(row).toMatchObject({ attempts: REVOCATION_ATTEMPTS, credentialsEnc: '', gaveUpAt: s.t.clock.now(), accountId: fakeItem.itemId });
    expect(s.plaid.warnings()).toEqual([]);
    expect(s.plaid.revocationNotices()).toEqual([{ id: row.id, message: expect.stringContaining('Example Bank') }]);
    expect(await s.plaid.retryRevocations()).toEqual({ total: 0, failed: 0, gaveUp: 0 });
    expect(s.plaid.dismissRevocation(row.id)).toBe(true);
    expect(s.plaid.dismissRevocation(row.id)).toBe(false);
    expect(s.t.db.select().from(pendingRevocations).all()).toEqual([]);
  });

  it('a retry that works deletes the row; one whose token no longer decrypts gives up at once', async () => {
    const s = setup();
    const a = await link(s);
    const b = await link(s, { accounts: [CARD_B] });
    s.fake.failNext('/item/remove', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    await s.plaid.remove(s.admin, a.itemId, { deleteTransactions: false });
    s.fake.failNext('/item/remove', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    await s.plaid.remove(s.admin, b.itemId, { deleteTransactions: false });
    const [, second] = s.t.db.select().from(pendingRevocations).orderBy(pendingRevocations.id).all();
    s.t.db.update(pendingRevocations).set({ credentialsEnc: encryptSecret(ring, '{"accessToken":"x"}', familyRevocationAad('plaid', 999)) }).where(eq(pendingRevocations.id, second!.id)).run();
    expect(await s.plaid.retryRevocations()).toEqual({ total: 2, failed: 0, gaveUp: 1 });
    expect(s.fake.removals).toEqual([a.fakeItem.itemId]);
    expect(s.t.db.select().from(pendingRevocations).all()).toEqual([expect.objectContaining({ id: second!.id, credentialsEnc: '' })]);
  });
});

describe('the key mismatch', () => {
  async function mismatched() {
    const before = setup();
    const { itemId, fakeItem } = await link(before);
    const card = addCard(before.t, { plaidItemId: itemId, plaidAccountId: before.plaid.item(itemId)!.accounts![0]!.accountId });
    const accountId = before.plaid.item(itemId)!.accounts![0]!.accountId;
    const tx = addTransaction(before.t, card.id, { source: 'plaid', plaidTransactionId: 'tx-synthetic-1', plaidAccountId: accountId });
    const pending = addTransaction(before.t, card.id, { source: 'plaid', plaidTransactionId: 'tx-synthetic-2', plaidAccountId: accountId, pending: true });
    before.fake.failNext('/item/remove', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    const removed = await link(before, { accounts: [CARD_B] });
    await before.plaid.remove(before.admin, removed.itemId, { deleteTransactions: false });
    await before.plaid.createLinkToken(before.admin, 'session-a', {});
    const s = setup({ t: before.t, fake: before.fake, admin: before.admin, keyMismatch: true });
    return { s, itemId, fakeItem, card, tx, pending };
  }

  it('refuses links, calls, and removal without asking Plaid, and retries no revocations', async () => {
    const { s, itemId } = await mismatched();
    const calls = s.fake.requests.length;
    expect(s.plaid.keyMismatch).toBe(true);
    expect(await caught(s.plaid.createLinkToken(s.admin, 'session-a', {}))).toMatchObject({ link: 'key_mismatch', message: PLAID_MESSAGES.keyMismatch });
    expect(await caught(s.plaid.exchange(s.admin, 'session-a', 'public-x', { institution: null, accounts: [] }))).toMatchObject({ link: 'key_mismatch' });
    expect(await caught(s.plaid.completeUpdate(s.admin, 'session-a'))).toMatchObject({ link: 'key_mismatch' });
    expect(await caught(s.plaid.withItem(itemId, async () => 1))).toMatchObject({ code: 'integration_unavailable', message: PLAID_MESSAGES.keyMismatch });
    let ran = false;
    expect(await caught(s.plaid.underLock(itemId, () => { ran = true; }))).toMatchObject({ code: 'integration_unavailable', message: PLAID_MESSAGES.keyMismatch });
    expect(ran).toBe(false);
    expect(await caught(s.plaid.remove(s.admin, itemId, { deleteTransactions: false }))).toMatchObject({ message: PLAID_MESSAGES.keyMismatch });
    expect(await s.plaid.retryRevocations()).toEqual({ total: 0, failed: 0, gaveUp: 0 });
    expect(s.fake.requests.length).toBe(calls);
    // The key mismatch itself is keyMismatchWarning's line, said once; Plaid only adds the waiting removal.
    expect(s.plaid.warnings()).toEqual([expect.stringContaining('tried again every hour')]);
  });

  it('forgets every Item for a new key: connections deleted, revocations turned into notices, Items and cards removed, posted transactions kept', async () => {
    const { s, itemId, card, tx, pending } = await mismatched();
    const removedItem = s.t.db.select().from(plaidItems).all().find((r) => r.removedAt !== null)!;
    const live = s.plaid.item(itemId)!;
    expect(s.t.db.select().from(pendingRevocations).all().map((r) => r.gaveUpAt)).toEqual([null]);
    expect(await s.plaid.forgetForNewKey()).toEqual({ forgotten: 1 });
    expect(s.t.db.select().from(connections).where(eq(connections.kind, 'plaid')).all()).toEqual([]);
    // Neither token can be read now, so neither can be revoked: each bank gets the lasting notice
    // (review C-S-M2), the waiting one and the one just forgotten, with no token kept.
    const notices = s.t.db.select().from(pendingRevocations).orderBy(asc(pendingRevocations.id)).all();
    expect(notices.map((r) => [r.accountId, r.gaveUpAt, r.credentialsEnc, r.ownerUserId])).toEqual([
      [removedItem.plaidItemId, s.t.clock.now(), '', s.admin],
      [live.plaidItemId, s.t.clock.now(), '', s.admin],
    ]);
    expect(s.plaid.revocationNotices()).toEqual([
      { id: notices[0]!.id, message: expect.stringContaining('my.plaid.com') },
      { id: notices[1]!.id, message: expect.stringContaining('my.plaid.com') },
    ]);
    expect(s.plaid.warnings()).toEqual([]);
    expect(s.t.db.select().from(plaidLinkPending).all()).toEqual([]);
    expect(s.plaid.item(itemId)).toMatchObject({ removedReason: 'key_reset', connectionId: null, removedAt: s.t.clock.now() });
    expect(s.t.db.select().from(cards).where(eq(cards.id, card.id)).get()!.removedAt).toEqual(s.t.clock.now());
    expect(s.t.db.select().from(transactions).where(eq(transactions.id, tx.id)).get()).toMatchObject({ deletedAt: null });
    // The forgotten Item will never post its pending rows.
    expect(transaction(s.t, pending.id)).toMatchObject({ deletedAt: s.t.clock.now(), removedAt: s.t.clock.now() });
    s.plaid.clearKeyMismatch();
    expect(s.plaid.keyMismatch).toBe(false);
    await expect(s.plaid.forgetForNewKey()).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('state for webhooks and views', () => {
  it("records what Plaid's webhooks report", async () => {
    const s = setup();
    const { itemId, row } = await link(s);
    expect(s.plaid.itemByPlaidId(row.plaidItemId)!.id).toBe(itemId);
    expect(s.plaid.itemByPlaidId('item-unknown')).toBeUndefined();

    s.plaid.markNeedsReconnect(itemId, 'ITEM_LOGIN_REQUIRED');
    expect(connectionOf(s, itemId)).toMatchObject({ status: 'needs_reconnect', lastError: 'The bank needs you to sign in again.' });
    const successAt = connectionOf(s, itemId)!.lastSuccessAt;
    s.t.clock.advance(60_000);
    s.plaid.clearReconnect(itemId);
    // Fixed, but nothing was fetched: "Updated X ago" doesn't move.
    expect(connectionOf(s, itemId)).toMatchObject({ status: 'ok', consecutiveFailures: 0, lastSuccessAt: successAt });

    s.plaid.noteNewAccounts(itemId);
    s.plaid.noteDisconnectAt(itemId, '2027-01-01T00:00:00Z');
    s.plaid.setConsentExpiration(itemId, '2027-01-08T00:00:00Z');
    s.plaid.setLastWebhookCode(itemId, 'SYNC_UPDATES_AVAILABLE');
    expect(s.plaid.item(itemId)).toMatchObject({
      newAccountsAt: s.t.clock.now(), disconnectAt: '2027-01-01T00:00:00Z', consentExpirationTime: '2027-01-08T00:00:00Z', lastWebhookCode: 'SYNC_UPDATES_AVAILABLE',
    });
  });

  it('lists Items with their connection, removed ones included, for the views', async () => {
    const s = setup();
    const a = await link(s);
    const b = await link(s, { accounts: [CARD_B] });
    await s.plaid.remove(s.admin, a.itemId, { deleteTransactions: false });
    const views = s.plaid.items();
    expect(views.map((v) => [v.item.id, v.connection?.status ?? null])).toEqual([[a.itemId, null], [b.itemId, 'ok']]);
    expect(Object.keys(views[1]!.connection!).sort()).toEqual(['consecutiveFailures', 'id', 'lastError', 'lastErrorAt', 'lastSuccessAt', 'status']);
  });
});

it('never logs a token, the secret, or a body', async () => {
  const s = setup();
  const { itemId, fakeItem, publicToken } = await link(s);
  const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', { itemId });
  s.fake.completeLink(linkToken);
  await s.plaid.completeUpdate(s.admin, 'session-a');
  s.fake.failNext('/accounts/get', FAKE_PLAID_ERRORS.ITEM_LOGIN_REQUIRED);
  await s.plaid.withItem(itemId, (x) => x.client.getAccounts(x.accessToken)).catch(() => {});
  s.fake.failNext('/item/remove', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
  await s.plaid.remove(s.admin, itemId, { deleteTransactions: false });
  await s.plaid.retryRevocations();
  const all = s.log.raw.join('\n');
  expect(s.log.lines.length).toBeGreaterThan(3);
  // Nor a body: Plaid's error message, or what the link token request carried (the per-install user id).
  const clientUserId = s.t.db.select().from(settings).where(eq(settings.key, 'plaid_client_user_id')).get()!.value;
  for (const secret of [fakeItem.accessToken!, publicToken, linkToken, FAKE_PLAID_SECRET, 'Example Rewards', 'Synthetic error from the fake Plaid.', clientUserId]) {
    expect(all).not.toContain(secret);
  }
});

describe('removing a Savings connection, and the key reset', () => {
  it('keeps its accounts marked removed, or deletes them with their data', async () => {
    const t = makeTestApp({ plaid: true });
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    const kept = linkSavingsForTest(t, admin, { institutionName: 'Kept Brokerage' });
    putSnapshot(t.db, kept.accounts[0]!.id, '2026-11-15', { currentCents: 1_00, availableCents: null }, t.clock.now());
    await t.plaid!.remove(admin, kept.item.id, { deleteTransactions: false });
    expect(t.db.select().from(savingsAccounts).where(eq(savingsAccounts.plaidItemId, kept.item.id)).all().map((a) => a.removedAt)).toEqual([t.clock.now(), t.clock.now()]);
    expect(t.db.select().from(savingsBalances).all()).toHaveLength(1);
    expect(t.plaid!.item(kept.item.id)?.removedReason).toBe('removed');

    const deleted = linkSavingsForTest(t, admin, { institutionName: 'Deleted Brokerage', accounts: [{ name: 'Other Cash', mask: '5555', type: 'depository', subtype: 'checking' }] });
    putSnapshot(t.db, deleted.accounts[0]!.id, '2026-11-15', { currentCents: 2_00, availableCents: null }, t.clock.now());
    await t.plaid!.remove(admin, deleted.item.id, { deleteTransactions: true });
    expect(t.db.select().from(savingsAccounts).where(eq(savingsAccounts.plaidItemId, deleted.item.id)).all()).toEqual([]);
    expect(t.db.select().from(savingsBalances).all()).toHaveLength(1);
    expect(t.plaid!.item(deleted.item.id)?.removedReason).toBe('removed_with_transactions');
  });

  it("marks a Savings connection's accounts removed when the key reset forgets it", async () => {
    const t = makeTestApp();
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    const linked = linkSavingsForTest(t, admin);
    // The file's setup() over the same database, under a key mismatch, as the System page's reset sees it.
    const s = setup({ t, admin, keyMismatch: true });
    await s.plaid.forgetForNewKey();
    expect(t.db.select().from(savingsAccounts).all().every((a) => a.removedAt !== null)).toBe(true);
    expect(s.plaid.item(linked.item.id)?.removedReason).toBe('key_reset');
  });
});

describe('a Savings link that fails after the exchange', () => {
  it('deletes the Savings data with the Item when the exchange is undone', async () => {
    const t = makeTestApp({ plaid: true });
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    const { linkToken } = await t.plaid!.createLinkToken(admin, 'session-a', { purpose: 'savings' });
    const { publicToken, metadata } = t.fakePlaid.completeLink(linkToken, {
      institution: { institution_id: 'ins_fake_savings', name: 'Example Brokerage' }, accounts: [{ name: 'Cash', mask: '1111', type: 'depository', subtype: 'cash management' }],
    });
    t.fakePlaid.intercept = (path) => {
      if (path !== '/item/get') return undefined;
      // Savings data on the new Item (none is made before the pick, but undoing must not depend on that).
      const row = t.db.select().from(plaidItems).all().at(-1)!;
      addSavingsAccount(t, row.id, { plaidAccountId: 'acct-x', kind: 'cash' });
      return new Response(JSON.stringify({ error_type: 'ITEM_ERROR', error_code: 'ITEM_NOT_FOUND' }), { status: 400, headers: { 'content-type': 'application/json' } });
    };
    await expect(t.plaid!.exchange(admin, 'session-a', publicToken, metadata)).rejects.toBeInstanceOf(PlaidLinkRefused);
    expect(t.db.select().from(plaidItems).all()).toEqual([]);
    expect(t.db.select().from(savingsAccounts).all()).toEqual([]);
  });
});
