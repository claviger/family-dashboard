import { describe, expect, it } from 'vitest';
import {
  COMMAND_ERROR, DUE_FIXED, DUE_FLOATING, DUE_FULL_DAY, DUE_RECURRING, LIVE_DUE_DATE, LIVE_DUE_FIXED,
  LIVE_DUE_FLOATING, LIVE_INVALID_TOKEN, LIVE_ITEM_NOT_FOUND, REST_ERROR_BODY, UNAUTHORIZED_BODY,
} from '../../test/todoistFixtures.js';
import { classifyCommandError, dueFromTodoist, dueToTodoist, familyLocalToUtc, stableUuid } from './mapping.js';

const LA = 'America/Los_Angeles';

describe('dueFromTodoist', () => {
  it('reads the three documented formats in the family time zone', () => {
    expect(dueFromTodoist(DUE_FULL_DAY, LA)).toEqual({ dueDate: '2026-11-20', dueTime: null, recurring: false, timezone: null });
    expect(dueFromTodoist(DUE_FLOATING, LA)).toEqual({ dueDate: '2026-11-20', dueTime: '10:00', recurring: false, timezone: null });
    // 15:00 UTC is 07:00 in Los Angeles (PST, UTC-8).
    expect(dueFromTodoist(DUE_FIXED, LA)).toEqual({ dueDate: '2026-11-20', dueTime: '07:00', recurring: false, timezone: 'America/Los_Angeles' });
  });

  it('reads the live-verified formats', () => {
    expect(dueFromTodoist(LIVE_DUE_DATE, LA)).toEqual({ dueDate: '2026-12-02', dueTime: null, recurring: false, timezone: null });
    expect(dueFromTodoist(LIVE_DUE_FLOATING, LA)).toEqual({ dueDate: '2026-12-01', dueTime: '09:30', recurring: false, timezone: null });
    expect(dueFromTodoist(LIVE_DUE_FIXED, LA)).toEqual({ dueDate: '2026-12-01', dueTime: '09:30', recurring: false, timezone: 'America/Los_Angeles' });
  });

  it('moves a fixed time to the family-local day, and shows floating times as written', () => {
    expect(dueFromTodoist({ date: '2026-11-21T03:30:00Z', timezone: 'UTC' }, LA)).toEqual({ dueDate: '2026-11-20', dueTime: '19:30', recurring: false, timezone: 'UTC' });
    expect(dueFromTodoist({ date: '2026-11-21T03:30:00Z', timezone: 'UTC' }, 'Europe/London')).toMatchObject({ dueDate: '2026-11-21', dueTime: '03:30' });
    expect(dueFromTodoist({ date: '2026-11-21T03:30:00' }, LA)).toMatchObject({ dueDate: '2026-11-21', dueTime: '03:30' });
  });

  it('flags recurring tasks, and treats a missing or unreadable due as none', () => {
    expect(dueFromTodoist(DUE_RECURRING, LA)).toEqual({ dueDate: '2026-11-20', dueTime: null, recurring: true, timezone: null });
    expect(dueFromTodoist(null, LA)).toEqual({ dueDate: null, dueTime: null, recurring: false, timezone: null });
    expect(dueFromTodoist(undefined, LA)).toEqual({ dueDate: null, dueTime: null, recurring: false, timezone: null });
    expect(dueFromTodoist({ date: 'next week' }, LA)).toEqual({ dueDate: null, dueTime: null, recurring: false, timezone: null });
  });
});

describe('dueToTodoist', () => {
  it('sends a full day, a floating time, or null to clear it', () => {
    expect(dueToTodoist('2026-11-20', null)).toEqual({ date: '2026-11-20' });
    expect(dueToTodoist('2026-11-20', '10:00')).toEqual({ date: '2026-11-20T10:00:00' });
    expect(dueToTodoist(null, null)).toBeNull();
  });

  it("keeps a fixed-timezone task's zone, sending the family-local time as UTC", () => {
    const fixed = { timeZone: 'Europe/Madrid', familyTimeZone: LA };
    // 07:00 in Los Angeles is 15:00 UTC in November (PST) and 14:00 UTC in July (PDT).
    expect(dueToTodoist('2026-11-20', '07:00', fixed)).toEqual({ date: '2026-11-20T15:00:00Z', timezone: 'Europe/Madrid' });
    expect(dueToTodoist('2026-07-01', '07:00', fixed)).toEqual({ date: '2026-07-01T14:00:00Z', timezone: 'Europe/Madrid' });
    expect(dueToTodoist('2026-11-20', null, fixed)).toEqual({ date: '2026-11-20' });
  });
});

