import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import { PLAID_MESSAGES } from '../../../shared/plaid.js';
import {
  OverviewQuerySchema, SAVINGS_CSV_MAX_BYTES, SAVINGS_MESSAGES, SavingsAccountPatchSchema, SavingsHandAccountInputSchema, SavingsImportUpdateSchema,
  SavingsPickInputSchema, SavingsProfilePatchSchema, SavingsRemoveInputSchema, SavingsSetBalanceInputSchema,
} from '../../../shared/savings.js';
import type { AppDeps, AppEnv } from '../../app.js';
import { requireAdmin } from '../../auth/middleware.js';
import { AppError, parseJson } from '../../core/errors.js';
import { rateLimit } from '../../core/rateLimit.js';
import {
  loadSavingsAccounts, pickSavingsAccounts, refreshSavingsConnection, removeSavingsConnection, savingsSettingsView, updateSavingsAccount, type SavingsViewDeps,
} from './connections.js';
import { addHandAccount, removeHandAccount, setSavingsBalance } from './handAccounts.js';
import {
  cancelSavingsImport, clearImportProfile, commitSavingsImport, isSavingsPreviewId, startSavingsImport, undoSavingsImport, updateImportProfile, updateSavingsImport,
} from './imports.js';
import { savingsOverview, savingsSummary } from './views.js';

/** Plain decimal digits only, like the other panels' routes. */
function idParam(c: Context, message: string, name = 'id'): number {
  const raw = c.req.param(name) ?? '';
  const id = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError('not_found', message);
  return id;
}

function query<T>(c: Context, schema: z.ZodType<T, unknown>): T {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw new AppError('validation', [...new Set(result.error.issues.map((i) => i.message))].join('; '));
  return result.data;
}

/**
 * /api/panels/savings/* (requirePanel has checked the Savings grant; the global middleware checks
 * CSRF on every change). Anyone with the panel sees it; settings and every change are admins'.
 *
 *   GET    /summary                          the home card                     → SavingsSummary
 *   GET    /overview?month=YYYY-MM           the drill-down                    → SavingsOverview
 *
 * Savings settings, with or without Plaid (plan decision 20):
 *   GET    /settings                         admin                                     → SavingsSettingsView
 *   POST   /accounts                         admin  { nickname, kind }                 → SavingsSettingsView
 *   PATCH  /accounts/:id                     admin  { nickname?, hidden? }             → SavingsSettingsView
 *   POST   /accounts/:id/balance             admin  { amount, date? }                  → SavingsSettingsView
 *   POST   /accounts/:id/remove              admin  { deleteData }, hand-added only    → SavingsSettingsView
 *   POST   /accounts/:id/imports             admin  multipart file (5 MB), 20 a minute → 201 SavingsImportDraft
 *   PUT    /imports/:id                      admin  { mapping, choices? }              → SavingsImportDraft
 *   POST   /imports/:id/commit               admin  the draft's uploader               → SavingsSettingsView (message)
 *   DELETE /imports/:id                      admin  cancel the draft                   → 204
 *   DELETE /accounts/:id/imports/:importId   admin  undo                               → SavingsSettingsView (message)
 *   PATCH  /accounts/:id/import-profile      admin  { choices }                        → SavingsSettingsView
 *   DELETE /accounts/:id/import-profile      admin  clear the saved settings           → SavingsSettingsView
 *
 * With Plaid configured (a 404 otherwise):
 *   POST  /connections/:id/accounts       admin  { accounts: [{ accountId, action: show (nickname) | skip }] } → SavingsSettingsView
 *   POST  /connections/:id/refresh        admin  sync now, 10 a minute     → SavingsSettingsView
 *   POST  /connections/:id/load-accounts  admin  10 a minute               → SavingsSettingsView
 *   POST  /connections/:id/remove         admin  { deleteData }            → SavingsSettingsView
 *
 * Nothing from an uploaded file reaches the logs here: the service logs ids, counts, and the format id.
 */
