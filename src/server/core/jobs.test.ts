import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { openDb } from '../db/index.js';
import { FakeClock } from './clock.js';
import { jobErrorMessage, recentJobErrors, runJob, sleepUnlessAborted, startScheduler } from './jobs.js';
import { AppError } from './errors.js';

describe('runJob', () => {
  it('records failures without throwing, one row per job with its latest error', async () => {
    const { db } = openDb(':memory:');
    const clock = new FakeClock(new Date('2026-11-15T12:00:00Z'));
    const deps = { db, clock, logger: pino({ level: 'silent' }) };
    await runJob(deps, { name: 'ok', cron: '* * * * *', run: () => {} });
    expect(recentJobErrors(db, 50)).toEqual([]);
    for (let i = 0; i < 205; i++) {
      await runJob(deps, { name: 'boom', cron: '* * * * *', run: () => { throw new Error(`fail ${i}`); } });
      clock.advance(60_000);
    }
    expect(recentJobErrors(db, 300)).toEqual([
      { job: 'boom', message: 'fail 204', occurredAt: '2026-11-15T15:24:00.000Z', firstOccurredAt: '2026-11-15T12:00:00.000Z' },
    ]);
  });

  it('treats a job the scheduler aborted as neither finished nor failed, whether it returned or threw (R1-M2)', async () => {
    const { db } = openDb(':memory:');
    const lines: Record<string, unknown>[] = [];
    const logger = pino({ level: 'debug' }, { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) });
    const clock = new FakeClock(new Date('2026-11-15T12:00:00Z'));
    const deps = { db, clock, logger };
    await runJob(deps, { name: 'boom', cron: '* * * * *', run: () => { throw new Error('first'); } });
    const stopped = new AbortController();
    stopped.abort();
    // Returned early: not a success, so the ongoing error isn't cleared.
    await runJob(deps, { name: 'boom', cron: '* * * * *', run: () => {} }, stopped.signal);
    // Threw because it was cut short: not a failure either.
    clock.advance(60_000);
    await runJob(deps, { name: 'boom', cron: '* * * * *', run: () => { throw new Error('aborted'); } }, stopped.signal);
    expect(recentJobErrors(db, 50)).toEqual([{ job: 'boom', message: 'first', occurredAt: '2026-11-15T12:00:00.000Z', firstOccurredAt: '2026-11-15T12:00:00.000Z' }]);
    expect(lines.filter((l) => l.msg === 'job aborted')).toHaveLength(2);
    expect(lines.filter((l) => l.msg === 'job finished')).toHaveLength(0);
  });

  it("logs a failed job's error name and code only, never its message", async () => {
    const { db } = openDb(':memory:');
    const lines: string[] = [];
    const logger = pino({ level: 'debug' }, { write: (line: string) => { lines.push(line); } });
    const deps = { db, clock: new FakeClock(new Date('2026-11-15T12:00:00Z')), logger };
    await runJob(deps, { name: 'boom', cron: '* * * * *', run: () => { throw Object.assign(new Error('params: Surprise party for Sam'), { code: 'SQLITE_BUSY' }); } });
    const line = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'job failed')!;
    expect(line).toMatchObject({ job: 'boom', error: 'Error', code: 'SQLITE_BUSY' });
    expect(lines.join('\n')).not.toContain('Surprise party');
  });

  it("keeps one stuck job from pushing out other jobs' errors, newest first", async () => {
    const { db } = openDb(':memory:');
    const clock = new FakeClock(new Date('2026-11-15T12:00:00Z'));
    const deps = { db, clock, logger: pino({ level: 'silent' }) };
    await runJob(deps, { name: 'db.backup', cron: '* * * * *', run: () => { throw new Error('disk full'); } });
    for (let i = 0; i < 300; i++) {
      clock.advance(60_000);
      await runJob(deps, { name: 'todo.retryPending', cron: '* * * * *', run: () => { throw new Error(`still waiting ${i}`); } });
    }
    expect(recentJobErrors(db, 50).map((e) => [e.job, e.message])).toEqual([
      ['todo.retryPending', 'still waiting 299'],
      ['db.backup', 'disk full'],
    ]);
  });

  it('starts "first seen" over once the job has succeeded since', async () => {
    const { db } = openDb(':memory:');
    const clock = new FakeClock(new Date('2026-11-15T12:00:00Z'));
    const deps = { db, clock, logger: pino({ level: 'silent' }) };
    let fail = true;
    const job = { name: 'flaky', cron: '* * * * *', run: () => { if (fail) throw new Error('nope'); } };
    await runJob(deps, job);
    clock.advance(60_000);
    await runJob(deps, job);
    expect(recentJobErrors(db, 50)).toMatchObject([{ occurredAt: '2026-11-15T12:01:00.000Z', firstOccurredAt: '2026-11-15T12:00:00.000Z' }]);

    fail = false;
    clock.advance(60_000);
    await runJob(deps, job);
    // The last error stays on the System page; it just isn't ongoing any more.
    expect(recentJobErrors(db, 50)).toMatchObject([{ occurredAt: '2026-11-15T12:01:00.000Z', firstOccurredAt: null }]);

    fail = true;
    clock.advance(60_000);
    await runJob(deps, job);
    expect(recentJobErrors(db, 50)).toMatchObject([{ occurredAt: '2026-11-15T12:03:00.000Z', firstOccurredAt: '2026-11-15T12:03:00.000Z' }]);
  });
});

