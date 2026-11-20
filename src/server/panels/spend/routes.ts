import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import {
  CardInputSchema, CategoryInputSchema, ClosingDateInputSchema, CSV_MAX_BYTES, ImportCommitInputSchema, MoveInputSchema, OverviewQuerySchema,
  ResetInputSchema, RuleInputSchema, SPEND_MESSAGES, TransactionBatchSchema, TransactionPatchSchema,
} from '../../../shared/spend.js';
import {
  BankPickInputSchema, BankRemoveInputSchema, MappingBatchSchema, MappingInputSchema, PFC_CODE_PATTERN, PLAID_MESSAGES, MAPPING_MESSAGES,
} from '../../../shared/plaid.js';
import type { AppDeps, AppEnv } from '../../app.js';
import { requireAdmin } from '../../auth/middleware.js';
import { AppError, parseJson } from '../../core/errors.js';
import { rateLimit } from '../../core/rateLimit.js';
import { banksView, loadBankAccounts, pickAccounts, refreshBank, removeBank } from './banks.js';
import {
  addClosingDate, cardStatements, createCard, deleteCard, deleteClosingDate, editClosingDate, listCards, setCardArchived, updateCard,
} from './cards.js';
import { cancelImport, commitImport, isPreviewId, listImports, previewImport, undoImport } from './imports.js';
import { deleteMapping, mappingView, saveMappings, setMapping } from './mappings.js';
import { createCategory, deleteCategory, listCategories, moveCategory, renameCategory, setCategoryArchived } from './categories.js';
import { applyRulesToPast, createRule, deleteRule, listRules, moveRule, updateRule } from './ruleSettings.js';
import { peopleById } from './store.js';
import { patchTransaction, patchTransactions, removeDuplicate, resetTransaction, restoreDuplicate, spendOverview, spendSummary } from './transactions.js';

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
 * /api/panels/spend/* (requirePanel has checked the Spend grant). Spec §12.14: anyone with the
 * panel can view everything and change a transaction's category, person, and note; only admins
 * change cards, closing dates, categories, and rules, or import.
 *
 *   GET    /summary                                the home card                     → SpendSummary
 *   GET    /overview?card=&cycle=                  the drill-down                    → SpendOverview
 *   PATCH  /transactions                           { changes: [{ id, categoryId?, personUserId?, expected? }] },
 *                                                  up to 500 (64 KB), all or nothing  → SpendTransaction[]
 *   PATCH  /transactions/:id                       { categoryId?, personUserId?, note? } → SpendTransaction
 *   POST   /transactions/:id/reset                 { fields }: Reset to automatic    → SpendTransaction
 *   POST   /transactions/:id/remove-duplicate admin  soft-delete a row with a twin; 409 without one → DuplicateRemoval
 *   POST   /transactions/:id/restore-duplicate admin Undo of the above             → DuplicateRestore
 *   GET    /people                                 everyone, for pickers and names   → SpendPerson[]
 *   GET    /categories                             in order                          → Category[]
 *   GET    /cards                        admin     every card                        → Card[]
 *   POST   /cards                        admin     CardInput                         → 201 Card
 *   PUT    /cards/:id                    admin     CardInput                         → Card
 *   POST   /cards/:id/archive|unarchive  admin                                       → Card
 *   DELETE /cards/:id                    admin     only without transactions         → 204
 *   GET    /cards/:id/statements         admin                                       → CardStatements
 *   POST   /cards/:id/statements         admin     { closingDate }                   → 201 CardStatements
 *   PUT    /statements/:id               admin     { closingDate }                   → CardStatements
 *   DELETE /statements/:id               admin     manual dates only                 → CardStatements
 *   POST   /categories                   admin     { name }                          → 201 Category
 *   PUT    /categories/:id               admin     { name }                          → Category
 *   POST   /categories/:id/archive|unarchive admin                                   → Category
 *   POST   /categories/:id/move          admin     { direction }                     → Category[]
 *   DELETE /categories/:id               admin     only when not in use              → 204
 *   GET    /rules                        admin     in order, with problems           → Rule[]
 *   POST   /rules                        admin     RuleInput                         → 201 RuleSaveResponse
 *   PUT    /rules/:id                    admin     RuleInput                         → RuleSaveResponse
 *   DELETE /rules/:id                    admin                                       → 204
 *   POST   /rules/:id/move               admin     { direction }                     → Rule[]
 *   POST   /rules/apply                  admin     apply every rule to past ones     → { applied }
 *   POST   /imports                      admin     multipart: cardId, file (5 MB)    → 201 ImportPreview
 *   POST   /imports/:id/commit           admin     { include: line numbers }         → ImportResult
 *   DELETE /imports/:id                  admin     cancel the preview                → 204
 *   GET    /cards/:id/imports            admin     recent imports, newest first      → CsvImportRecord[]
 *   DELETE /cards/:id/imports/:importId  admin     undo: delete it and its rows      → { removed }
 *   GET    /mappings                     admin     Plaid category codes              → MappingView
 *   PATCH  /mappings                     admin     { changes: [{ code, categoryId (null deletes), expected? }] },
 *                                                  up to 500 (64 KB), all or nothing  → MappingView
 *   PUT    /mappings/:code               admin     { categoryId }                    → MappingView
 *   DELETE /mappings/:code               admin     detailed codes only               → MappingView
 *
 * With Plaid configured (phase 6b; a 404 otherwise), Spend settings' banks (banks.ts):
 *   GET    /banks                        admin                                       → BanksView
 *   POST   /banks/:id/accounts           admin     { accounts: [{ accountId, action: attach (cardId) | create | skip }] } → BanksView
 *   POST   /banks/:id/refresh            admin     sync now, 10 a minute             → BanksView
 *   POST   /banks/:id/load-accounts      admin     fetch its accounts, 10 a minute   → BanksView
 *   POST   /banks/:id/remove             admin     { deleteTransactions }            → BanksView
 *
 * Uploads are 20 a minute per admin: each one parses a file of up to 5 MB.
 */
