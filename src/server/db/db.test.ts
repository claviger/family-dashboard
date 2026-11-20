import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from './index.js';
import { asc, eq } from 'drizzle-orm';
import {
  cards, categories, categoryMappings, connections, plaidItems, plaidLinkPending, rules, savingsAccounts, savingsBalances, savingsFlows, savingsImportPreviews, savingsImportProfiles, savingsImports, transactions, users,
} from './schema.js';

/** The migrations that came after production data existed (phase 4 on). */
function laterMigrations(): string[] {
  return readdirSync('drizzle').filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) >= 4);
}

/**
 * What a migration does that isn't purely additive, one line per statement: a drop, a table
 * rebuild (`__new_`) or rename, a `DELETE FROM` or `UPDATE` of rows already there, or a column
 * added `NOT NULL` without a `DEFAULT` (which fails, or rewrites, on a table with rows). Comments
 * and `ON UPDATE` / `ON DELETE` clauses don't count.
 */
function migrationProblems(sql: string): string[] {
  const problems: string[] = [];
  for (const raw of sql.split(/--> statement-breakpoint|;/)) {
    const stmt = raw.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
    if (stmt === '') continue;
    if (/\bDROP\s/i.test(stmt) || /__new_/i.test(stmt) || /\bRENAME\s/i.test(stmt)) problems.push(`drops, rebuilds or renames: ${stmt}`);
    if (/^DELETE\s+FROM\b/i.test(stmt)) problems.push(`deletes rows: ${stmt}`);
    if (/^UPDATE\s/i.test(stmt)) problems.push(`updates rows: ${stmt}`);
    if (/^ALTER\s+TABLE\s+\S+\s+ADD\s/i.test(stmt) && /\bNOT\s+NULL\b/i.test(stmt) && !/\bDEFAULT\b/i.test(stmt)) {
      problems.push(`adds a NOT NULL column without a DEFAULT: ${stmt}`);
    }
  }
  return problems;
}

/**
 * Migrations reviewed to change rows or tables already there: how many problems the guard reports
 * for each (one statement can report two), and the tables every one of them must name. Each has its
 * own upgrade test. Every other migration from phase 4 on must stay purely additive.
 */
const REVIEWED_MIGRATIONS: Record<string, { problems: number; tables: RegExp }> = {
  // The chore board: chore_occurrences is rebuilt so due_date can be null (create, copy, carry the
  // AUTOINCREMENT counter over in sqlite_sequence with a delete and an insert, drop, rename),
  // chores.default_assignee_user_id is renamed, open occurrences nobody had are deleted, and two
  // updates move assignment onto the chores. See 'the chore board migration (0009)'.
  // sqlite_sequence is allowed here only, and only for the rebuilt table's own counter.
  '0009_chore_board.sql': {
    problems: 11,
    tables: /`(chores|chore_occurrences|__new_chore_occurrences)`|`sqlite_sequence` .*'(__new_)?chore_occurrences'/,
  },
  // The Savings CSV import: savings_accounts is rebuilt so its Plaid ids can be null. Drizzle runs a
  // migration inside one transaction, where foreign keys can't be turned off, so dropping the old
  // accounts table would cascade-delete every balance and flow. Its two child tables are rebuilt with
  // it (create, copy, carry each AUTOINCREMENT counter in sqlite_sequence with a delete and an insert,
  // drop the children first, rename). See 'the Savings CSV migration (0012)'. sqlite_sequence is
  // allowed here only for those three tables' own counters.
  '0012_savings_csv.sql': {
    problems: 22,
    tables: /`(__new_)?savings_(accounts|balances|flows)`|`sqlite_sequence` .*'(__new_)?savings_(accounts|balances|flows)'/,
  },
};

/** A copy of the migrations that stops at `lastIdx`: what an install of that phase had applied. */
function migrationsUpTo(lastIdx: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'fd-migrations-'));
  cpSync('drizzle', dir, { recursive: true });
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= lastIdx);
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
  return dir;
}

