import { describe, expect, it } from 'vitest';
import { FAKE_PLAID_CLIENT_ID, FAKE_PLAID_ERRORS, FAKE_PLAID_SECRET, FakePlaid, type FakePlaidPath } from './fakePlaid.js';

/**
 * The fake's own wire behaviour, checked on the raw JSON it answers rather than through
 * PlaidClient (whose zod schemas drop fields they don't read, so a wrong shape could hide behind
 * them). What it must match is docs/research/plaid-6b.md §2, §5, §8 and spend-plaid-csv.md §3.
 * Everything here is synthetic.
 */

const ORIGIN = 'https://plaid.test';
const AUTH = { 'PLAID-CLIENT-ID': FAKE_PLAID_CLIENT_ID, 'PLAID-SECRET': FAKE_PLAID_SECRET, 'Plaid-Version': '2020-09-14', 'Content-Type': 'application/json' };
const NEW_LINK = {
  client_name: 'Family Dashboard', language: 'en', country_codes: ['US'], user: { client_user_id: 'synthetic-user' }, products: ['transactions'],
};
const PATHS: FakePlaidPath[] = [
  '/link/token/create', '/item/public_token/exchange', '/item/get', '/item/remove', '/accounts/get', '/transactions/sync', '/liabilities/get',
  '/webhook_verification_key/get', '/investments/transactions/get',
];

