import type { AppDeps } from '../app.js';
import { AppError, loggableError } from '../core/errors.js';
import { getUser } from './users.js';

/**
 * How long the admin's deactivation request waits for the person's chore to-dos to be flushed and
 * their Todoist to be unlinked. Each Todoist call has its own timeout (revoking waits up to 10
 * seconds per token), so a slow Todoist could otherwise hold the request for a minute or more.
 */
export const DEACTIVATION_DEADLINE_MS = 25_000;

/** What the admin sees when the deadline passes first. */
export const STILL_DISCONNECTING = 'Still disconnecting their Todoist in the background. Check the System page.';

/**
 * The part of deactivating someone that talks to Todoist, after they're marked inactive:
 * `user.deactivated` (e.g. the Chores panel releases their chores and runs their queued chore
 * to-do changes while the link still works), then the unlink, so someone who leaves doesn't leave
 * a working Todoist token behind. Handlers and a failed unlink add plain warnings for the admin.
 */
async function disconnect(deps: AppDeps, userId: number, warnings: string[]): Promise<void> {
  await deps.events.emit('user.deactivated', { userId, warnings });
  if (!deps.todoist?.isLinked(userId)) return;
  try {
    await deps.todoist.unlink(userId);
  } catch (err) {
    deps.logger.warn({ userId, ...loggableError(err) }, "couldn't unlink a deactivated user from todoist");
    const name = getUser(deps.db, userId)?.displayName ?? 'This person';
    const why = err instanceof AppError ? err.message : 'Something went wrong.';
    warnings.push(`${name} is deactivated, but their Todoist couldn't be disconnected: ${why} Their Todoist sign-in is still saved here.`);
  }
}

/**
 * Runs `disconnect` with a deadline. Within it, the admin gets its warnings, as before. Past it,
 * the admin gets STILL_DISCONNECTING and the work carries on in the background; any warning it
 * ends with goes on the System page (`systemWarnings`, until the app restarts; a link that couldn't
 * be removed also still shows as linked on the Admin page). `done` settles when the work has
 * finished, warnings included, and never rejects.
 */
export async function finishDeactivation(
  deps: AppDeps,
  userId: number,
  deadlineMs = DEACTIVATION_DEADLINE_MS,
): Promise<{ warnings: string[]; done: Promise<void> }> {
  const warnings: string[] = [];
  const work = disconnect(deps, userId, warnings).catch((err: unknown) => {
    deps.logger.error({ userId, ...loggableError(err) }, 'disconnecting a deactivated user failed');
    const name = getUser(deps.db, userId)?.displayName ?? 'This person';
    warnings.push(`${name} is deactivated, but disconnecting their Todoist failed. Check that it's no longer linked on the Admin page.`);
  });
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), deadlineMs);
    timer.unref();
  });
  const timedOut = await Promise.race([work.then(() => false as const), late]);
  clearTimeout(timer);
  if (!timedOut) return { warnings, done: work };
  deps.logger.warn({ userId, deadlineMs }, 'deactivation still disconnecting todoist in the background');
  const done = work.then(() => {
    for (const w of warnings) if (!deps.systemWarnings.includes(w)) deps.systemWarnings.push(w);
  });
  return { warnings: [STILL_DISCONNECTING], done };
}