describe('openDb', () => {
  it('applies migrations and enables foreign keys', () => {
    const { db, sqlite } = openDb(':memory:');
    const tables = sqlite
      .prepare("select name from sqlite_master where type='table' order by name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'calendar_cache', 'calendar_link_pending', 'cards', 'categories', 'category_mappings', 'chore_occurrences', 'chore_todo_actions',
        'chores', 'connections', 'csv_import_previews', 'csv_imports', 'job_errors', 'panel_grants', 'pending_revocations', 'plaid_items',
        'plaid_link_pending', 'rules', 'sessions', 'settings', 'statements', 'todoist_state', 'todos', 'transactions', 'user_prefs', 'users',
        'savings_accounts', 'savings_balances', 'savings_flows', 'savings_import_previews', 'savings_import_profiles', 'savings_imports',
      ]),
    );
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.select().from(users).all()).toEqual([]);
  });

  it('has a migration guard that refuses what could change or lose rows already there', () => {
    const refused = [
      'DROP TABLE `todos`;',
      'CREATE TABLE `__new_todos` (`id` integer);',
      'ALTER TABLE `todos` RENAME TO `old_todos`;',
      "DELETE FROM `transactions` WHERE `source` = 'plaid';",
      'delete  from transactions;',
      'UPDATE `transactions` SET `deleted_at` = 1;',
      "CREATE TABLE `a` (`id` integer);--> statement-breakpoint\nupdate `todos` set `title` = '';",
      'ALTER TABLE `cards` ADD `plaid_mask` text NOT NULL;',
      'ALTER TABLE `cards` ADD COLUMN `plaid_mask` text NOT NULL;',
    ];
    for (const sql of refused) expect(migrationProblems(sql), sql).not.toEqual([]);
    const allowed = [
      'ALTER TABLE `cards` ADD `plaid_mask` text;',
      'ALTER TABLE `todos` ADD `todoist_recurring` integer DEFAULT false NOT NULL;',
      'ALTER TABLE `todos` ADD COLUMN `n` integer NOT NULL DEFAULT 0;',
      'CREATE TABLE `x` (`id` integer, `updated_at` integer NOT NULL, FOREIGN KEY (`id`) REFERENCES `y`(`id`) ON UPDATE no action ON DELETE cascade);',
      "-- The two special ones can't be deleted or updated.\nINSERT INTO `categories` (`name`) VALUES ('Groceries');",
    ];
    for (const sql of allowed) expect(migrationProblems(sql), sql).toEqual([]);
  });

  it("adds phase 4's columns without rebuilding, dropping, or renaming anything", () => {
    // The todos and chore tables hold production data: from phase 4 on, migrations may only add.
    expect(laterMigrations().length).toBeGreaterThan(0);
    for (const file of laterMigrations()) {
      const problems = migrationProblems(readFileSync(`drizzle/${file}`, 'utf8'));
      const reviewed = REVIEWED_MIGRATIONS[file];
      if (reviewed === undefined) {
        expect(problems, file).toEqual([]);
        continue;
      }
      expect(problems, file).toHaveLength(reviewed.problems);
      for (const p of problems) expect(p, file).toMatch(reviewed.tables);
    }
    const { sqlite } = openDb(':memory:');
    const columns = (sqlite.prepare("select name from pragma_table_info('todos')").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['todoist_task_id', 'todoist_project_id', 'todoist_recurring', 'todoist_due_timezone', 'todoist_move_error']));
  });

  it('keeps the to-dos and chores of a phase 3 database when it upgrades', () => {
    const phase3 = migrationsUpTo(3);

    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: phase3 });
    const tables = () => (sqlite.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables()).not.toContain('connections');
    sqlite.exec(`
      insert into users (id, email, display_name, color, role, created_at) values (1, 'kid@example.com', 'Kid', '#378ADD', 'member', 1);
      insert into todos (id, owner_user_id, title, notes, due_date, due_time, chore_occurrence_id, created_at, updated_at)
        values (1, 1, 'Feed cat', 'Wet food', '2026-11-20', '08:00', 1, 1, 2);
      insert into todos (id, owner_user_id, title, completed_at, created_at, updated_at) values (2, 1, 'Done', 3, 1, 3);
      insert into chores (id, title, schedule_type, schedule, start_date, created_at, updated_at)
        values (1, 'Feed cat', 'fixed', '{"kind":"daily"}', '2026-11-01', 1, 1);
      insert into chore_occurrences (id, chore_id, title_snapshot, due_date, assignee_user_id, assignment_source, todo_id, todo_sync_status, todo_attempts, todo_retry_at, created_at, updated_at)
        values (1, 1, 'Feed cat', '2026-11-20', 1, 'default', 1, 'pending', 2, 5, 1, 1);
      insert into chore_todo_actions (todo_id, owner_user_id, action, attempts, retry_at, created_at) values (2, 1, 'remove', 1, 9, 1);
    `);
    const before = {
      todos: sqlite.prepare('select * from todos order by id').all(),
      occurrences: sqlite.prepare('select * from chore_occurrences').all(),
      actions: sqlite.prepare('select * from chore_todo_actions').all(),
    };

    migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });

    expect(tables()).toEqual(expect.arrayContaining(['connections', 'todoist_state']));
    // Every old column keeps its value, and the new ones have their defaults.
    expect(sqlite.prepare('select * from todos order by id').all()).toEqual(
      (before.todos as object[]).map((row) => ({
        ...row,
        todoist_task_id: null, todoist_account_id: null, todoist_project_id: null, todoist_recurring: 0, todoist_due_timezone: null, todoist_move_error: null,
        todoist_move_attempted_at: null, todoist_move_replays: 0,
      })),
    );
    expect(sqlite.prepare('select * from chore_occurrences').all()).toEqual(
      (before.occurrences as object[]).map((row) => ({ ...row, todo_stuck_at: null, todo_last_error: null })),
    );
    expect(sqlite.prepare('select * from chore_todo_actions').all()).toEqual(
      (before.actions as object[]).map((row) => ({ ...row, stuck_at: null, last_error: null })),
    );
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps every row of a phase 4 database, Todoist links included, when it upgrades', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: migrationsUpTo(4) });
    const tables = () => (sqlite.prepare("select name from sqlite_master where type='table' order by name").all() as { name: string }[]).map((t) => t.name);
    expect(tables()).not.toContain('calendar_cache');
    sqlite.exec(`
      insert into users (id, email, display_name, color, role, created_at) values (1, 'alex@example.com', 'Alex', '#378ADD', 'admin', 1);
      insert into settings (key, value) values ('time_zone', 'America/Los_Angeles'), ('token_key_check', 'v1.a.b.c');
      insert into todos (id, owner_user_id, backend, title, todoist_task_id, todoist_account_id, created_at, updated_at)
        values (1, 1, 'todoist', 'Buy milk', 'abc', 'acct', 1, 2);
      insert into connections (id, kind, scope, owner_user_id, credentials_enc, status, meta, created_at, updated_at)
        values (1, 'todoist', 'user', 1, 'v1.x.y.z', 'ok', '{"account":"alex@example.com"}', 1, 1);
      insert into todoist_state (user_id, todoist_user_id, uuid_seed, created_at, updated_at) values (1, 'acct', 'seed', 1, 1);
      insert into pending_revocations (id, kind, owner_user_id, credentials_enc, account_id, created_at) values (1, 'todoist', 1, 'v1.p.q.r', 'old', 1);
    `);
    const names = ['users', 'settings', 'todos', 'connections', 'todoist_state', 'pending_revocations'];
    const before = Object.fromEntries(names.map((n) => [n, sqlite.prepare(`select * from ${n}`).all()]));

    migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });

    expect(tables()).toEqual(expect.arrayContaining(['calendar_cache', 'calendar_link_pending']));
    // Every row keeps its values. pending_revocations gains two columns, empty for the rows it had.
    const added: Record<string, object> = { pending_revocations: { account_email: null, gave_up_at: null } };
    for (const n of names) expect(sqlite.prepare(`select * from ${n}`).all(), n).toEqual((before[n] as object[]).map((row) => ({ ...row, ...added[n] })));
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('allows exactly one family Google Calendar connection, and leaves user and Plaid connections alone', () => {
    const { db } = openDb(':memory:');
    const now = new Date('2026-11-15T12:00:00Z');
    const admin = db.insert(users).values({ email: 'a@example.com', displayName: 'A', color: '#378ADD', role: 'admin', createdAt: now }).returning().get().id;
    const row = (kind: 'google_calendar' | 'plaid' | 'todoist', scope: 'family' | 'user') =>
      ({ kind, scope, ownerUserId: admin, credentialsEnc: 'v1.x', createdAt: now, updatedAt: now });
    db.insert(connections).values(row('google_calendar', 'family')).run();
    expect(() => db.insert(connections).values(row('google_calendar', 'family')).run()).toThrow(/UNIQUE/);
    db.insert(connections).values(row('plaid', 'family')).run();
    db.insert(connections).values(row('plaid', 'family')).run();
    db.insert(connections).values(row('todoist', 'user')).run();
    expect(db.select().from(connections).all()).toHaveLength(4);
  });
});

