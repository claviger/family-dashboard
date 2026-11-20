import { z } from 'zod';
import { PanelIdSchema } from './panels.js';

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const RoleSchema = z.enum(['admin', 'member'], { error: 'Pick a role: admin or member' });
export type Role = z.infer<typeof RoleSchema>;

const ColorSchema = z.string({ error: 'Pick a color' }).regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #378ADD');
const DisplayNameSchema = z
  .string({ error: 'Enter a display name' })
  .trim()
  .min(1, 'Enter a display name')
  .max(60, 'Keep the display name to 60 characters or fewer');
const EmailSchema = z.string({ error: 'Enter an email address' }).trim().email('Enter a valid email address');

export const SessionUserSchema = z.object({
  id: z.number(),
  email: z.string(),
  displayName: z.string(),
  color: z.string(),
  role: RoleSchema,
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const FamilySettingsSchema = z.object({
  name: z
    .string({ error: 'Enter a family name' })
    .trim()
    .min(1, 'Enter a family name')
    .max(80, 'Keep the family name to 80 characters or fewer'),
  timeZone: z.string({ error: 'Pick a time zone' }).refine(isValidTimeZone, 'Pick a time zone from the list'),
});
export type FamilySettings = z.infer<typeof FamilySettingsSchema>;

export const MeResponseSchema = z.object({
  user: SessionUserSchema,
  panels: z.array(PanelIdSchema),
  family: FamilySettingsSchema,
  /** Optional integrations this instance has configured (spec §3.4). The UI hides the rest. */
  features: z.object({ todoist: z.boolean(), plaid: z.boolean() }),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const AdminUserSchema = SessionUserSchema.extend({
  active: z.boolean(),
  lastLoginAt: z.string().nullable(),
  panels: z.array(PanelIdSchema),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const CreateUserInputSchema = z.object({
  email: EmailSchema,
  displayName: DisplayNameSchema,
  color: ColorSchema,
  role: RoleSchema,
  panels: z.array(PanelIdSchema, { error: 'Panels must be a list' }).default([]),
});
export type CreateUserInput = z.infer<typeof CreateUserInputSchema>;

export const UpdateUserInputSchema = z.object({
  email: EmailSchema.optional(),
  displayName: DisplayNameSchema.optional(),
  color: ColorSchema.optional(),
  role: RoleSchema.optional(),
  active: z.boolean({ error: 'Active must be true or false' }).optional(),
});
export type UpdateUserInput = z.infer<typeof UpdateUserInputSchema>;

/**
 * PATCH /api/admin/users/:id answers 204, or 200 with this when part of the change needs the
 * admin's attention, e.g. a deactivation whose Todoist link couldn't be disconnected.
 */
export const UpdateUserResponseSchema = z.object({ warnings: z.array(z.string()) });
export type UpdateUserResponse = z.infer<typeof UpdateUserResponseSchema>;

export const SetGrantInputSchema = z.object({ enabled: z.boolean({ error: 'Enabled must be true or false' }) });

export const SystemInfoSchema = z.object({
  version: z.string(),
  lastBackupAt: z.string().nullable(),
  /** Each job's latest error. `firstOccurredAt` is when its current run of failures started, null once it has succeeded since. */
  recentErrors: z.array(z.object({ job: z.string(), message: z.string(), occurredAt: z.string(), firstOccurredAt: z.string().nullable() })),
  /** Problems an admin must fix, e.g. "TOKEN_ENCRYPTION_KEY doesn't match the stored credentials". */
  warnings: z.array(z.string()),
  /**
   * Google Calendar access the dashboard gave up revoking, each naming the account to remove it
   * from by hand, access of an unknown account waiting for the calendar link to be removed
   * (C-M5), and removed banks Plaid never confirmed, each naming the bank. Shown until an admin
   * dismisses it (`POST /api/admin/integrations/revocations/:id/dismiss`).
   */
  revocationNotices: z.array(z.object({ id: z.number(), message: z.string() })),
  /** TOKEN_ENCRYPTION_KEY doesn't match the stored credentials: the System page offers to reset the links. */
  keyMismatch: z.boolean(),
  /** Todoist is set up on this server, so the reset's confirmation names it. */
  todoistConfigured: z.boolean(),
  /** Plaid is set up on this server, so the reset's confirmation names the banks (phase 6b). */
  plaidConfigured: z.boolean(),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;

export const ApiErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