describe('familyLocalToUtc', () => {
  it('round-trips with dueFromTodoist, including across daylight saving and the date line', () => {
    for (const [date, time, tz] of [
      ['2026-11-01', '01:30', LA], // the hour that repeats: the first one
      ['2026-03-08', '03:30', LA], // just after spring forward
      ['2026-11-20', '23:45', 'Pacific/Auckland'],
      ['2026-11-20', '00:15', 'Asia/Kolkata'],
    ] as const) {
      const utc = familyLocalToUtc(date, time, tz);
      expect(dueFromTodoist({ date: utc, timezone: 'UTC' }, tz)).toMatchObject({ dueDate: date, dueTime: time });
    }
  });

  it("resolves times next to a daylight-saving change like Temporal's 'compatible'", () => {
    // A time in a spring-forward gap doesn't exist: it moves forward by the gap's length.
    expect(familyLocalToUtc('2026-03-08', '02:30', LA)).toBe('2026-03-08T10:30:00Z'); // 03:30 PDT
    expect(familyLocalToUtc('2026-03-29', '02:30', 'Europe/Berlin')).toBe('2026-03-29T01:30:00Z'); // 03:30 CEST
    // A time in a fall-back overlap happens twice: the earlier one.
    expect(familyLocalToUtc('2026-10-25', '02:30', 'Europe/Berlin')).toBe('2026-10-25T00:30:00Z'); // 02:30 CEST
    expect(familyLocalToUtc('2026-11-01', '01:30', LA)).toBe('2026-11-01T08:30:00Z'); // 01:30 PDT
    // And ordinary times either side.
    expect(familyLocalToUtc('2026-03-08', '01:59', LA)).toBe('2026-03-08T09:59:00Z');
    expect(familyLocalToUtc('2026-10-25', '03:00', 'Europe/Berlin')).toBe('2026-10-25T02:00:00Z');
  });
});

describe('stableUuid', () => {
  it('is UUID-shaped, the same for the same parts, and different otherwise', () => {
    const a = stableUuid('adopt', 3, 41);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableUuid('adopt', 3, 41)).toBe(a);
    expect(stableUuid('adopt', 4, 41)).not.toBe(a);
    expect(stableUuid('adopt', 34, 1)).not.toBe(stableUuid('adopt', 3, 41));
    // The seed and createdAt parts, as the callers pass them.
    expect(stableUuid('adopt', 'seed-a', 1, 1, 1000)).not.toBe(stableUuid('adopt', 'seed-b', 1, 1, 1000));
    expect(stableUuid('adopt', 'seed-a', 1, 1, 1000)).not.toBe(stableUuid('adopt', 'seed-a', 1, 1, 2000));
  });
});

describe('classifyCommandError', () => {
  it('tells auth failures and missing tasks from other rejections', () => {
    expect(classifyCommandError(LIVE_INVALID_TOKEN)).toBe('auth');
    expect(classifyCommandError(UNAUTHORIZED_BODY)).toBe('auth');
    expect(classifyCommandError(LIVE_ITEM_NOT_FOUND)).toBe('not_found');
    expect(classifyCommandError({ error_tag: 'ITEM_NOT_FOUND', http_code: 400 })).toBe('not_found');
    // Only ITEM_NOT_FOUND names a missing task. Other "not found"s (a REST body's NOT_FOUND, a bare
    // 404) could be about a project or anything else, and mustn't remove the row.
    expect(classifyCommandError(REST_ERROR_BODY)).toBe('rejected');
    expect(classifyCommandError({ http_code: 404 })).toBe('rejected');
    expect(classifyCommandError({ error_tag: 'NOT_FOUND' })).toBe('rejected');
    expect(classifyCommandError(COMMAND_ERROR)).toBe('rejected');
    expect(classifyCommandError({ http_code: 403, error_tag: 'FORBIDDEN' })).toBe('rejected');
    expect(classifyCommandError({ error_code: 20, error: 'Invalid argument value' })).toBe('rejected');
  });
});