describe('the Spend tables (phase 6a)', () => {
  const NOW = new Date('2026-11-15T12:00:00Z');

  it('keeps every row of a phase 5 database when it upgrades, and only adds tables', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: migrationsUpTo(5) });
    const tables = () => (sqlite.prepare("select name from sqlite_master where type='table' order by name").all() as { name: string }[]).map((t) => t.name);
    const phase5 = tables();
    expect(phase5).not.toContain('transactions');
    sqlite.exec(`
      insert into users (id, email, display_name, color, role, created_at) values (1, 'alex@example.com', 'Alex', '#378ADD', 'admin', 1);
      insert into panel_grants (user_id, panel_id) values (1, 'spend');
      insert into settings (key, value) values ('time_zone', 'America/Los_Angeles');
      insert into todos (id, owner_user_id, title, created_at, updated_at) values (1, 1, 'Buy milk', 1, 2);
      insert into chores (id, title, schedule_type, schedule, start_date, created_at, updated_at) values (1, 'Feed cat', 'fixed', '{"kind":"daily"}', '2026-11-01', 1, 1);
      insert into connections (id, kind, scope, owner_user_id, credentials_enc, status, meta, created_at, updated_at)
        values (1, 'google_calendar', 'family', 1, 'v1.x.y.z', 'ok', '{"calendarId":"c"}', 1, 1);
      insert into calendar_cache (calendar_id, time_zone, window_start, window_end, fetched_at, fetch_started_at, events)
        values ('c', 'America/Los_Angeles', '2026-11-15', '2026-11-22', 1, 1, '[]');
    `);
    const names = ['users', 'panel_grants', 'settings', 'todos', 'chores', 'connections', 'calendar_cache'];
    const before = Object.fromEntries(names.map((n) => [n, sqlite.prepare(`select * from ${n}`).all()]));

    migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });

    // 0009 renames chores.default_assignee_user_id to assignee_user_id, keeping its value.
    const renamed = (n: string, rows: unknown) =>
      n !== 'chores'
        ? rows
        : (rows as Record<string, unknown>[]).map(({ default_assignee_user_id, ...row }) => ({ ...row, assignee_user_id: default_assignee_user_id }));
    for (const n of names) expect(sqlite.prepare(`select * from ${n}`).all(), n).toEqual(renamed(n, before[n]));
    expect(tables().filter((t) => !phase5.includes(t))).toEqual([
      'cards', 'categories', 'category_mappings', 'csv_import_previews', 'csv_imports', 'plaid_items', 'plaid_link_pending', 'rules',
      // 0011 (Savings).
      'savings_accounts', 'savings_balances', 'savings_flows',
      'savings_import_previews', 'savings_import_profiles', 'savings_imports', // 0012 (Savings CSV import).
      'statements', 'transactions',
    ]);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('seeds the default categories in order, with one of each special kind', () => {
    const { db } = openDb(':memory:');
    const rows = db.select().from(categories).orderBy(asc(categories.sortOrder)).all();
    expect(rows.map((c) => c.name)).toEqual([
      'Groceries', 'Dining', 'Gas and auto', 'Shopping', 'Home', 'Utilities', 'Subscriptions', 'Entertainment', 'Travel', 'Health', 'Kids',
      'Gifts and donations', 'Fees and interest', 'Other', 'Payments and transfers', 'Uncategorized',
    ]);
    expect(rows.filter((c) => c.kind !== 'normal').map((c) => [c.name, c.kind])).toEqual([
      ['Payments and transfers', 'excluded'],
      ['Uncategorized', 'uncategorized'],
    ]);
    expect(rows.every((c) => !c.archived && c.createdAt.getTime() > 0)).toBe(true);
  });

  it("seeds the research's PFCv2 mapping: all 18 primaries, and the detailed codes that differ", () => {
    const { db } = openDb(':memory:');
    const names = new Map(db.select().from(categories).all().map((c) => [c.id, c.name]));
    const mapping = new Map(db.select().from(categoryMappings).all().map((m) => [m.plaidPfc, { name: names.get(m.categoryId), v: m.taxonomyVersion }]));
    const primaries = [
      'INCOME', 'LOAN_DISBURSEMENTS', 'LOAN_PAYMENTS', 'TRANSFER_IN', 'TRANSFER_OUT', 'BANK_FEES', 'ENTERTAINMENT', 'FOOD_AND_DRINK',
      'GENERAL_MERCHANDISE', 'HOME_IMPROVEMENT', 'MEDICAL', 'PERSONAL_CARE', 'GENERAL_SERVICES', 'GOVERNMENT_AND_NON_PROFIT',
      'TRANSPORTATION', 'TRAVEL', 'RENT_AND_UTILITIES', 'OTHER',
    ];
    for (const p of primaries) expect(mapping.has(p), p).toBe(true);
    expect(mapping.size).toBe(33);
    expect([...mapping.values()].every((m) => m.v === 'v2')).toBe(true);
    // The spec's examples (§12.7), and the research's judgment calls that matter most.
    expect(mapping.get('FOOD_AND_DRINK_GROCERIES')?.name).toBe('Groceries');
    expect(mapping.get('FOOD_AND_DRINK')?.name).toBe('Dining');
    expect(mapping.get('TRANSPORTATION')?.name).toBe('Gas and auto');
    for (const p of ['LOAN_PAYMENTS', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_DISBURSEMENTS', 'INCOME']) expect(mapping.get(p)?.name, p).toBe('Payments and transfers');
    expect(mapping.get('OTHER')?.name).toBe('Uncategorized');
    expect(mapping.get('GENERAL_MERCHANDISE_SUPERSTORES')?.name).toBe('Shopping');
  });

  it('seeds one rule: a credit whose payee contains PAYMENT is Payments and transfers', () => {
    const { db } = openDb(':memory:');
    const excluded = db.select().from(categories).all().find((c) => c.kind === 'excluded')!;
    expect(db.select().from(rules).all()).toEqual([
      expect.objectContaining({
        position: 1, matchText: 'PAYMENT', matchType: 'contains', cardId: null, minCents: null, maxCents: -1, setCategoryId: excluded.id,
        setPerson: null, setPersonUserId: null,
      }),
    ]);
  });

  it('refuses a second special category, a name that differs only in case, and a closing day outside 1 to 31', () => {
    const { db } = openDb(':memory:');
    const cat = (name: string, kind: 'normal' | 'excluded' | 'uncategorized' = 'normal') =>
      db.insert(categories).values({ name, kind, sortOrder: 99, createdAt: NOW, updatedAt: NOW }).run();
    expect(() => cat('Transfers', 'excluded')).toThrow(/UNIQUE/);
    expect(() => cat('Still nothing', 'uncategorized')).toThrow(/UNIQUE/);
    expect(() => cat('groceries')).toThrow(/UNIQUE/);
    cat('Pets');
    const card = (day: number | null) => db.insert(cards).values({ nickname: 'Visa', usualClosingDay: day, createdAt: NOW, updatedAt: NOW }).run();
    card(null);
    card(1);
    card(31);
    expect(() => card(0)).toThrow(/CHECK/);
    expect(() => card(32)).toThrow(/CHECK/);
  });

  it('refuses a rule with no action, or a person action without its user', () => {
    const { db } = openDb(':memory:');
    const base = { position: 2, matchText: 'X', matchType: 'contains' as const, createdAt: NOW, updatedAt: NOW };
    const uid = db.insert(users).values({ email: 'a@example.com', displayName: 'A', color: '#378ADD', role: 'admin', createdAt: NOW }).returning().get().id;
    expect(() => db.insert(rules).values(base).run()).toThrow(/CHECK/);
    expect(() => db.insert(rules).values({ ...base, setPerson: 'user' }).run()).toThrow(/CHECK/);
    expect(() => db.insert(rules).values({ ...base, setPerson: 'household', setPersonUserId: uid }).run()).toThrow(/CHECK/);
    expect(() => db.insert(rules).values({ ...base, setPersonUserId: uid }).run()).toThrow(/CHECK/);
    db.insert(rules).values({ ...base, setPerson: 'user', setPersonUserId: uid }).run();
    db.insert(rules).values({ ...base, setPerson: 'household' }).run();
  });

  it("keeps a Plaid Item's row when its connection is deleted, without the connection", () => {
    const { db } = openDb(':memory:');
    const admin = db.insert(users).values({ email: 'a@example.com', displayName: 'A', color: '#378ADD', role: 'admin', createdAt: NOW }).returning().get().id;
    const conn = db.insert(connections).values({ kind: 'plaid', scope: 'family', ownerUserId: admin, credentialsEnc: 'v1.x', createdAt: NOW, updatedAt: NOW }).returning().get();
    db.insert(plaidItems).values({ connectionId: conn.id, plaidItemId: 'item-1', createdAt: NOW, updatedAt: NOW }).run();
    db.delete(connections).where(eq(connections.id, conn.id)).run();
    expect(db.select().from(plaidItems).all()).toEqual([expect.objectContaining({ plaidItemId: 'item-1', connectionId: null })]);
  });

  it('stores a 23-digit reference number exactly, once per card, deleted rows included', () => {
    const { db } = openDb(':memory:');
    const uncategorized = db.select().from(categories).all().find((c) => c.kind === 'uncategorized')!.id;
    const a = db.insert(cards).values({ nickname: 'A', createdAt: NOW, updatedAt: NOW }).returning().get().id;
    const b = db.insert(cards).values({ nickname: 'B', createdAt: NOW, updatedAt: NOW }).returning().get().id;
    const ref = '24692162298100012345678';
    const row = (cardId: number, deletedAt: Date | null = null) => ({
      cardId, source: 'csv' as const, date: '2026-11-01', amountCents: 1274, rawName: 'COFFEE', categoryId: uncategorized,
      categorySource: 'default' as const, personSource: 'default' as const, csvReference: ref, deletedAt, createdAt: NOW, updatedAt: NOW,
    });
    db.insert(transactions).values(row(a, NOW)).run();
    expect(() => db.insert(transactions).values(row(a)).run()).toThrow(/UNIQUE/);
    db.insert(transactions).values(row(b)).run();
    expect(db.select().from(transactions).all().map((t) => t.csvReference)).toEqual([ref, ref]);
    expect(db.select().from(transactions).all()[0]!.isoCurrencyCode).toBe('USD');
  });
});

