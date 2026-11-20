import { Hono } from 'hono';
import {
  CreateUserInputSchema, FamilySettingsSchema, SetGrantInputSchema, UpdateUserInputSchema, type SystemInfo, type UpdateUserResponse,
} from '../../shared/api.js';
import { PanelIdSchema } from '../../shared/panels.js';
import type { AppDeps, AppEnv } from '../app.js';
import { requireAdmin } from '../auth/middleware.js';
import { AppError, parseJson } from '../core/errors.js';
import { recentJobErrors } from '../core/jobs.js';
import { lastBackupTime } from '../db/backup.js';
import { resetLinksForNewKey } from '../integrations/keyReset.js';
import { panelAdminRoutes } from '../panels/registry.js';
import { getFamilySettings, setFamilySettings } from '../settings.js';
import { finishDeactivation } from './deactivate.js';
import { createUser, listUsers, setGrant, updateUser } from './users.js';

function userId(raw: string): number {
  // Plain decimal digits only: Number() would also accept '0x10', '1e1', ' 1', and '1.0'.
  const id = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError('not_found', 'User not found.');
  return id;
}

export function adminRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireAdmin);

  r.get('/users', (c) => c.json(listUsers(deps.db)));

  r.post('/users', async (c) => {
    const input = await parseJson(c, CreateUserInputSchema);
    return c.json({ id: createUser(deps.db, deps.clock, input) }, 201);
  });

  r.patch('/users/:id', async (c) => {
    const patch = await parseJson(c, UpdateUserInputSchema);
    const id = userId(c.req.param('id'));
    updateUser(deps.db, id, patch, { keepSession: c.get('sessionToken') });
    // Their chores are released and their Todoist unlinked (see `finishDeactivation`), with a
    // deadline: past it, that finishes in the background and the admin is told.
    const warnings = patch.active === false ? (await finishDeactivation(deps, id)).warnings : [];
    if (warnings.length > 0) return c.json({ warnings } satisfies UpdateUserResponse);
    return c.body(null, 204);
  });

  r.put('/users/:id/panels/:panelId', async (c) => {
    const panel = PanelIdSchema.safeParse(c.req.param('panelId'));
    if (!panel.success) throw new AppError('not_found', 'Unknown panel.');
    const { enabled } = await parseJson(c, SetGrantInputSchema);
    setGrant(deps.db, userId(c.req.param('id')), panel.data, enabled);
    return c.body(null, 204);
  });

  r.get('/settings', (c) => c.json(getFamilySettings(deps.db)));

  r.put('/settings', async (c) => {
    setFamilySettings(deps.db, await parseJson(c, FamilySettingsSchema));
    deps.onFamilySettingsChanged?.();
    return c.body(null, 204);
  });

  r.route('/panels', panelAdminRoutes(deps));

  r.get('/system', (c) =>
    c.json({
      version: deps.version,
      lastBackupAt: lastBackupTime(deps.backupDir)?.toISOString() ?? null,
      recentErrors: recentJobErrors(deps.db, 50),
      // The calendar and Todoist both warn about a mismatched key, in the same words; it's said once.
      warnings: [...new Set([...deps.systemWarnings, ...deps.calendar.warnings(), ...(deps.todoist?.warnings() ?? []), ...(deps.plaid?.warnings() ?? [])])],
      revocationNotices: [...deps.calendar.revocationNotices(), ...(deps.plaid?.revocationNotices() ?? [])],
      keyMismatch: deps.calendar.keyMismatch || (deps.todoist?.keyMismatch ?? false) || (deps.plaid?.keyMismatch ?? false),
      todoistConfigured: deps.todoist !== null,
      plaidConfigured: deps.plaid !== null,
    } satisfies SystemInfo),
  );

  // The way back from a lost TOKEN_ENCRYPTION_KEY (spec §14): see `resetLinksForNewKey`.
  r.post('/integrations/reset-links', async (c) => c.json(await resetLinksForNewKey(deps)));

  // Any notice in `revocationNotices`: the calendar's or a bank's. Both are rows of pending_revocations, so the ids don't clash.
  r.post('/integrations/revocations/:id/dismiss', (c) => {
    const raw = c.req.param('id');
    const id = /^\d+$/.test(raw) ? Number(raw) : NaN;
    const ok = Number.isSafeInteger(id) && id > 0 && (deps.calendar.dismissRevocation(id) || (deps.plaid?.dismissRevocation(id) ?? false));
    if (!ok) throw new AppError('not_found', 'That warning was already dismissed.');
    deps.logger.info({ userId: c.get('user')!.id, revocationId: id }, 'revocation notice dismissed');
    return c.body(null, 204);
  });

  return r;
}
