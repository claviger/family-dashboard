import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { SystemInfo } from '../../shared/api.js';
import { singleKeyring } from '../core/crypto.js';
import { calendarCache, calendarLinkPending, cards, connections, pendingRevocations, plaidItems, todos, transactions } from '../db/schema.js';
import { addUser, call, cookieFor, linkCalendarForTest, linkTodoistForTest, makeTestApp, TEST_ENCRYPTION_KEY } from '../test/helpers.js';
import { addCard, addTransaction } from '../test/spendFixtures.js';
import { checkTokenKey, keyMismatchWarning } from './keyCheck.js';
import { resetLinksForNewKey } from './keyReset.js';

function setup(opts: { todoist?: boolean } = {}) {
  const t = makeTestApp({ keyMismatch: true, ...opts });
  const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin', panels: ['calendar', 'todo'] });
  return { t, admin, cookie: cookieFor(t.db, t.clock, admin) };
}

describe('resetLinksForNewKey', () => {
  it('forgets the calendar link and the Todoist links, stores a check for the key, and turns both back on', async () => {
    const { t, admin, cookie } = setup({ todoist: true });
    const { calendar } = linkCalendarForTest(t, admin);
    linkTodoistForTest(t, admin);
    t.db.insert(todos).values({ ownerUserId: admin, backend: 'todoist', title: 'Milk', todoistTaskId: 'abcdefghijklmnop', createdAt: t.clock.now(), updatedAt: t.clock.now() }).run();
    t.db.insert(calendarCache).values({ calendarId: calendar.id, timeZone: 'UTC', windowStart: '2026-11-15', windowEnd: '2026-11-22', fetchedAt: t.clock.now(), fetchStartedAt: t.clock.now(), events: [] }).run();
    t.db.insert(calendarLinkPending).values({ userId: admin, sessionHash: 'h', credentialsEnc: 'v1.x', calendars: [], createdAt: t.clock.now(), expiresAt: t.clock.now() }).run();
    const system = async () => (await (await call(t.app, 'GET', '/api/admin/system', { cookie })).json()) as { warnings: string[]; keyMismatch: boolean };
    expect(await system()).toMatchObject({ warnings: [keyMismatchWarning({ todoist: true })], keyMismatch: true });

    const res = await call(t.app, 'POST', '/api/admin/integrations/reset-links', { cookie });
    expect(await res.json()).toEqual({ calendarDisconnected: true, todoistUnlinked: 1, banksForgotten: 0 });
    expect(t.db.select().from(connections).all()).toEqual([]);
    expect(t.db.select().from(calendarCache).all()).toEqual([]);
    expect(t.db.select().from(calendarLinkPending).all()).toEqual([]);
    expect(t.db.select().from(todos).get()).toMatchObject({ title: 'Milk', backend: 'internal', deletedAt: null });
    expect(t.fakeGoogleCalendar.requests).toEqual([]);
    expect(await system()).toMatchObject({ warnings: [], keyMismatch: false });
    expect(t.calendar.keyMismatch).toBe(false);
    expect(checkTokenKey(t.db, singleKeyring(TEST_ENCRYPTION_KEY))).toBe('ok');
  });

  it('works without Todoist configured', async () => {
    const { t, admin, cookie } = setup();
    linkCalendarForTest(t, admin);
    // The System page doesn't mention Todoist when it isn't set up (R4-M7).
    const info = (await (await call(t.app, 'GET', '/api/admin/system', { cookie })).json()) as { warnings: string[] };
    expect(info.warnings).toEqual([keyMismatchWarning({ todoist: false })]);
    expect(await resetLinksForNewKey(t)).toEqual({ calendarDisconnected: true, todoistUnlinked: 0, banksForgotten: 0 });
    expect(t.calendar.keyMismatch).toBe(false);
  });

  it('forgets every bank with Plaid configured: connections gone, waiting removals and the forgotten banks become notices, banks and cards removed, transactions kept (departure 10)', async () => {
    const t = makeTestApp({ keyMismatch: true, plaid: true });
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin', panels: ['spend'] });
    const cookie = cookieFor(t.db, t.clock, admin);
    const now = t.clock.now();
    // Saved with the old key: nothing here can be read now. Synthetic ids.
    const conn = t.db.insert(connections).values({ kind: 'plaid', scope: 'family', ownerUserId: admin, credentialsEnc: 'v1.x', meta: { itemId: 'item-synthetic-1', institutionName: 'Example Bank' }, createdAt: now, updatedAt: now }).returning().get();
    const item = t.db.insert(plaidItems).values({ connectionId: conn.id, plaidItemId: 'item-synthetic-1', institutionName: 'Example Bank', pickedAt: now, createdAt: now, updatedAt: now }).returning().get();
    const card = addCard(t, { plaidItemId: item.id, plaidAccountId: 'acct-synthetic-1' });
    const tx = addTransaction(t, card.id, { source: 'plaid', plaidTransactionId: 'tx-synthetic-1', plaidAccountId: 'acct-synthetic-1' });
    const pending = addTransaction(t, card.id, { source: 'plaid', plaidTransactionId: 'tx-synthetic-2', plaidAccountId: 'acct-synthetic-1', pending: true });
    const waiting = t.db.insert(pendingRevocations).values({ kind: 'plaid', ownerUserId: admin, accountId: 'item-synthetic-0', credentialsEnc: 'v1.x', createdAt: now }).returning().get();
    const gaveUp = t.db.insert(pendingRevocations).values({ kind: 'plaid', ownerUserId: admin, accountId: 'item-synthetic-1', credentialsEnc: '', gaveUpAt: now, createdAt: now }).returning().get();

    const system = async () => (await (await call(t.app, 'GET', '/api/admin/system', { cookie })).json()) as SystemInfo;
    const before = await system();
    // One line for the key, naming the banks, then Plaid's own: the removal it's still trying.
    expect(before.warnings).toEqual([keyMismatchWarning({ todoist: false, plaid: true }), expect.stringContaining("Plaid didn't confirm ending a removed bank connection")]);
    expect(before).toMatchObject({ keyMismatch: true, plaidConfigured: true, todoistConfigured: false });
    expect(before.revocationNotices).toEqual([{ id: gaveUp.id, message: expect.stringContaining('Example Bank') }]);

    const res = await call(t.app, 'POST', '/api/admin/integrations/reset-links', { cookie });
    expect(await res.json()).toEqual({ calendarDisconnected: false, todoistUnlinked: 0, banksForgotten: 1 });
    expect(t.db.select().from(connections).all()).toEqual([]);
    // Nothing holds a token now. The waiting removal and the forgotten bank become lasting notices
    // to end the access at the bank or my.plaid.com (review C-S-M2): one per bank, so the forgotten
    // bank's is the one already given up on.
    const rows = t.db.select().from(pendingRevocations).all();
    expect(rows.map((r) => [r.id, r.accountId, r.credentialsEnc, r.gaveUpAt])).toEqual([
      [waiting.id, 'item-synthetic-0', '', now], [gaveUp.id, 'item-synthetic-1', '', now],
    ]);
    expect(t.db.select().from(plaidItems).where(eq(plaidItems.id, item.id)).get()).toMatchObject({ removedReason: 'key_reset', connectionId: null, removedAt: now });
    expect(t.db.select().from(cards).where(eq(cards.id, card.id)).get()!.removedAt).toEqual(now);
    // Posted rows are kept as they were; the bank will never post its pending ones, so they go to the prune.
    expect(t.db.select().from(transactions).where(eq(transactions.id, tx.id)).get()).toMatchObject({ deletedAt: null, removedAt: null });
    expect(t.db.select().from(transactions).where(eq(transactions.id, pending.id)).get()).toMatchObject({ deletedAt: now, removedAt: now });
    expect(t.fakePlaid.requests).toEqual([]);
    expect(t.plaid!.keyMismatch).toBe(false);
    expect(checkTokenKey(t.db, singleKeyring(TEST_ENCRYPTION_KEY))).toBe('ok');
    const after = await system();
    expect(after).toMatchObject({ warnings: [], keyMismatch: false });
    expect(after.revocationNotices).toHaveLength(2);
  });

  it('is refused while bank connections need the old key and Plaid is no longer configured', async () => {
    const { t: m, admin } = setup();
    m.db.insert(connections).values({ kind: 'plaid', scope: 'family', ownerUserId: admin, credentialsEnc: 'v1.x', createdAt: m.clock.now(), updatedAt: m.clock.now() }).run();
    await expect(resetLinksForNewKey(m)).rejects.toMatchObject({
      code: 'conflict', message: 'Bank connections are still saved with the old key, so nothing was reset. Put the original key back, or set Plaid up again and retry.',
    });
  });

  it('is refused while the key matches, and while a bank connection still needs the old key', async () => {
    const t = makeTestApp();
    await expect(resetLinksForNewKey(t)).rejects.toMatchObject({ code: 'conflict' });
    const { t: m, admin } = setup();
    m.db.insert(connections).values({ kind: 'plaid', scope: 'family', ownerUserId: admin, credentialsEnc: 'v1.x', createdAt: m.clock.now(), updatedAt: m.clock.now() }).run();
    await expect(resetLinksForNewKey(m)).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/^Bank connections/) });
    expect(m.calendar.keyMismatch).toBe(true);
  });

  it('refuses before forgetting the calendar link when something it can not reset still needs the old key (R4-M1)', async () => {
    const cases: { name: string; todoist: boolean; add: (t: ReturnType<typeof setup>['t'], admin: number) => void }[] = [
      {
        name: 'a Todoist link, with Todoist not configured',
        todoist: false,
        add: (t, admin) => t.db.insert(connections).values({ kind: 'todoist', scope: 'user', ownerUserId: admin, credentialsEnc: 'v1.x', createdAt: t.clock.now(), updatedAt: t.clock.now() }).run(),
      },
      {
        name: 'a Todoist revocation, with Todoist not configured',
        todoist: false,
        add: (t, admin) => t.db.insert(pendingRevocations).values({ kind: 'todoist', ownerUserId: admin, credentialsEnc: 'v1.x', createdAt: t.clock.now() }).run(),
      },
      {
        name: 'a bank revocation, with Todoist configured',
        todoist: true,
        add: (t, admin) => t.db.insert(pendingRevocations).values({ kind: 'plaid', ownerUserId: admin, credentialsEnc: 'v1.x', createdAt: t.clock.now() }).run(),
      },
    ];
    for (const c of cases) {
      const { t, admin } = setup({ todoist: c.todoist });
      linkCalendarForTest(t, admin);
      c.add(t, admin);
      await expect(resetLinksForNewKey(t), c.name).rejects.toMatchObject({ code: 'conflict' });
      expect(t.calendar.connection(), c.name).toBeDefined();
      expect(t.calendar.keyMismatch, c.name).toBe(true);
    }
  });
});