describe('the Plaid tables and columns (phase 6b)', () => {
  const NOW = new Date('2026-11-21T12:00:00Z');
  const tables = (sqlite: Database.Database) =>
    (sqlite.prepare("select name from sqlite_master where type='table' order by name").all() as { name: string }[]).map((t) => t.name);
  const columns = (sqlite: Database.Database, table: string) =>
    (sqlite.prepare(`select name from pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);

  it('keeps every row of a phase 6a database when it upgrades, and only adds plaid_link_pending and nullable columns', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: migrationsUpTo(7) });
    const phase6a = tables(sqlite);
    expect(phase6a).not.toContain('plaid_link_pending');
    // Synthetic rows in every Spend table, a Plaid Item and its connection included.
    sqlite.exec(`
      insert into users (id, email, display_name, color, role, created_at) values (1, 'alex@example.com', 'Alex', '#378ADD', 'admin', 1);
      insert into settings (key, value) values ('time_zone', 'America/Los_Angeles'), ('plaid_items_created', '1');
      insert into connections (id, kind, scope, owner_user_id, credentials_enc, status, meta, created_at, updated_at)
        values (1, 'plaid', 'family', 1, 'v1.x.y.z', 'ok', '{"itemId":"item-synthetic"}', 1, 1);
      insert into plaid_items (id, connection_id, plaid_item_id, institution_id, institution_name, cursor, created_at, updated_at)
        values (1, 1, 'item-synthetic', 'ins_synthetic', 'Example Bank', 'cursor-1', 1, 1);
      insert into cards (id, nickname, mask, included, usual_closing_day, plaid_item_id, plaid_account_id, created_at, updated_at)
        values (1, 'Visa', '1234', 1, 15, 1, 'acct-synthetic', 1, 1), (2, 'Mastercard', '9876', 0, null, null, null, 1, 1);
      insert into statements (id, card_id, closing_date, source, created_at, updated_at) values (1, 1, '2026-10-15', 'manual', 1, 1);
      insert into csv_imports (id, card_id, file_name, file_sha256, uploaded_by_user_id, uploaded_at, row_count, imported_count, skipped_count)
        values (1, 2, 'stmt.csv', 'abc', 1, 1, 1, 1, 0);
      insert into transactions (id, card_id, source, plaid_transaction_id, plaid_account_id, date, amount_cents, raw_name, category_id,
        category_source, person_source, created_at, updated_at)
        values (1, 1, 'plaid', 'tx-synthetic', 'acct-synthetic', '2026-11-01', 1274, 'COFFEE', 1, 'mapping', 'default', 1, 1);
      insert into transactions (id, card_id, source, date, amount_cents, raw_name, category_id, category_source, person_source, csv_reference,
        csv_import_id, deleted_at, created_at, updated_at)
        values (2, 2, 'csv', '2026-11-02', 500, 'BAKERY', 2, 'manual', 'default', '24692162298100012345678', 1, 5, 1, 1);
    `);
    const names = [
      'users', 'settings', 'connections', 'plaid_items', 'cards', 'statements', 'csv_imports', 'transactions', 'categories',
      'category_mappings', 'rules',
    ];
    const before = Object.fromEntries(names.map((n) => [n, sqlite.prepare(`select * from ${n} order by 1`).all()]));
    const columnsBefore = Object.fromEntries(names.map((n) => [n, columns(sqlite, n)]));

    migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });

    expect(tables(sqlite).filter((t) => !phase6a.includes(t))).toEqual(['plaid_link_pending', 'savings_accounts', 'savings_balances', 'savings_flows', 'savings_import_previews', 'savings_import_profiles', 'savings_imports']);
    const added: Record<string, Record<string, string | null>> = {
      plaid_items: {
        accounts: null, picked_at: null, backoff_until: null, new_accounts_at: null, disconnect_at: null, transactions_status: null,
        last_sync_at: null, full_resync_at: null, removed_reason: null,
        // 0011 (Savings): every Item made before it is Spend's.
        purpose: 'spend', investments_status: null, investments_error_code: null, investments_through: null,
      },
      // 0010 (Remove duplicate) adds three more, all nullable.
      transactions: { replaced_by_id: null, deleted_reason: null, duplicate_of_id: null, duplicate_carry: null },
    };
    for (const n of names) {
      expect(columns(sqlite, n).filter((c) => !columnsBefore[n]!.includes(c)), n).toEqual(Object.keys(added[n] ?? {}));
      // Every row keeps its values, and the new columns are empty.
      expect(sqlite.prepare(`select * from ${n} order by 1`).all(), n).toEqual((before[n] as object[]).map((row) => ({ ...row, ...added[n] })));
    }
    // Restoring what a removed row had replaced looks rows up by replaced_by_id (review C-S-M6).
    const indexes = (sqlite.prepare("select name, sql from sqlite_master where type='index' and tbl_name='transactions'").all() as { name: string; sql: string }[]);
    expect(indexes.find((i) => i.name === 'transactions_replaced_by_idx')?.sql).toMatch(/\(`replaced_by_id`\)/);
    expect(sqlite.prepare("explain query plan select id from transactions where replaced_by_id = 1").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining('transactions_replaced_by_idx') })]),
    );
    // Losing a twin brings back what was removed as its duplicate, found by duplicate_of_id.
    expect(sqlite.prepare("explain query plan select id from transactions where duplicate_of_id = 1").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining('transactions_duplicate_of_idx') })]),
    );
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('keeps one Plaid link pending per admin, gone with the admin or with the Item it updates', () => {
    const { db } = openDb(':memory:');
    const admin = (email: string) =>
      db.insert(users).values({ email, displayName: 'A', color: '#378ADD', role: 'admin', createdAt: NOW }).returning().get().id;
    const a = admin('a@example.com');
    const b = admin('b@example.com');
    const item = db.insert(plaidItems).values({ plaidItemId: 'item-synthetic', createdAt: NOW, updatedAt: NOW }).returning().get().id;
    const pending = (userId: number, plaidItemId: number | null = null) => ({
      userId, sessionHash: 'hash', linkToken: 'link-sandbox-synthetic', mode: plaidItemId ? ('update' as const) : ('new' as const), plaidItemId,
      createdAt: NOW, expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    });
    db.insert(plaidLinkPending).values(pending(a)).run();
    expect(() => db.insert(plaidLinkPending).values(pending(a)).run()).toThrow(/UNIQUE|PRIMARY/);
    db.insert(plaidLinkPending).values(pending(b, item)).run();
    expect(db.select().from(plaidLinkPending).all().map((p) => [p.userId, p.mode, p.addAccounts])).toEqual([[a, 'new', false], [b, 'update', false]]);
    db.delete(users).where(eq(users.id, a)).run();
    db.delete(plaidItems).where(eq(plaidItems.id, item)).run();
    expect(db.select().from(plaidLinkPending).all()).toEqual([]);
  });

  it("stores an Item's account list as JSON, and a replaced row's replacement without a foreign key", () => {
    const { db } = openDb(':memory:');
    const accounts = [{
      accountId: 'acct-synthetic', name: 'Example Card', officialName: null, mask: '1234', type: 'credit', subtype: 'credit card',
      isoCurrencyCode: 'USD', unofficialCurrencyCode: null,
    }];
    db.insert(plaidItems).values({ plaidItemId: 'item-synthetic', accounts, removedReason: 'key_reset', createdAt: NOW, updatedAt: NOW }).run();
    expect(db.select().from(plaidItems).get()).toMatchObject({ accounts, removedReason: 'key_reset', pickedAt: null, backoffUntil: null });
    const uncategorized = db.select().from(categories).all().find((c) => c.kind === 'uncategorized')!.id;
    const card = db.insert(cards).values({ nickname: 'Visa', createdAt: NOW, updatedAt: NOW }).returning().get().id;
    // 999 names no row: the replacement may since have been pruned, or deleted with its bank.
    db.insert(transactions).values({
      cardId: card, source: 'csv', date: '2026-11-01', amountCents: 1274, rawName: 'COFFEE', categoryId: uncategorized,
      categorySource: 'default', personSource: 'default', replacedById: 999, deletedAt: NOW, createdAt: NOW, updatedAt: NOW,
    }).run();
    expect(db.select().from(transactions).get()?.replacedById).toBe(999);
  });
});

describe('the Savings tables and columns (0011)', () => {
  const NOW = new Date('2026-11-19T12:00:00Z');
  const tables = (sqlite: Database.Database) =>
    (sqlite.prepare("select name from sqlite_master where type='table' order by name").all() as { name: string }[]).map((t) => t.name);
  const columns = (sqlite: Database.Database, table: string) =>
    (sqlite.prepare(`select name from pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);

  it('keeps every row of a database from before it, makes every Item and pending link Spend\'s, and only adds', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: migrationsUpTo(10) });
    const before6b = tables(sqlite);
    expect(before6b).not.toContain('savings_accounts');
    // Synthetic rows: an Item with its connection and a pending link to reconnect it.
    sqlite.exec(`
      insert into users (id, email, display_name, color, role, created_at) values (1, 'alex@example.com', 'Alex', '#378ADD', 'admin', 1);
      insert into connections (id, kind, scope, owner_user_id, credentials_enc, status, meta, created_at, updated_at)
        values (1, 'plaid', 'family', 1, 'v1.x.y.z', 'ok', '{"itemId":"item-synthetic"}', 1, 1);
      insert into plaid_items (id, connection_id, plaid_item_id, institution_name, cursor, picked_at, created_at, updated_at)
        values (1, 1, 'item-synthetic', 'Example Bank', 'cursor-1', 1, 1, 1);
      insert into plaid_link_pending (user_id, session_hash, link_token, mode, plaid_item_id, created_at, expires_at)
        values (1, 'hash', 'link-sandbox-synthetic', 'update', 1, 1, 2);
    `);
    const names = ['users', 'connections', 'plaid_items', 'plaid_link_pending'];
    const rowsBefore = Object.fromEntries(names.map((n) => [n, sqlite.prepare(`select * from ${n} order by 1`).all()]));
    const columnsBefore = Object.fromEntries(names.map((n) => [n, columns(sqlite, n)]));

    migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });

    expect(tables(sqlite).filter((t) => !before6b.includes(t))).toEqual(['savings_accounts', 'savings_balances', 'savings_flows', 'savings_import_previews', 'savings_import_profiles', 'savings_imports']);
    const added: Record<string, Record<string, string | null>> = {
      plaid_items: { purpose: 'spend', investments_status: null, investments_error_code: null, investments_through: null },
      plaid_link_pending: { purpose: 'spend' },
    };
    for (const n of names) {
      expect(columns(sqlite, n).filter((c) => !columnsBefore[n]!.includes(c)), n).toEqual(Object.keys(added[n] ?? {}));
      expect(sqlite.prepare(`select * from ${n} order by 1`).all(), n).toEqual((rowsBefore[n] as object[]).map((row) => ({ ...row, ...added[n] })));
    }
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('keeps one shown account per Plaid account, one snapshot per account and day, and one flow per Plaid id and source', () => {
    const { db, sqlite } = openDb(':memory:');
    const item = db.insert(plaidItems).values({ plaidItemId: 'item-synthetic', purpose: 'savings', createdAt: NOW, updatedAt: NOW }).returning().get();
    expect(item.purpose).toBe('savings');
    const account = (plaidAccountId: string) =>
      db.insert(savingsAccounts).values({ plaidItemId: item.id, plaidAccountId, nickname: 'Cash', kind: 'cash', createdAt: NOW, updatedAt: NOW }).returning().get().id;
    const cash = account('acct-cash');
    expect(() => account('acct-cash')).toThrow(/UNIQUE/);
    const snapshot = { accountId: cash, date: '2026-11-19', currentCents: 100_00, availableCents: null, fetchedAt: NOW };
    db.insert(savingsBalances).values(snapshot).run();
    expect(() => db.insert(savingsBalances).values(snapshot).run()).toThrow(/UNIQUE/);
    const flow = { accountId: cash, source: 'transactions' as const, plaidId: 'tx-1', date: '2026-11-19', amountCents: 5_00, kind: 'deposit' as const, createdAt: NOW, updatedAt: NOW };
    db.insert(savingsFlows).values(flow).run();
    expect(() => db.insert(savingsFlows).values(flow).run()).toThrow(/UNIQUE/);
    // Another source may use the same id: Plaid's transaction and investment transaction ids are separate.
    db.insert(savingsFlows).values({ ...flow, source: 'investments' }).run();
    expect(() => db.insert(savingsFlows).values({ ...flow, plaidId: 'tx-2', amountCents: 0 }).run()).toThrow(/CHECK/);
    // The brokerage window's lookup (store.investmentFlowIdsIn) uses the (account_id, date) index.
    expect(sqlite.prepare("explain query plan select id from savings_flows where account_id in (1, 2) and date >= '2026-11-01' and date <= '2026-11-10' and source = 'investments'").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining('savings_flows_account_date_idx') })]),
    );
    // An account's balances and flows go with it.
    db.delete(savingsAccounts).where(eq(savingsAccounts.id, cash)).run();
    expect(db.select().from(savingsBalances).all()).toEqual([]);
    expect(db.select().from(savingsFlows).all()).toEqual([]);
  });
});

