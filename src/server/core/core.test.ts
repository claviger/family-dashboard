import { Hono } from 'hono';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { FakeClock, localDate } from './clock.js';
import { AppError, errorHandler, loggableError } from './errors.js';
import { normalizeEmail } from './email.js';

describe('FakeClock', () => {
  it('returns the set time and advances', () => {
    const clock = new FakeClock(new Date('2026-11-15T12:00:00Z'));
    expect(clock.now().toISOString()).toBe('2026-11-15T12:00:00.000Z');
    clock.advance(90_000);
    expect(clock.now().toISOString()).toBe('2026-11-15T12:01:30.000Z');
  });
});

describe('localDate', () => {
  it('formats the calendar date in the given zone', () => {
    const instant = new Date('2026-11-16T02:30:00Z');
    expect(localDate(instant, 'UTC')).toBe('2026-11-16');
    expect(localDate(instant, 'America/Los_Angeles')).toBe('2026-11-15');
  });
});

describe('AppError', () => {
  it('maps codes to HTTP statuses', () => {
    expect(new AppError('unauthenticated', 'x').status).toBe(401);
    expect(new AppError('forbidden', 'x').status).toBe(403);
    expect(new AppError('not_found', 'x').status).toBe(404);
    expect(new AppError('validation', 'x').status).toBe(400);
    expect(new AppError('conflict', 'x').status).toBe(409);
    expect(new AppError('rate_limited', 'x').status).toBe(429);
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Alex@Example.COM ')).toBe('alex@example.com');
  });
});

describe('loggableError', () => {
  it("keeps only an error's name and code, never its message", () => {
    expect(loggableError(new AppError('conflict', 'Feed the cat is taken'))).toEqual({ error: 'AppError', code: 'conflict' });
    const drizzle = Object.assign(new Error('Failed query: insert into "todos" params: Surprise party'), {
      cause: Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }),
    });
    expect(loggableError(drizzle)).toEqual({ error: 'Error', code: 'SQLITE_CONSTRAINT_UNIQUE' });
    expect(loggableError(new TypeError('Surprise party'))).toEqual({ error: 'TypeError' });
    expect(loggableError('Surprise party')).toEqual({ error: 'unknown' });
  });
});

describe('errorHandler', () => {
  it("logs an unhandled error's name and code only, never its message (a Drizzle error quotes the query's values)", async () => {
    const lines: string[] = [];
    const app = new Hono();
    app.onError(errorHandler(pino({ level: 'debug' }, { write: (line: string) => { lines.push(line); } })));
    app.get('/boom', () => {
      throw new Error('Failed query: insert into todos values (?) params: Surprise party for Sam', { cause: Object.assign(new Error('UNIQUE'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }) });
    });
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const line = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'unhandled error')!;
    expect(line).toMatchObject({ error: 'Error', code: 'SQLITE_CONSTRAINT_UNIQUE' });
    expect(lines.join('\n')).not.toContain('Surprise party');
  });
});
