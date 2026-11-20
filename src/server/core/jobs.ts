import { Cron } from 'croner';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../db/index.js';
import { jobErrors } from '../db/schema.js';
import type { Clock } from './clock.js';
import { AppError, loggableError } from './errors.js';

export interface JobDef {
  name: string;
  /** 5-field cron pattern, evaluated in the family time zone. */
  cron: string;
  /**
   * `signal` aborts when the scheduler stops, so a job that waits (`sleepUnlessAborted`) can end
   * early. Tests that run a job directly may leave it out.
   */
  run: (signal?: AbortSignal) => Promise<void> | void;
}

/**
 * Waits `ms`, or less if `signal` aborts first; never rejects. A job that varies its own start
 * (calendar.refreshSummary's jitter) waits with this, so stopping the app doesn't wait it out.
 */
export function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    signal?.addEventListener('abort', done);
  });
}

export interface JobDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
}

/**
 * Records a job's failure: one row per job, updated in place with the latest message and time, so a
 * job stuck failing every few minutes can't push other jobs' errors out. The first failure after a
 * success also sets "first seen" (`first_occurred_at`); later ones keep it.
 */
export function recordJobError(deps: JobDeps, job: string, message: string): void {
  const now = deps.clock.now();
  deps.db
    .insert(jobErrors)
    .values({ job, message, occurredAt: now, firstOccurredAt: now })
    .onConflictDoUpdate({
      target: jobErrors.job,
      set: { message, occurredAt: now, firstOccurredAt: sql`coalesce(${jobErrors.firstOccurredAt}, ${now.getTime()})` },
    })
    .run();
}

/** After a job succeeds, its last error stays on the System page but is no longer ongoing. */
function clearOngoingError(deps: JobDeps, job: string): void {
  deps.db.update(jobErrors).set({ firstOccurredAt: null }).where(and(eq(jobErrors.job, job), isNotNull(jobErrors.firstOccurredAt))).run();
}

/** Each job's latest error, newest first. `firstOccurredAt` is null when the job has succeeded since. */
export function recentJobErrors(
  db: Db,
  limit: number,
): { job: string; message: string; occurredAt: string; firstOccurredAt: string | null }[] {
  return db
    .select()
    .from(jobErrors)
    .orderBy(desc(jobErrors.occurredAt), desc(jobErrors.id))
    .limit(limit)
    .all()
    .map((e) => ({
      job: e.job,
      message: e.message,
      occurredAt: e.occurredAt.toISOString(),
      firstOccurredAt: e.firstOccurredAt?.toISOString() ?? null,
    }));
}

/**
 * The message the System page shows for a failed job. Our own errors carry plain messages written
 * for admins, so they're kept. A database error (anything with a SQLite code in its cause chain,
 * or Drizzle's "Failed query" wrapper) quotes the query's values, which can be task titles and
 * notes, so it's reduced to its code.
 */
export function jobErrorMessage(err: unknown, safe = loggableError(err)): string {
  if (err instanceof AppError) return err.message;
  if (!(err instanceof Error)) return 'The job failed.';
  if (safe.code !== undefined || err.message.startsWith('Failed query')) {
    return `Database error${safe.code ? ` (${safe.code})` : ''}. See the server log for when it happened.`;
  }
  return err.message;
}

/**
 * Runs a job, logging and recording any failure instead of throwing. A job whose signal was
 * aborted (the app is stopping) didn't finish and didn't fail: it's logged as aborted, and its
 * job error is neither cleared nor recorded, whether it returned early or threw (R1-M2).
 */
export async function runJob(deps: JobDeps, job: JobDef, signal: AbortSignal = new AbortController().signal): Promise<void> {
  const started = Date.now();
  try {
    await job.run(signal);
    if (signal.aborted) {
      deps.logger.info({ job: job.name, ms: Date.now() - started }, 'job aborted');
      return;
    }
    deps.logger.info({ job: job.name, ms: Date.now() - started }, 'job finished');
    clearOngoingError(deps, job.name);
  } catch (err) {
    if (signal.aborted) {
      deps.logger.info({ job: job.name, ms: Date.now() - started, ...loggableError(err) }, 'job aborted');
      return;
    }
    // Only the error's name and code: a Drizzle error quotes the query's values (task titles).
    const safe = loggableError(err);
    deps.logger.error({ job: job.name, ...safe }, 'job failed');
    recordJobError(deps, job.name, jobErrorMessage(err, safe));
  }
}

/**
 * Schedules jobs in `timeZone`. Returns `stop()`, which stops all crons, aborts the signal running
 * jobs were given, and resolves once any job that is currently running has finished.
 */
export function startScheduler(deps: JobDeps, jobs: JobDef[], timeZone: string): () => Promise<void> {
  const inFlight = new Set<Promise<void>>();
  const stopping = new AbortController();
  const track = (job: JobDef): Promise<void> => {
    const p = runJob(deps, job, stopping.signal).finally(() => inFlight.delete(p));
    inFlight.add(p);
    return p;
  };
  const crons = jobs.map((job) => new Cron(job.cron, { timezone: timeZone, protect: true }, () => track(job)));
  return async () => {
    crons.forEach((c) => c.stop());
    stopping.abort();
    await Promise.all([...inFlight]);
  };
}
