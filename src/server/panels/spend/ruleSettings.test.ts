import { describe, expect, it } from 'vitest';
import { rules, transactions } from '../../db/schema.js';
import { makeTestApp } from '../../test/helpers.js';
import { addCard, categoryId, spendUser } from '../../test/spendFixtures.js';
import { applyRulesToPast } from './ruleSettings.js';

// The test app's clock is 2026-11-15 12:00 UTC. Merchants are made up.

describe('applyRulesToPast', () => {
  it('decides 20,000 transactions against 100 rules quickly, in one transaction', () => {
    const t = makeTestApp();
    const admin = spendUser(t);
    const card = addCard(t);
    const dining = categoryId(t, 'Dining');
    const groceries = categoryId(t, 'Groceries');
    const uncategorized = categoryId(t, 'Uncategorized');
    const now = t.clock.now();
    // The seeded PAYMENT rule is first; 99 more, of which the last two match something.
    t.db.insert(rules)
      .values(
        Array.from({ length: 99 }, (_, n) => ({
          position: n + 2,
          matchText: n === 97 ? 'Ｃｏｆｆｅｅ' : n === 98 ? 'market' : `Merchant ${n} that no row has`,
          matchType: 'contains' as const,
          setCategoryId: n === 97 ? dining : groceries,
          setPerson: n === 98 ? ('user' as const) : null,
          setPersonUserId: n === 98 ? admin.id : null,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();
    const rows = Array.from({ length: 20_000 }, (_, n) => ({
      cardId: card.id,
      source: 'csv' as const,
      date: `2026-${String((n % 10) + 1).padStart(2, '0')}-${String((n % 28) + 1).padStart(2, '0')}`,
      amountCents: 100 + n,
      rawName: n % 3 === 0 ? `BLUE COFFEE #${n} OAKLAND CA` : n % 3 === 1 ? `CORNER MARKET ${n}` : `SHOP NUMBER ${n} SOMEWHERE`,
      note: 'kept',
      categoryId: uncategorized,
      categorySource: 'default' as const,
      personSource: 'default' as const,
      createdAt: now,
      updatedAt: now,
    }));
    for (let i = 0; i < rows.length; i += 1_000) t.db.insert(transactions).values(rows.slice(i, i + 1_000)).run();

    const started = performance.now();
    const changed = applyRulesToPast({ db: t.db, clock: t.clock, logger: t.logger });
    const ms = performance.now() - started;

    // A third are coffee (Dining, by the full-width rule), a third are markets (Groceries, and the admin).
    expect(changed).toBe(Math.ceil(20_000 / 3) + Math.floor((20_000 + 1) / 3));
    const after = t.db.select().from(transactions).all();
    expect(after.filter((r) => r.categoryId === dining && r.categorySource === 'rule')).toHaveLength(Math.ceil(20_000 / 3));
    expect(after.filter((r) => r.categoryId === groceries && r.personUserId === admin.id && r.personSource === 'rule')).toHaveLength(Math.floor((20_000 + 1) / 3));
    expect(after.filter((r) => r.categorySource === 'default' && r.personSource === 'default')).toHaveLength(20_000 - changed);
    // Only the decided fields and updatedAt change.
    expect(after.every((r) => r.note === 'kept' && r.rawName !== '')).toBe(true);
    // About 0.1 s on its own on a dev machine, and 0.33 s with the whole suite running beside it.
    // The budget is about 10 times that, so a busy machine doesn't fail it. That's looser than the
    // 1.4 s this took before rule text was normalized once and the update prepared, so it now
    // catches only a much bigger slowdown; SQLite's time can't be counted the way the matcher's
    // work is.
    expect(ms).toBeLessThan(3_000);
  });
});
