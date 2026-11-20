import { eq } from 'drizzle-orm';
import { cards, categories, csvImports, transactions, type CardRow, type TransactionRow } from '../db/schema.js';
import { addUser, cookieFor, type TestApp } from './helpers.js';

/** Test helpers for the Spend panel. Data is made up. */

/** A new user with the Spend panel (and an admin by default), and their session cookie. */
export function spendUser(t: TestApp, opts: { role?: 'admin' | 'member'; email?: string; name?: string } = {}): { id: number; cookie: string } {
  const role = opts.role ?? 'admin';
  const email = opts.email ?? `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const id = addUser(t.db, t.clock, { email, displayName: opts.name ?? email.split('@')[0]!, role, panels: ['spend'] });
  return { id, cookie: cookieFor(t.db, t.clock, id) };
}

export function categoryId(t: TestApp, name: string): number {
  const row = t.db.select().from(categories).where(eq(categories.name, name)).get();
  if (!row) throw new Error(`no category ${name}`);
  return row.id;
}

export function addCard(t: TestApp, patch: Partial<typeof cards.$inferInsert> = {}): CardRow {
  const now = t.clock.now();
  return t.db.insert(cards).values({ nickname: 'Visa', mask: '1234', included: true, usualClosingDay: 15, createdAt: now, updatedAt: now, ...patch }).returning().get();
}

/** A CSV import on `cardId`, by a new admin, for CSV rows that came from a file (`csvImportId`). */
export function addCsvImport(t: TestApp, cardId: number): typeof csvImports.$inferSelect {
  const by = spendUser(t);
  return t.db.insert(csvImports)
    .values({ cardId, fileSha256: `synthetic-${Math.random().toString(36).slice(2)}`, uploadedByUserId: by.id, uploadedAt: t.clock.now(), rowCount: 0, importedCount: 0, skippedCount: 0 })
    .returning().get();
}

/** A CSV transaction on `cardId`, Uncategorized and Household unless `patch` says otherwise. */
export function addTransaction(t: TestApp, cardId: number, patch: Partial<typeof transactions.$inferInsert> = {}): TransactionRow {
  const now = t.clock.now();
  return t.db
    .insert(transactions)
    .values({
      cardId,
      source: 'csv',
      date: '2026-11-10',
      amountCents: 1_000,
      rawName: 'SHOP',
      categoryId: categoryId(t, 'Uncategorized'),
      categorySource: 'default',
      personSource: 'default',
      createdAt: now,
      updatedAt: now,
      ...patch,
    })
    .returning()
    .get();
}

export function transaction(t: TestApp, id: number): TransactionRow {
  return t.db.select().from(transactions).where(eq(transactions.id, id)).get()!;
}
