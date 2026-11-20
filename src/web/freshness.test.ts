import { describe, expect, it } from 'vitest';
import { TODOIST_STALE_AFTER_MS } from '../shared/integrations.js';
import { formatAgo, isStale, serverNowEstimate } from './freshness.js';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('formatAgo', () => {
  it('rounds down to the largest whole unit', () => {
    expect(formatAgo(ago(0), NOW)).toBe('just now');
    expect(formatAgo(ago(59_999), NOW)).toBe('just now');
    expect(formatAgo(ago(60_000), NOW)).toBe('1 minute ago');
    expect(formatAgo(ago(25 * 60_000), NOW)).toBe('25 minutes ago');
    expect(formatAgo(ago(60 * 60_000), NOW)).toBe('1 hour ago');
    expect(formatAgo(ago(5 * 60 * 60_000 + 59 * 60_000), NOW)).toBe('5 hours ago');
    expect(formatAgo(ago(3 * 24 * 60 * 60_000), NOW)).toBe('3 days ago');
    expect(formatAgo(new Date(NOW + 5000).toISOString(), NOW)).toBe('just now');
  });
});

describe('isStale', () => {
  it('is stale after twice the 10-minute sync interval, and never for a sync that has not happened', () => {
    expect(TODOIST_STALE_AFTER_MS).toBe(20 * 60_000);
    expect(isStale(ago(20 * 60_000), NOW, TODOIST_STALE_AFTER_MS)).toBe(false);
    expect(isStale(ago(20 * 60_000 + 1), NOW, TODOIST_STALE_AFTER_MS)).toBe(true);
    expect(isStale(null, NOW, TODOIST_STALE_AFTER_MS)).toBe(false);
  });
});

describe('serverNowEstimate', () => {
  it("is the server's time at the response plus the time since, so a wrong device clock doesn't matter", () => {
    const fastDevice = NOW + 2 * 60 * 60_000; // the device clock is 2 hours ahead
    const serverNow = new Date(NOW).toISOString();
    expect(serverNowEstimate(serverNow, fastDevice, fastDevice)).toBe(NOW);
    expect(serverNowEstimate(serverNow, fastDevice, fastDevice + 25 * 60_000)).toBe(NOW + 25 * 60_000);
    // A sync 5 minutes before the response: updated 5 minutes ago, not stale, whatever the device thinks.
    const lastSync = ago(5 * 60_000);
    expect(formatAgo(lastSync, serverNowEstimate(serverNow, fastDevice, fastDevice))).toBe('5 minutes ago');
    expect(isStale(lastSync, serverNowEstimate(serverNow, fastDevice, fastDevice), TODOIST_STALE_AFTER_MS)).toBe(false);
    // And it ticks: 16 minutes later on the device, it's 21 minutes old, so stale.
    expect(isStale(lastSync, serverNowEstimate(serverNow, fastDevice, fastDevice + 16 * 60_000), TODOIST_STALE_AFTER_MS)).toBe(true);
  });
});