export function spendRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const cardId = (c: Context) => idParam(c, SPEND_MESSAGES.cardNotFound);
  const statementId = (c: Context) => idParam(c, SPEND_MESSAGES.closingNotFound);
  const categoryId = (c: Context) => idParam(c, SPEND_MESSAGES.categoryNotFound);
  const ruleId = (c: Context) => idParam(c, SPEND_MESSAGES.ruleNotFound);
  const transactionId = (c: Context) => idParam(c, SPEND_MESSAGES.transactionNotFound);

  r.get('/summary', (c) => c.json(spendSummary(deps)));
  r.get('/overview', (c) => c.json(spendOverview(deps, query(c, OverviewQuerySchema))));
  // 500 changes with their expected values are under 50 KB; anything far bigger isn't from the page.
  const batchSize = bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: { code: 'validation', message: SPEND_MESSAGES.batchTooBig } }, 413),
  });
  r.patch('/transactions', batchSize, async (c) => c.json(patchTransactions(deps, (await parseJson(c, TransactionBatchSchema)).changes)));
  r.patch('/transactions/:id', async (c) => {
    const id = transactionId(c);
    return c.json(patchTransaction(deps, id, await parseJson(c, TransactionPatchSchema)));
  });
  r.post('/transactions/:id/reset', async (c) => {
    const id = transactionId(c);
    return c.json(resetTransaction(deps, id, (await parseJson(c, ResetInputSchema)).fields));
  });
  r.post('/transactions/:id/remove-duplicate', requireAdmin, (c) => c.json(removeDuplicate(deps, transactionId(c))));
  r.post('/transactions/:id/restore-duplicate', requireAdmin, (c) => c.json(restoreDuplicate(deps, transactionId(c))));

  r.get('/people', (c) => c.json([...peopleById(deps.db).values()]));
  r.get('/categories', (c) => c.json(listCategories(deps.db)));

  r.get('/cards', requireAdmin, (c) => c.json(listCards(deps.db)));
  r.post('/cards', requireAdmin, async (c) => c.json(createCard(deps, await parseJson(c, CardInputSchema)), 201));
  r.put('/cards/:id', requireAdmin, async (c) => {
    const id = cardId(c);
    return c.json(updateCard(deps, id, await parseJson(c, CardInputSchema)));
  });
  r.post('/cards/:id/archive', requireAdmin, (c) => c.json(setCardArchived(deps, cardId(c), true)));
  r.post('/cards/:id/unarchive', requireAdmin, (c) => c.json(setCardArchived(deps, cardId(c), false)));
  r.delete('/cards/:id', requireAdmin, (c) => {
    deleteCard(deps, cardId(c));
    return c.body(null, 204);
  });

  r.get('/cards/:id/statements', requireAdmin, (c) => c.json(cardStatements(deps, cardId(c))));
  r.post('/cards/:id/statements', requireAdmin, async (c) => {
    const id = cardId(c);
    const { closingDate } = await parseJson(c, ClosingDateInputSchema);
    return c.json(addClosingDate(deps, id, closingDate), 201);
  });
  r.put('/statements/:id', requireAdmin, async (c) => {
    const id = statementId(c);
    const { closingDate } = await parseJson(c, ClosingDateInputSchema);
    return c.json(editClosingDate(deps, id, closingDate));
  });
  r.delete('/statements/:id', requireAdmin, (c) => c.json(deleteClosingDate(deps, statementId(c))));

  r.post('/categories', requireAdmin, async (c) => c.json(createCategory(deps, (await parseJson(c, CategoryInputSchema)).name), 201));
  r.put('/categories/:id', requireAdmin, async (c) => {
    const id = categoryId(c);
    return c.json(renameCategory(deps, id, (await parseJson(c, CategoryInputSchema)).name));
  });
  r.post('/categories/:id/archive', requireAdmin, (c) => c.json(setCategoryArchived(deps, categoryId(c), true)));
  r.post('/categories/:id/unarchive', requireAdmin, (c) => c.json(setCategoryArchived(deps, categoryId(c), false)));
  r.post('/categories/:id/move', requireAdmin, async (c) => {
    const id = categoryId(c);
    return c.json(moveCategory(deps, id, (await parseJson(c, MoveInputSchema)).direction));
  });
  r.delete('/categories/:id', requireAdmin, (c) => {
    deleteCategory(deps, categoryId(c));
    return c.body(null, 204);
  });

  r.get('/rules', requireAdmin, (c) => c.json(listRules(deps.db)));
  // Before /rules/:id, so "apply" isn't taken for an id (it wouldn't be one anyway).
  r.post('/rules/apply', requireAdmin, (c) => c.json({ applied: applyRulesToPast(deps) }));
  r.post('/rules', requireAdmin, async (c) => c.json(createRule(deps, await parseJson(c, RuleInputSchema)), 201));
  r.put('/rules/:id', requireAdmin, async (c) => {
    const id = ruleId(c);
    return c.json(updateRule(deps, id, await parseJson(c, RuleInputSchema)));
  });
  r.delete('/rules/:id', requireAdmin, (c) => {
    deleteRule(deps, ruleId(c));
    return c.body(null, 204);
  });
  r.post('/rules/:id/move', requireAdmin, async (c) => {
    const id = ruleId(c);
    return c.json(moveRule(deps, id, (await parseJson(c, MoveInputSchema)).direction));
  });

  const uploadLimit = rateLimit({ windowMs: 60_000, max: 20, clock: deps.clock, key: (c) => `user:${(c as Context<AppEnv>).get('user')!.id}` });
  // A little over 5 MB for the form's own parts; the file itself is checked against the limit below.
  const uploadSize = bodyLimit({
    maxSize: CSV_MAX_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: { code: 'validation', message: SPEND_MESSAGES.importTooBig } }, 413),
  });
  const previewId = (c: Context) => {
    const id = c.req.param('id') ?? '';
    if (!isPreviewId(id)) throw new AppError('not_found', SPEND_MESSAGES.importNotFound);
    return id;
  };

  r.post('/imports', requireAdmin, uploadLimit, uploadSize, async (c) => {
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody({ all: false });
    } catch {
      throw new AppError('validation', SPEND_MESSAGES.importNoFile);
    }
    const file = form.file;
    if (!(file instanceof File) || file.size === 0) throw new AppError('validation', SPEND_MESSAGES.importNoFile);
    if (file.size > CSV_MAX_BYTES) return c.json({ error: { code: 'validation', message: SPEND_MESSAGES.importTooBig } }, 413);
    const rawCard = typeof form.cardId === 'string' ? form.cardId : '';
    if (!/^\d+$/.test(rawCard)) throw new AppError('validation', 'Pick a card from the list');
    const preview = previewImport(deps, c.get('user')!.id, { cardId: Number(rawCard), fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    return c.json(preview, 201);
  });
  r.post('/imports/:id/commit', requireAdmin, async (c) => {
    const id = previewId(c);
    const { include } = await parseJson(c, ImportCommitInputSchema);
    return c.json(commitImport(deps, c.get('user')!.id, id, include));
  });
  r.delete('/imports/:id', requireAdmin, (c) => {
    cancelImport(deps, c.get('user')!.id, previewId(c));
    return c.body(null, 204);
  });
  r.get('/cards/:id/imports', requireAdmin, (c) => c.json(listImports(deps, cardId(c))));
  r.delete('/cards/:id/imports/:importId', requireAdmin, (c) => {
    const id = cardId(c);
    const importId = idParam(c, SPEND_MESSAGES.importRecordNotFound, 'importId');
    return c.json(undoImport(deps, c.get('user')!.id, id, importId));
  });

  // The mapping editor works without Plaid: the codes are worth seeing either way (the design's "Routes").
  const pfcCode = (c: Context) => {
    const code = c.req.param('code') ?? '';
    if (!PFC_CODE_PATTERN.test(code)) throw new AppError('not_found', MAPPING_MESSAGES.unknownCode);
    return code;
  };
  r.get('/mappings', requireAdmin, (c) => c.json(mappingView(deps.db)));
  // The editor's one Save (review G4-I3): 500 changes are well under 64 KB.
  r.patch('/mappings', requireAdmin, batchSize, async (c) => c.json(saveMappings(deps, (await parseJson(c, MappingBatchSchema)).changes)));
  r.put('/mappings/:code', requireAdmin, async (c) => {
    const code = pfcCode(c);
    return c.json(setMapping(deps, code, (await parseJson(c, MappingInputSchema)).categoryId));
  });
  r.delete('/mappings/:code', requireAdmin, (c) => c.json(deleteMapping(deps, pfcCode(c))));

  const { plaid, bank } = deps;
  if (plaid && bank) {
    const b = { ...deps, plaid, bank };
    const bankId = (c: Context) => idParam(c, PLAID_MESSAGES.notFound);
    // Refresh asks Plaid each time; 10 a minute per admin is plenty for a button (the design's "Refresh from Plaid").
    const refreshLimit = rateLimit({ windowMs: 60_000, max: 10, clock: deps.clock, key: (c) => `user:${(c as Context<AppEnv>).get('user')!.id}` });
    // Loading accounts asks Plaid twice; it gets its own budget, the same as Refresh's.
    const loadLimit = rateLimit({ windowMs: 60_000, max: 10, clock: deps.clock, key: (c) => `user:${(c as Context<AppEnv>).get('user')!.id}` });
    r.get('/banks', requireAdmin, (c) => c.json(banksView(b)));
    r.post('/banks/:id/accounts', requireAdmin, async (c) => {
      const id = bankId(c);
      const { accounts } = await parseJson(c, BankPickInputSchema);
      return c.json(await pickAccounts(b, c.get('user')!.id, id, accounts));
    });
    r.post('/banks/:id/refresh', requireAdmin, refreshLimit, async (c) => c.json(await refreshBank(b, c.get('user')!.id, bankId(c))));
    r.post('/banks/:id/load-accounts', requireAdmin, loadLimit, async (c) => c.json(await loadBankAccounts(b, c.get('user')!.id, bankId(c))));
    r.post('/banks/:id/remove', requireAdmin, async (c) => {
      const id = bankId(c);
      const { deleteTransactions } = await parseJson(c, BankRemoveInputSchema);
      return c.json(await removeBank(b, c.get('user')!.id, id, { deleteTransactions }));
    });
  }

  return r;
}