async function raw(fake: FakePlaid, path: string, body: unknown): Promise<Response> {
  return fake.fetch(`${ORIGIN}${path}`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });
}
/** The raw JSON answer, loosely typed: these tests read it field by field. */
async function post(fake: FakePlaid, path: string, body: unknown): Promise<any> {
  const res = await raw(fake, path, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

function setup() {
  const fake = new FakePlaid();
  fake.origin = ORIGIN;
  const item = fake.createItem({ accounts: [{ name: 'Example Card', mask: '1234' }] });
  const call = async (path: string, body: Record<string, unknown>, headers: Record<string, string> = AUTH) => {
    const res = await fake.fetch(`${ORIGIN}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const sync = async (cursor?: string, count?: number) =>
    (await call('/transactions/sync', { access_token: item.accessToken, ...(cursor === undefined ? {} : { cursor }), ...(count === undefined ? {} : { count }) })).body as {
      added: Record<string, unknown>[]; modified: Record<string, unknown>[]; removed: Record<string, unknown>[]; next_cursor: string; has_more: boolean;
    };
  return { fake, item, accountId: item.accounts[0]!.account_id, call, sync };
}

describe('FakePlaid on the wire', () => {
  describe('/transactions/sync', () => {
    it('sends removed entries with only transaction_id and account_id', async () => {
      const s = setup();
      const tx = s.fake.addTransaction(s.item.itemId, { account_id: s.accountId });
      const { next_cursor } = await s.sync();
      s.fake.removeTransaction(tx.transaction_id);
      const page = await s.sync(next_cursor);
      expect(page.removed).toEqual([{ transaction_id: tx.transaction_id, account_id: s.accountId }]);
      expect(Object.keys(page.removed[0]!).sort()).toEqual(['account_id', 'transaction_id']);
    });

    it('can split pending to posted across pages, either way round', async () => {
      const s = setup();
      const one = s.fake.addTransaction(s.item.itemId, { account_id: s.accountId, pending: true });
      const two = s.fake.addTransaction(s.item.itemId, { account_id: s.accountId, pending: true });
      let cursor = (await s.sync()).next_cursor;
      const postedOne = s.fake.postPending(one.transaction_id);
      const postedTwo = s.fake.postPending(two.transaction_id, {}, { removedFirst: false });
      const pages = [];
      for (let more = true; more;) {
        const page = await s.sync(cursor, 1);
        pages.push({ added: page.added.map((t) => [t.transaction_id, t.pending, t.pending_transaction_id]), removed: page.removed.map((t) => t.transaction_id) });
        cursor = page.next_cursor;
        more = page.has_more;
      }
      expect(pages).toEqual([
        { added: [], removed: [one.transaction_id] },
        { added: [[postedOne.transaction_id, false, one.transaction_id]], removed: [] },
        { added: [[postedTwo.transaction_id, false, two.transaction_id]], removed: [] },
        { added: [], removed: [two.transaction_id] },
      ]);
    });

    it('answers no cursor with the current transactions only: no removed, and no superseded versions', async () => {
      const s = setup();
      const pending = s.fake.addTransaction(s.item.itemId, { account_id: s.accountId, pending: true, amount: 9 });
      const posted = s.fake.postPending(pending.transaction_id, { amount: 10 });
      const gone = s.fake.addTransaction(s.item.itemId, { account_id: s.accountId });
      s.fake.removeTransaction(gone.transaction_id);
      const page = await s.sync();
      expect(page.added.map((t) => [t.transaction_id, t.amount])).toEqual([[posted.transaction_id, 10]]);
      expect(page.modified).toEqual([]);
      expect(page.removed).toEqual([]);
      // `""` is read as no cursor.
      expect((await s.sync('')).added).toHaveLength(1);
    });

    it('answers "" as the cursor, with nothing, until the data is ready; never "" after', async () => {
      const s = setup();
      s.fake.addTransaction(s.item.itemId, { account_id: s.accountId });
      s.fake.setReady(s.item.itemId, false);
      expect(await s.sync()).toMatchObject({ added: [], next_cursor: '', has_more: false, transactions_update_status: 'NOT_READY' });
      s.fake.setReady(s.item.itemId, true);
      const page = await s.sync();
      expect(page.added).toHaveLength(1);
      expect(page.next_cursor).not.toBe('');
    });

    it('honours count from 1 to 500, defaulting to 100, and refuses anything else', async () => {
      const s = setup();
      for (let i = 0; i < 101; i++) s.fake.addTransaction(s.item.itemId, { account_id: s.accountId });
      expect((await s.sync()).added).toHaveLength(100);
      expect((await s.sync(undefined, 500)).added).toHaveLength(101);
      for (const count of [0, 501, 1.5]) {
        expect(await s.call('/transactions/sync', { access_token: s.item.accessToken, count })).toMatchObject({ status: 400, body: { error_code: 'INVALID_FIELD' } });
      }
      expect(await s.call('/transactions/sync', { access_token: s.item.accessToken, cursor: 'not-a-cursor' })).toMatchObject({ status: 400, body: { error_code: 'INVALID_FIELD' } });
    });
  });

  describe('errors', () => {
    it.each(Object.entries(FAKE_PLAID_ERRORS))('answers %s with its HTTP status and in PlaidError shape', async (_, error) => {
      const s = setup();
      s.fake.failNext('/accounts/get', error);
      const res = await s.call('/accounts/get', { access_token: s.item.accessToken });
      expect(res.status).toBe(error.status);
      expect(res.body).toEqual({
        error_type: error.error_type, error_code: error.error_code, error_code_reason: null, error_message: expect.any(String), display_message: null,
        request_id: expect.stringMatching(/^[0-9a-f]+$/), causes: [], documentation_url: expect.any(String), suggested_action: null,
      });
    });

    it('with trialLimit, refuses the exchange past that many Items with TRIAL_CONNECTION_LIMIT, as a 429', async () => {
      const s = setup(); // one Item already
      s.fake.trialLimit = 2;
      const exchange = async () => {
        const lt = (await s.call('/link/token/create', NEW_LINK)).body.link_token as string;
        const { publicToken } = s.fake.completeLink(lt);
        return s.call('/item/public_token/exchange', { public_token: publicToken });
      };
      expect((await exchange()).status).toBe(200);
      expect(await exchange()).toMatchObject({ status: 429, body: { error_type: 'RATE_LIMIT_EXCEEDED', error_code: 'TRIAL_CONNECTION_LIMIT' } });
      expect(s.fake.itemsCreated).toBe(2);
    });

    it('with strictMutation, fails a page when the log grew since the run began, and a run from its first cursor works', async () => {
      const s = setup();
      s.fake.strictMutation = true;
      for (let i = 0; i < 3; i++) s.fake.addTransaction(s.item.itemId, { account_id: s.accountId });
      const first = await s.sync(undefined, 1);
      expect(first.has_more).toBe(true);
      expect((await s.sync(first.next_cursor, 1)).has_more).toBe(true);
      s.fake.addTransaction(s.item.itemId, { account_id: s.accountId });
      expect(await s.call('/transactions/sync', { access_token: s.item.accessToken, cursor: first.next_cursor, count: 1 }))
        .toMatchObject({ status: 400, body: { error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' } });
      // Starting the run again, nothing changes under it, so it pages to the end.
      let page = await s.sync(undefined, 2);
      const seen = page.added.length;
      let total = seen;
      while (page.has_more) {
        page = await s.sync(page.next_cursor, 2);
        total += page.added.length + page.modified.length;
      }
      expect(total).toBe(4);
      // Off by default: a growth mid-run is just more changes.
      s.fake.strictMutation = false;
      const run = await s.sync(undefined, 1);
      s.fake.addTransaction(s.item.itemId, { account_id: s.accountId });
      expect((await s.call('/transactions/sync', { access_token: s.item.accessToken, cursor: run.next_cursor, count: 1 })).status).toBe(200);
    });

    it("answers an Item in an error state with that error on data calls, and in /item/get's item with a 200", async () => {
      const s = setup();
      s.fake.breakItem(s.item.itemId);
      expect(await s.call('/transactions/sync', { access_token: s.item.accessToken })).toMatchObject({ status: 400, body: { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' } });
      expect(await s.call('/item/get', { access_token: s.item.accessToken })).toMatchObject({ status: 200, body: { item: { error: { error_code: 'ITEM_LOGIN_REQUIRED' } } } });
    });
  });

  describe('the credentials', () => {
    it.each(PATHS)('are required on %s, before an injected error, which then waits for a call that has them', async (path) => {
      const s = setup();
      s.fake.failNext(path, FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
      const body = { access_token: s.item.accessToken };
      const { 'PLAID-SECRET': _secret, ...noSecret } = AUTH;
      expect(await s.call(path, body, noSecret)).toMatchObject({ status: 400, body: { error_type: 'INVALID_INPUT', error_code: 'INVALID_API_KEYS' } });
      expect(await s.call(path, body, { ...AUTH, 'PLAID-CLIENT-ID': 'someone-else' })).toMatchObject({ status: 400, body: { error_code: 'INVALID_API_KEYS' } });
      const { 'Plaid-Version': _version, ...noVersion } = AUTH;
      expect(await s.call(path, body, noVersion)).toMatchObject({ status: 400, body: { error_code: 'INVALID_HEADERS' } });
      expect(await s.call(path, body)).toMatchObject({ status: 500, body: { error_code: 'INTERNAL_SERVER_ERROR' } });
    });
  });

  describe('link tokens', () => {
    it("needs products for a new Item, and refuses them, and any product field, in update mode", async () => {
      const s = setup();
      const { products: _products, ...noProducts } = NEW_LINK;
      expect(await s.call('/link/token/create', noProducts)).toMatchObject({ status: 400, body: { error_code: 'MISSING_FIELDS' } });
      expect((await s.call('/link/token/create', NEW_LINK)).status).toBe(200);
      const update = { ...noProducts, access_token: s.item.accessToken };
      expect((await s.call('/link/token/create', update)).status).toBe(200);
      for (const extra of [{ products: ['transactions'] }, { required_if_supported_products: ['liabilities'] }, { transactions: { days_requested: 730 } }]) {
        expect(await s.call('/link/token/create', { ...update, ...extra })).toMatchObject({ status: 400, body: { error_code: 'INVALID_FIELD' } });
      }
    });

    it('allows the account filter in update mode only with Account Select on', async () => {
      const s = setup();
      const filters = { credit: { account_subtypes: ['credit card'] } };
      const { products: _products, ...update } = { ...NEW_LINK, access_token: s.item.accessToken };
      expect(await s.call('/link/token/create', { ...update, account_filters: filters })).toMatchObject({ status: 400, body: { error_code: 'INVALID_FIELD' } });
      expect((await s.call('/link/token/create', { ...update, account_filters: filters, update: { account_selection_enabled: true } })).status).toBe(200);
      expect(await s.call('/link/token/create', { ...NEW_LINK, update: { account_selection_enabled: true } })).toMatchObject({ status: 400, body: { error_code: 'INVALID_FIELD' } });
    });

    it("gives update mode a public token that can't be exchanged, and keeps the Item's access token", async () => {
      const s = setup();
      const { products: _products, ...update } = { ...NEW_LINK, access_token: s.item.accessToken };
      const linkToken = (await s.call('/link/token/create', update)).body.link_token as string;
      expect(linkToken).toMatch(/^link-sandbox-/);
      const { publicToken } = s.fake.completeLink(linkToken);
      expect(await s.call('/item/public_token/exchange', { public_token: publicToken })).toMatchObject({ status: 400, body: { error_type: 'INVALID_INPUT', error_code: 'INVALID_PUBLIC_TOKEN' } });
      expect(s.fake.itemsCreated).toBe(1);
      expect((await s.call('/item/get', { access_token: s.item.accessToken })).status).toBe(200);
    });
  });
});

describe('FakePlaid: Savings', () => {
  it('lists balances, and answers investment transactions in a window, newest first, by offset', async () => {
    const fake = new FakePlaid();
    const item = fake.createItem({ accounts: [{ name: 'Cash', type: 'depository', subtype: 'cash management', current: 10, available: 9 }, { name: 'Brokerage', type: 'investment', subtype: 'brokerage' }] });
    const [cash, brokerage] = item.accounts;
    const accounts = await post(fake, '/accounts/get', { access_token: item.accessToken });
    expect(accounts.accounts.map((a: { balances: unknown }) => a.balances)).toEqual([
      { available: 9, current: 10, limit: null, iso_currency_code: 'USD', unofficial_currency_code: null },
      { available: null, current: 0, limit: null, iso_currency_code: 'USD', unofficial_currency_code: null },
    ]);
    fake.addInvestmentTransaction(item.itemId, { account_id: brokerage!.account_id, date: '2026-10-31', amount: -1 });
    const kept = fake.addInvestmentTransaction(item.itemId, { account_id: brokerage!.account_id, date: '2026-11-02', amount: -2 });
    const body = await post(fake, '/investments/transactions/get', { access_token: item.accessToken, start_date: '2026-11-01', end_date: '2026-11-30' });
    expect(body.total_investment_transactions).toBe(1);
    expect(body.investment_transactions.map((t: { investment_transaction_id: string }) => t.investment_transaction_id)).toEqual([kept.investment_transaction_id]);
    fake.removeInvestmentTransaction(kept.investment_transaction_id);
    expect((await post(fake, '/investments/transactions/get', { access_token: item.accessToken, start_date: '2026-11-01', end_date: '2026-11-30' })).total_investment_transactions).toBe(0);
    expect(cash!.type).toBe('depository');
  });

  it('refuses Investments for an Item without it, and for a client without it, link tokens included', async () => {
    const fake = new FakePlaid();
    const without = fake.createItem({ investments: false });
    expect((await raw(fake, '/investments/transactions/get', { access_token: without.accessToken, start_date: '2026-11-01', end_date: '2026-11-02' })).status).toBe(400);
    fake.investmentsEnabled = false;
    const res = await raw(fake, '/link/token/create', {
      client_name: 'x', language: 'en', country_codes: ['US'], user: { client_user_id: 'u' }, products: ['transactions'], required_if_supported_products: ['investments'],
    });
    expect(await res.json()).toMatchObject({ error_type: 'INVALID_INPUT', error_code: 'INVALID_PRODUCT' });
  });

  it('makes an Item linked without Investments refuse it, and one linked with it allow it', async () => {
    const fake = new FakePlaid();
    const token = async (extra: Record<string, unknown>) =>
      (await post(fake, '/link/token/create', { client_name: 'x', language: 'en', country_codes: ['US'], user: { client_user_id: 'u' }, products: ['transactions'], ...extra })).link_token as string;
    const plain = fake.completeLink(await token({}));
    const withInv = fake.completeLink(await token({ required_if_supported_products: ['investments'] }));
    expect(fake.items.get([...fake.items.keys()].at(-2)!)!.investmentsSupported).toBe(false);
    expect(fake.items.get([...fake.items.keys()].at(-1)!)!.investmentsSupported).toBe(true);
    expect(plain.publicToken).not.toBe(withInv.publicToken);
  });
});
