import { describe, expect, it } from 'vitest';
import { minutesOf, timeOf, utcToWall, wallToRfc3339, wallToUtcMs, zoneOffsetMs } from './zonedTime.js';

const iso = (ms: number) => new Date(ms).toISOString();

describe('zoneOffsetMs', () => {
  it('follows daylight saving time', () => {
    expect(zoneOffsetMs(Date.parse('2026-07-01T12:00:00Z'), 'America/Los_Angeles')).toBe(-7 * 3600_000);
    expect(zoneOffsetMs(Date.parse('2026-12-01T12:00:00Z'), 'America/Los_Angeles')).toBe(-8 * 3600_000);
    expect(zoneOffsetMs(Date.parse('2026-12-01T12:00:00.789Z'), 'Asia/Kolkata')).toBe(5.5 * 3600_000);
    expect(zoneOffsetMs(Date.parse('2026-12-01T12:00:00Z'), 'UTC')).toBe(0);
  });
});

describe('wallToUtcMs', () => {
  it('converts an ordinary wall time', () => {
    expect(iso(wallToUtcMs('2026-11-20', '09:00', 'America/Los_Angeles'))).toBe('2026-11-20T17:00:00.000Z');
    expect(iso(wallToUtcMs('2026-11-20', '00:00', 'Europe/Berlin'))).toBe('2026-11-19T23:00:00.000Z');
  });

  it('moves a time in a spring-forward gap forward by the gap', () => {
    expect(iso(wallToUtcMs('2026-03-08', '02:30', 'America/Los_Angeles'))).toBe('2026-03-08T10:30:00.000Z'); // 03:30 PDT
    expect(iso(wallToUtcMs('2026-03-29', '02:30', 'Europe/Berlin'))).toBe('2026-03-29T01:30:00.000Z'); // 03:30 CEST
  });

  it('takes the earlier of the two in a fall-back overlap', () => {
    expect(iso(wallToUtcMs('2026-11-01', '01:30', 'America/Los_Angeles'))).toBe('2026-11-01T08:30:00.000Z'); // PDT
    expect(iso(wallToUtcMs('2026-10-25', '02:30', 'Europe/Berlin'))).toBe('2026-10-25T00:30:00.000Z'); // CEST
  });
});

describe('utcToWall', () => {
  it('gives the date and time in the zone, which can be another day', () => {
    expect(utcToWall(Date.parse('2026-11-21T05:30:00Z'), 'America/Los_Angeles')).toEqual({ date: '2026-11-20', time: '21:30' });
    expect(utcToWall(Date.parse('2026-11-20T23:30:00Z'), 'Europe/Berlin')).toEqual({ date: '2026-11-21', time: '00:30' });
  });

  it('round-trips with wallToUtcMs outside DST changes', () => {
    for (const [date, time] of [['2026-01-15', '00:00'], ['2026-06-30', '23:59'], ['2026-11-20', '12:15']] as const) {
      expect(utcToWall(wallToUtcMs(date, time, 'America/New_York'), 'America/New_York')).toEqual({ date, time });
    }
  });
});

describe('wallToRfc3339', () => {
  it('writes the offset in force at that moment', () => {
    expect(wallToRfc3339('2026-11-20', '09:00', 'America/Los_Angeles')).toBe('2026-11-20T09:00:00-08:00');
    expect(wallToRfc3339('2026-07-04', '18:30', 'America/Los_Angeles')).toBe('2026-07-04T18:30:00-07:00');
    expect(wallToRfc3339('2026-11-20', '09:00', 'Asia/Kolkata')).toBe('2026-11-20T09:00:00+05:30');
    expect(wallToRfc3339('2026-11-20', '09:00', 'UTC')).toBe('2026-11-20T09:00:00+00:00');
  });

  it('writes a time in a gap as the time it moves to', () => {
    expect(wallToRfc3339('2026-03-08', '02:30', 'America/Los_Angeles')).toBe('2026-03-08T03:30:00-07:00');
  });
});

describe('minutesOf and timeOf', () => {
  it('convert between HH:MM and minutes since midnight', () => {
    expect(minutesOf('00:00')).toBe(0);
    expect(minutesOf('13:45')).toBe(825);
    expect(timeOf(825)).toBe('13:45');
    expect(timeOf(0)).toBe('00:00');
  });
});