describe('the Savings CSV migration (0012)', () => {
  const rows = (sqlite: Database.Database, table: string) => sqlite.prepare(`select * from ${table} order by id`).all() as Record<string, unknown>[];
  const sequence = (sqlite: Database.Database) => sqlite.prepare("select name, seq from sqlite_sequence where name like '%savings_%' order by name").all();
  const fks = (sqlite: Database.Database, table: string) =>
    sqlite.prepare(`select "table", "from", on_delete from pragma_foreign_key_list('${table}') order by "from"`).all();
  const indexes = (sqlite: Database.Database, table: string) =>
    (sqlite.prepare("select name from sqlite_master where type = 'index' and tbl_name = ? and name not like 'sqlite_%' order by name").all(table) as { name: string }[]).map((i) => i.name);

  it('rebuilds savings_accounts with nullable Plaid ids, keeping every account, balance and flow, and every AUTOINCREMENT counter', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: migrationsUpTo(11) });
    // Synthetic rows. The highest ids are hard-deleted, so every counter is ahead of max(id).
    sqlite.exec(`
      insert into users (id, email, display_name, color, role, created_at) values (1, 'alex@example.com', 'Alex', '#378ADD', 'admin', 1);
      insert into plaid_items (id, plaid_item_id, purpose, created_at, updated_at) values (1, 'item-synthetic', 'savings', 1, 1);
      insert into savings_accounts (id, plaid_item_id, plaid_account_id, nickname, kind, mask, iso_currency_code, hidden_at, removed_at, created_at, updated_at) values
        (1, 1, 'acct-cash', 'Cash', 'cash', '4321', 'USD', null, null, 1, 2),
        (2, 1, 'acct-brokerage', 'Brokerage', 'investment', '8765', 'USD', 5, null, 1, 2),
        (3, 1, 'acct-gone', 'Gone', 'cash', null, null, null, null, 1, 1);
      insert into savings_balances (id, account_id, date, current_cents, available_cents, fetched_at) values
        (1, 1, '2026-11-14', 100000, 95000, 10), (2, 2, '2026-11-14', 500000, null, 10), (3, 3, '2026-11-14', 1, null, 10);
      insert into savings_flows (id, account_id, source, plaid_id, date, amount_cents, kind, created_at, updated_at) values
        (1, 1, 'transactions', 'tx-1', '2026-11-03', 25000, 'deposit', 1, 1),
        (2, 2, 'investments', 'inv-1', '2026-11-05', 30000, 'deposit', 1, 1),
        (3, 3, 'transactions', 'tx-9', '2026-11-03', 1, 'deposit', 1, 1);
      delete from savings_accounts where id = 3;
    `);
    expect(sequence(sqlite)).toEqual([{ name: 'savings_accounts', seq: 3 }, { name: 'savings_balances', seq: 3 }, { name: 'savings_flows', seq: 3 }]);
    const before = { accounts: rows(sqlite, 'savings_accounts'), balances: rows(sqlite, 'savings_balances'), flows: rows(sqlite, 'savings_flows') };
    expect(before.balances).toHaveLength(2);
    expect(before.flows).toHaveLength(2);

    migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });

    // Every row kept, every one Plaid's.
    expect(rows(sqlite, 'savings_accounts')).toEqual(before.accounts.map((r) => ({ ...r, source: 'plaid' })));
    expect(rows(sqlite, 'savings_balances')).toEqual(before.balances.map((r) => ({ ...r, source: 'plaid', import_id: null })));
    expect(rows(sqlite, 'savings_flows')).toEqual(before.flows.map((r) => ({ ...r, import_id: null })));
    // Every counter kept, so a deleted id is never reused.
    expect(sequence(sqlite)).toEqual([{ name: 'savings_accounts', seq: 3 }, { name: 'savings_balances', seq: 3 }, { name: 'savings_flows', seq: 3 }]);
    const added = sqlite.prepare("insert into savings_accounts (source, nickname, kind, created_at, updated_at) values ('manual', 'By hand', 'investment', 1, 1)").run();
    expect(Number(added.lastInsertRowid)).toBe(4);
    // The foreign keys name the rebuilt tables by their final names.
    const children = [{ table: 'savings_accounts', from: 'account_id', on_delete: 'CASCADE' }, { table: 'savings_imports', from: 'import_id', on_delete: 'CASCADE' }];
    expect(fks(sqlite, 'savings_balances')).toEqual(children);
    expect(fks(sqlite, 'savings_flows')).toEqual(children);
    expect(fks(sqlite, 'savings_imports')).toEqual([
      { table: 'savings_accounts', from: 'account_id', on_delete: 'CASCADE' }, { table: 'users', from: 'uploaded_by_user_id', on_delete: 'NO ACTION' },
    ]);
    expect(fks(sqlite, 'savings_import_previews')).toEqual([
      { table: 'savings_accounts', from: 'account_id', on_delete: 'CASCADE' }, { table: 'users', from: 'user_id', on_delete: 'CASCADE' },
    ]);
    expect(fks(sqlite, 'savings_accounts')).toEqual([{ table: 'plaid_items', from: 'plaid_item_id', on_delete: 'NO ACTION' }]);
    expect(indexes(sqlite, 'savings_accounts')).toEqual(['savings_accounts_item_idx', 'savings_accounts_plaid_account_unique']);
    expect(indexes(sqlite, 'savings_balances')).toEqual(['savings_balances_account_date_unique', 'savings_balances_import_idx']);
    expect(indexes(sqlite, 'savings_flows')).toEqual(['savings_flows_account_date_idx', 'savings_flows_import_idx', 'savings_flows_source_plaid_unique']);
    expect(indexes(sqlite, 'savings_imports')).toEqual(['savings_imports_account_idx']);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('upgrades a database whose Savings tables were never written to, with no counters to carry', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: migrationsUpTo(11) });
    sqlite.exec("insert into users (id, email, display_name, color, role, created_at) values (1, 'alex@example.com', 'Alex', '#378ADD', 'admin', 1)");
    expect(sequence(sqlite)).toEqual([]);

    migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });

    for (const t of ['savings_accounts', 'savings_balances', 'savings_flows', 'savings_imports', 'savings_import_previews', 'savings_import_profiles']) expect(rows(sqlite, t), t).toEqual([]);
    // No counter was carried, and none named __new_ was left behind.
    expect(sequence(sqlite)).toEqual([]);
    expect(sqlite.prepare("select name from sqlite_master where name like '%__new_%'").all()).toEqual([]);
    const added = sqlite.prepare("insert into savings_accounts (source, nickname, kind, created_at, updated_at) values ('manual', 'By hand', 'cash', 1, 1)").run();
    expect(Number(added.lastInsertRowid)).toBe(1);
    expect(sequence(sqlite)).toEqual([{ name: 'savings_accounts', seq: 1 }]);
    expect(fks(sqlite, 'savings_balances')).toEqual([{ table: 'savings_accounts', from: 'account_id', on_delete: 'CASCADE' }, { table: 'savings_imports', from: 'import_id', on_delete: 'CASCADE' }]);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('keeps Plaid ids to linked accounts, an import id to csv rows, and deletes an import\'s rows with it', () => {
    const { db } = openDb(':memory:');
    const NOW = new Date('2026-11-15T12:00:00Z');
    const user = db.insert(users).values({ email: 'alex@example.com', displayName: 'Alex', color: '#378ADD', role: 'admin', createdAt: NOW }).returning().get();
    const hand = db.insert(savingsAccounts).values({ source: 'manual', nickname: 'By hand', kind: 'cash', createdAt: NOW, updatedAt: NOW }).returning().get();
    expect(hand).toMatchObject({ plaidItemId: null, plaidAccountId: null });
    // A Plaid account needs its Item and account id; a hand-added one has neither.
    expect(() => db.insert(savingsAccounts).values({ source: 'plaid', nickname: 'No link', kind: 'cash', createdAt: NOW, updatedAt: NOW }).run()).toThrow(/CHECK/);
    const record = db.insert(savingsImports).values({
      accountId: hand.id, fileName: 'History_for_Account_X00000001.csv', fileSha256: '0'.repeat(64), layout: 'fidelity_cash', uploadedByUserId: user.id, uploadedAt: NOW,
      depositsAdded: 1, withdrawalsAdded: 0, balancesAdded: 1, skipped: 0,
    }).returning().get();
    const flow = { accountId: hand.id, source: 'csv' as const, plaidId: 'key-1', date: '2026-10-01', amountCents: 5_00, kind: 'deposit' as const, createdAt: NOW, updatedAt: NOW };
    expect(() => db.insert(savingsFlows).values(flow).run()).toThrow(/CHECK/);
    db.insert(savingsFlows).values({ ...flow, importId: record.id }).run();
    expect(() => db.insert(savingsBalances).values({ accountId: hand.id, date: '2026-10-01', currentCents: 1, fetchedAt: NOW, source: 'csv' }).run()).toThrow(/CHECK/);
    db.insert(savingsBalances).values({ accountId: hand.id, date: '2026-10-01', currentCents: 1, fetchedAt: NOW, source: 'csv', importId: record.id }).run();
    db.insert(savingsBalances).values({ accountId: hand.id, date: '2026-10-02', currentCents: 2, fetchedAt: NOW, source: 'manual' }).run();
    // Undo: the import goes, and its rows with it; the hand-set balance stays.
    db.delete(savingsImports).where(eq(savingsImports.id, record.id)).run();
    expect(db.select().from(savingsFlows).all()).toEqual([]);
    expect(db.select().from(savingsBalances).all().map((b) => b.source)).toEqual(['manual']);
    // Deleting the account takes its previews too.
    db.insert(savingsImportPreviews).values({
      id: 'p'.repeat(22), userId: user.id, accountId: hand.id, fileName: null, fileSha256: '0'.repeat(64), layout: 'fidelity_cash',
      plan: { header: ['Date', 'Amount'], rows: [], mapping: null, choices: {} }, createdAt: NOW, expiresAt: NOW,
    }).run();
    db.delete(savingsAccounts).where(eq(savingsAccounts.id, hand.id)).run();
    expect(db.select().from(savingsImportPreviews).all()).toEqual([]);
    expect(db.select().from(savingsBalances).all()).toEqual([]);
  });
});