export function savingsRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/summary', (c) => c.json(savingsSummary(deps)));
  r.get('/overview', (c) => c.json(savingsOverview(deps, query(c, OverviewQuerySchema).month ?? null)));

  const v: SavingsViewDeps = { db: deps.db, clock: deps.clock, logger: deps.logger, plaid: deps.plaid ?? null };
  // Imports and saved settings: a linked account's are refused without Plaid, as the view leaves them out.
  const iv = { ...v, plaidConfigured: v.plaid !== null };
  const accountId = (c: Context) => idParam(c, SAVINGS_MESSAGES.accountNotFound);
  const userId = (c: Context<AppEnv>) => c.get('user')!.id;
  const draftId = (c: Context) => {
    const id = c.req.param('id') ?? '';
    if (!isSavingsPreviewId(id)) throw new AppError('not_found', SAVINGS_MESSAGES.importNotFound);
    return id;
  };
  const uploadLimit = rateLimit({ windowMs: 60_000, max: 20, clock: deps.clock, key: (c) => `user:${(c as Context<AppEnv>).get('user')!.id}` });
  // A little over 5 MB for the form's own parts; the file itself is checked against the limit below.
  const uploadSize = bodyLimit({ maxSize: SAVINGS_CSV_MAX_BYTES + 64 * 1024, onError: (c) => c.json({ error: { code: 'validation', message: SAVINGS_MESSAGES.importTooBig } }, 413) });
  // A mapping and up to 1,000 choices (the schema's cap), each label up to 100 characters (groupLabel's cap,
  // up to 3 bytes each in UTF-8) with its choice and JSON's quotes: about 320 KB at the very most.
  const choicesBody = bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: { code: 'validation', message: 'That request is too big.' } }, 413) });

  r.get('/settings', requireAdmin, (c) => c.json(savingsSettingsView(v)));
  r.post('/accounts', requireAdmin, async (c) => {
    addHandAccount(v, userId(c), await parseJson(c, SavingsHandAccountInputSchema));
    return c.json(savingsSettingsView(v));
  });
  r.patch('/accounts/:id', requireAdmin, async (c) => {
    const id = accountId(c);
    return c.json(updateSavingsAccount(v, id, await parseJson(c, SavingsAccountPatchSchema)));
  });
  r.post('/accounts/:id/balance', requireAdmin, async (c) => {
    const id = accountId(c);
    setSavingsBalance(v, userId(c), id, await parseJson(c, SavingsSetBalanceInputSchema));
    return c.json(savingsSettingsView(v));
  });
  r.post('/accounts/:id/remove', requireAdmin, async (c) => {
    const id = accountId(c);
    const { deleteData } = await parseJson(c, SavingsRemoveInputSchema);
    removeHandAccount(v, userId(c), id, { deleteData });
    return c.json(savingsSettingsView(v));
  });
  r.post('/accounts/:id/imports', requireAdmin, uploadLimit, uploadSize, async (c) => {
    const id = accountId(c);
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody({ all: false });
    } catch {
      throw new AppError('validation', SAVINGS_MESSAGES.importNoFile);
    }
    const file = form.file;
    if (!(file instanceof File) || file.size === 0) throw new AppError('validation', SAVINGS_MESSAGES.importNoFile);
    if (file.size > SAVINGS_CSV_MAX_BYTES) return c.json({ error: { code: 'validation', message: SAVINGS_MESSAGES.importTooBig } }, 413);
    return c.json(startSavingsImport(iv, userId(c), { accountId: id, fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }), 201);
  });
  r.put('/imports/:id', requireAdmin, choicesBody, async (c) => {
    const id = draftId(c);
    return c.json(updateSavingsImport(iv, userId(c), id, await parseJson(c, SavingsImportUpdateSchema)));
  });
  r.post('/imports/:id/commit', requireAdmin, (c) => c.json(savingsSettingsView(v, commitSavingsImport(iv, userId(c), draftId(c)))));
  r.delete('/imports/:id', requireAdmin, (c) => {
    cancelSavingsImport(v, userId(c), draftId(c));
    return c.body(null, 204);
  });
  r.delete('/accounts/:id/imports/:importId', requireAdmin, (c) => {
    const id = accountId(c);
    const importId = idParam(c, SAVINGS_MESSAGES.importRecordNotFound, 'importId');
    return c.json(savingsSettingsView(v, undoSavingsImport(iv, userId(c), id, importId)));
  });
  r.patch('/accounts/:id/import-profile', requireAdmin, choicesBody, async (c) => {
    const id = accountId(c);
    updateImportProfile(iv, userId(c), id, (await parseJson(c, SavingsProfilePatchSchema)).choices);
    return c.json(savingsSettingsView(v));
  });
  r.delete('/accounts/:id/import-profile', requireAdmin, (c) => {
    clearImportProfile(iv, userId(c), accountId(c));
    return c.json(savingsSettingsView(v));
  });

  const { plaid, bank, savings } = deps;
  if (plaid && bank && savings) {
    const d = { ...v, plaid, bank, savings };
    const connectionId = (c: Context) => idParam(c, PLAID_MESSAGES.notFound);
    // Each asks Plaid; 10 a minute per admin is plenty for a button (spec §15's limit for Refresh).
    const perAdmin = () => rateLimit({ windowMs: 60_000, max: 10, clock: deps.clock, key: (c) => `user:${(c as Context<AppEnv>).get('user')!.id}` });
    const refreshLimit = perAdmin();
    const loadLimit = perAdmin();
    r.post('/connections/:id/accounts', requireAdmin, async (c) => {
      const id = connectionId(c);
      const { accounts } = await parseJson(c, SavingsPickInputSchema);
      return c.json(await pickSavingsAccounts(d, userId(c), id, accounts));
    });
    r.post('/connections/:id/refresh', requireAdmin, refreshLimit, async (c) => c.json(await refreshSavingsConnection(d, userId(c), connectionId(c))));
    r.post('/connections/:id/load-accounts', requireAdmin, loadLimit, async (c) => c.json(await loadSavingsAccounts(d, userId(c), connectionId(c))));
    r.post('/connections/:id/remove', requireAdmin, async (c) => {
      const id = connectionId(c);
      const { deleteData } = await parseJson(c, SavingsRemoveInputSchema);
      return c.json(await removeSavingsConnection(d, userId(c), id, { deleteData }));
    });
  }
  return r;
}
