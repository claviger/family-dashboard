import { describe, expect, it } from 'vitest';
import { orderPanels, PANEL_IDS } from './panels.js';
import { CreateUserInputSchema, FamilySettingsSchema, isValidTimeZone } from './api.js';

describe('panels', () => {
  it('orders panels as Calendar, To-do, Chores, Spend, Savings', () => {
    expect(orderPanels(['savings', 'spend', 'calendar', 'chores'])).toEqual(['calendar', 'chores', 'spend', 'savings']);
    expect(PANEL_IDS).toEqual(['calendar', 'todo', 'chores', 'spend', 'savings']);
  });
});

describe('CreateUserInputSchema', () => {
  it('defaults panels to an empty list', () => {
    const parsed = CreateUserInputSchema.parse({
      email: 'kid@example.com', displayName: 'Kid', color: '#378ADD', role: 'member',
    });
    expect(parsed.panels).toEqual([]);
  });

  it('rejects a bad color and an unknown panel', () => {
    expect(CreateUserInputSchema.safeParse({
      email: 'kid@example.com', displayName: 'Kid', color: 'blue', role: 'member',
    }).success).toBe(false);
    expect(CreateUserInputSchema.safeParse({
      email: 'kid@example.com', displayName: 'Kid', color: '#378ADD', role: 'member', panels: ['games'],
    }).success).toBe(false);
  });
});

describe('time zones', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(FamilySettingsSchema.safeParse({ name: 'Smiths', timeZone: 'Mars/Olympus' }).success).toBe(false);
  });
});