describe('the Savings import profiles (0013)', () => {
  it('keeps one profile per account, gone with the account', () => {
    const { db } = openDb(':memory:');
    const NOW = new Date('2026-11-15T12:00:00Z');
    const user = db.insert(users).values({ email: 'alex@example.com', displayName: 'Alex', color: '#378ADD', role: 'admin', createdAt: NOW }).returning().get();
    const hand = db.insert(savingsAccounts).values({ source: 'manual', nickname: 'By hand', kind: 'cash', createdAt: NOW, updatedAt: NOW }).returning().get();
    const profile = {
      accountId: hand.id, header: ['Date', 'Description', 'Amount'], format: 'custom' as const,
      mapping: { date: { column: 0, format: 'ymd' as const }, amount: { kind: 'signed' as const, column: 2, inIsNegative: false }, balance: null, description: 1 },
      choices: { 'CARD PURCHASE': 'by_sign' as const }, updatedByUserId: user.id, createdAt: NOW, updatedAt: NOW,
    };
    db.insert(savingsImportProfiles).values(profile).run();
    expect(() => db.insert(savingsImportProfiles).values(profile).run()).toThrow(/UNIQUE/);
    expect(db.select().from(savingsImportProfiles).get()).toMatchObject({ header: ['Date', 'Description', 'Amount'], choices: { 'CARD PURCHASE': 'by_sign' } });
    db.delete(savingsAccounts).where(eq(savingsAccounts.id, hand.id)).run();
    expect(db.select().from(savingsImportProfiles).all()).toEqual([]);
  });
});