describe('startScheduler', () => {
  it('stop() waits for a running job to finish', async () => {
    const { db } = openDb(':memory:');
    const deps = { db, clock: new FakeClock(new Date('2026-11-15T12:00:00Z')), logger: pino({ level: 'silent' }) };
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let finished = false;
    const stop = startScheduler(
      deps,
      [{ name: 'slow', cron: '* * * * * *', run: async () => { started(); await gate; finished = true; } }],
      'UTC',
    );
    await startedP;
    let stopped = false;
    const stopP = stop().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false);
    release();
    await stopP;
    expect(finished).toBe(true);
  }, 10_000);

  it('stop() aborts the signal a running job was given, so a job that is waiting ends early', async () => {
    const { db } = openDb(':memory:');
    const deps = { db, clock: new FakeClock(new Date('2026-11-15T12:00:00Z')), logger: pino({ level: 'silent' }) };
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    let aborted = false;
    const stop = startScheduler(
      deps,
      [{ name: 'jittered', cron: '* * * * * *', run: async (signal) => { started(); await sleepUnlessAborted(60_000, signal); aborted = signal?.aborted === true; } }],
      'UTC',
    );
    await startedP;
    const before = Date.now();
    await stop();
    expect(aborted).toBe(true);
    expect(Date.now() - before).toBeLessThan(5_000);
  }, 10_000);

  it('stop() resolves immediately when nothing is running', async () => {
    const { db } = openDb(':memory:');
    const deps = { db, clock: new FakeClock(new Date('2026-11-15T12:00:00Z')), logger: pino({ level: 'silent' }) };
    const stop = startScheduler(deps, [{ name: 'x', cron: '0 0 1 1 *', run: () => {} }], 'UTC');
    await expect(stop()).resolves.toBeUndefined();
  });
});

describe('sleepUnlessAborted', () => {
  it('waits the time given, or returns at once when the signal is already aborted', async () => {
    const before = Date.now();
    await sleepUnlessAborted(30, new AbortController().signal);
    expect(Date.now() - before).toBeGreaterThanOrEqual(25);
    const aborted = new AbortController();
    aborted.abort();
    const start = Date.now();
    await sleepUnlessAborted(60_000, aborted.signal);
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe('jobErrorMessage', () => {
  it('keeps our own messages', () => {
    expect(jobErrorMessage(new AppError('integration_unavailable', "Todoist didn't answer."))).toBe("Todoist didn't answer.");
    expect(jobErrorMessage(new Error('3 chore to-dos are waiting to reach Todoist.'))).toBe('3 chore to-dos are waiting to reach Todoist.');
  });

  it("never shows a database error's query values", () => {
    const sqlite = Object.assign(new Error('UNIQUE constraint failed: todos.title'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    const wrapped = new Error('Failed query: insert into "todos" values (?)\nparams: Buy the birthday present', { cause: sqlite });
    for (const err of [sqlite, wrapped]) {
      const message = jobErrorMessage(err);
      expect(message).toBe('Database error (SQLITE_CONSTRAINT_UNIQUE). See the server log for when it happened.');
      expect(message).not.toContain('birthday');
    }
    expect(jobErrorMessage(new Error('Failed query: select 1\nparams: secret'))).not.toContain('secret');
  });
});