describe("the Savings imports' date range (0014)", () => {
  it('adds nullable first and last days to the imports already there, keeping every row', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: migrationsUpTo(13) });
    sqlite.exec(`
      insert into users (id, email, display_name, color, role, active, created_at) values (1, 'alex@example.com', 'Alex', '#378ADD', 'admin', 1, 1);
      insert into savings_accounts (id, source, nickname, kind, iso_currency_code, created_at, updated_at) values (1, 'manual', 'By hand', 'cash', 'USD', 1, 1);
      insert into savings_imports (id, account_id, file_name, file_sha256, layout, uploaded_by_user_id, uploaded_at, deposits_added, withdrawals_added, balances_added, skipped)
        values (1, 1, 'statement.csv', '${'0'.repeat(64)}', 'custom', 1, 5, 2, 3, 4, 0);
      insert into savings_balances (account_id, date, current_cents, available_cents, fetched_at, source, import_id) values (1, '2026-10-31', 100, null, 5, 'csv', 1);
    `);
    const before = sqlite.prepare('select * from savings_imports').all();
    migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });
    expect(sqlite.prepare('select * from savings_imports').all()).toEqual(before.map((r) => ({ ...(r as object), first_date: null, last_date: null })));
    expect(sqlite.prepare('select count(*) as n from savings_balances').get()).toEqual({ n: 1 });
    sqlite.prepare("update savings_imports set first_date = '2026-10-01', last_date = '2026-10-31' where id = 1").run();
    expect(sqlite.prepare('select first_date, last_date from savings_imports').get()).toEqual({ first_date: '2026-10-01', last_date: '2026-10-31' });
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('the chore board migration (0009)', () => {
  it('moves who has each chore onto the chore, deletes open occurrences nobody had, and keeps history', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: migrationsUpTo(8) });
    sqlite.exec(`
      insert into users (id, email, display_name, color, role, active, created_at) values
        (1, 'kid@example.com', 'Kid', '#378ADD', 'member', 1, 1),
        (2, 'sib@example.com', 'Sib', '#378ADD', 'member', 1, 1),
        (3, 'gone@example.com', 'Gone', '#378ADD', 'member', 0, 1);
      insert into todos (id, owner_user_id, title, chore_occurrence_id, created_at, updated_at) values
        (1, 1, 'Feed cat', 1, 1, 1), (2, 2, 'Car', 6, 1, 1);
      insert into chores (id, title, default_assignee_user_id, schedule_type, schedule, start_date, status, created_at, updated_at) values
        (1, 'Feed cat', null, 'fixed', '{"kind":"daily"}', '2026-11-01', 'active', 1, 1),
        (2, 'Dishes', 2, 'fixed', '{"kind":"daily"}', '2026-11-01', 'active', 1, 1),
        (3, 'Trash', 1, 'fixed', '{"kind":"daily"}', '2026-11-01', 'active', 1, 1),
        (4, 'Yard', 3, 'fixed', '{"kind":"daily"}', '2026-11-01', 'active', 1, 1),
        (5, 'Old', 1, 'fixed', '{"kind":"daily"}', '2026-11-01', 'archived', 1, 1),
        (6, 'Paused', 2, 'fixed', '{"kind":"daily"}', '2026-11-01', 'paused', 1, 1),
        (7, 'Car', 1, 'fixed', '{"kind":"daily"}', '2026-11-01', 'active', 1, 1);
      insert into chore_occurrences (id, chore_id, title_snapshot, due_date, assignee_user_id, assignment_source, state, completed_at,
        actor_user_id, credited_user_id, todo_id, todo_sync_status, created_at, updated_at) values
        (1, 1, 'Feed cat', '2026-11-17', 1, 'claimed', 'open', null, null, null, 1, 'ok', 1, 1),
        (2, 2, 'Dishes', '2026-11-17', null, 'default', 'open', null, null, null, null, 'not_applicable', 1, 1),
        (3, 3, 'Trash', '2026-11-10', 1, 'default', 'done', 5, 1, 1, null, 'ok', 1, 1),
        (4, 2, 'Dishes', '2026-11-16', null, 'default', 'skipped', 6, 2, null, null, 'not_applicable', 1, 1),
        (6, 7, 'Car', '2026-11-17', 2, 'admin', 'open', null, null, null, 2, 'ok', 1, 1),
        (7, 3, 'Trash', '2026-11-11', 1, 'default', 'done', 7, 1, 1, null, 'ok', 1, 1);
      -- The highest id is hard-deleted, so the AUTOINCREMENT counter is ahead of max(id).
      delete from chore_occurrences where id = 7;
    `);
    const sequence = () => sqlite.prepare("select name, seq from sqlite_sequence where name like '%chore_occurrences' order by name").all();
    expect(sequence()).toEqual([{ name: 'chore_occurrences', seq: 7 }]);
    const history = sqlite.prepare("select * from chore_occurrences where state <> 'open' order by id").all();
    const assignedOpen = sqlite.prepare("select * from chore_occurrences where state = 'open' and assignee_user_id is not null order by id").all();

    migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });

    expect(sqlite.prepare('select id, assignee_user_id as assignee from chores order by id').all()).toEqual([
      { id: 1, assignee: 1 }, // its open occurrence was Kid's
      { id: 2, assignee: 2 }, // the default carries over; its Up for grabs occurrence is deleted
      { id: 3, assignee: 1 }, // the default carries over, and gets an occurrence on the next generation run
      { id: 4, assignee: null }, // the default was deactivated
      { id: 5, assignee: null }, // archived
      { id: 6, assignee: 2 }, // pausing keeps it
      { id: 7, assignee: 2 }, // the open occurrence's assignee, not the old default
    ]);
    // History and the assigned open occurrences keep every value; only the unassigned open one is gone.
    expect(sqlite.prepare("select * from chore_occurrences where state <> 'open' order by id").all()).toEqual(history);
    expect(sqlite.prepare("select * from chore_occurrences where state = 'open' order by id").all()).toEqual(assignedOpen);
    expect(sqlite.prepare('select id from chore_occurrences where id = 2').get()).toBeUndefined();
    expect((sqlite.prepare("select name from pragma_table_info('chores')").all() as { name: string }[]).map((c) => c.name)).not.toContain(
      'default_assignee_user_id',
    );

    // The rebuild keeps the AUTOINCREMENT counter, so a deleted occurrence's id is never reused: to-dos
    // point at occurrences by id with no foreign key, and a stale one must not attach to a new occurrence.
    expect(sequence()).toEqual([{ name: 'chore_occurrences', seq: 7 }]);

    // Due dates can be null now; the unique key, the closed-at check, and the indexes came through the rebuild.
    const inserted = sqlite.prepare(`insert into chore_occurrences (chore_id, title_snapshot, due_date, assignee_user_id, assignment_source, state, completed_at,
      todo_sync_status, created_at, updated_at) values (3, 'Trash', null, 1, 'claimed', 'done', 9, 'ok', 1, 1), (3, 'Trash', null, 1, 'claimed', 'done', 9, 'ok', 1, 1)`).run();
    expect(Number(inserted.lastInsertRowid)).toBe(9); // 8 and 9, after the deleted 7
    const insertOpen = (due: string, completedAt: number | null) =>
      sqlite.prepare(`insert into chore_occurrences (chore_id, title_snapshot, due_date, assignee_user_id, assignment_source, state, completed_at,
        todo_sync_status, created_at, updated_at) values (3, 'Trash', ?, 1, 'claimed', 'open', ?, 'ok', 1, 1)`).run(due, completedAt);
    expect(() => insertOpen('2026-11-10', null)).toThrow(/UNIQUE/);
    expect(() => insertOpen('2026-11-11', 5)).toThrow(/CHECK/);
    expect((sqlite.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'chore_occurrences' order by name").all() as { name: string }[])
      .map((i) => i.name)).toEqual(['chore_occurrences_chore_due_unique', 'chore_occurrences_completed_idx', 'chore_occurrences_state_idx']);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});
