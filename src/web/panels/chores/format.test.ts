import { describe, expect, it } from 'vitest';
import type { ChorePeopleEntry, ChorePerson } from '../../../shared/chores.js';
import { boardStateLabel, creditPicker, whoLine, wontSeeChores, wontSeeWarning } from './format.js';

const riley: ChorePerson = { id: 2, displayName: 'Riley', color: '#1D9E75' };
const grant: ChorePerson = { id: 1, displayName: 'Alex', color: '#378ADD' };

describe('boardStateLabel', () => {
  const today = '2026-11-15';
  it("says when it's due, since when it's overdue, when it's next, or that it's on a list", () => {
    expect(boardStateLabel({ state: 'due', date: '2026-11-15' }, today, true)).toBe('Due today');
    // A due date after today isn't due yet: it reads like the waiting state, "Next: …".
    expect(boardStateLabel({ state: 'due', date: '2026-11-16' }, today, true)).toBe('Next: Tomorrow');
    expect(boardStateLabel({ state: 'due', date: '2026-11-20' }, today, false)).toMatch(/^Next: [A-Z][a-z]{2}, [A-Z][a-z]{2} 20$/);
    expect(boardStateLabel({ state: 'overdue', date: '2026-11-14' }, today, true)).toBe('Overdue since yesterday');
    expect(boardStateLabel({ state: 'overdue', date: '2026-11-06' }, today, true)).toMatch(/^Overdue since [A-Z]/);
    expect(boardStateLabel({ state: 'waiting', date: '2026-11-16' }, today, true)).toBe('Next: Tomorrow');
    expect(boardStateLabel({ state: 'on_list', date: null }, today, true)).toBe('On your list');
    expect(boardStateLabel({ state: 'on_list', date: null }, today, false)).toBe('On their list');
    expect(boardStateLabel({ state: 'unassigned', date: null }, today, false)).toBeNull();
  });
});

describe('whoLine', () => {
  it('names who got credit, who checked it off when different, and who skipped', () => {
    expect(whoLine({ state: 'done', credited: riley, closedBy: riley })).toBe('Riley');
    expect(whoLine({ state: 'done', credited: riley, closedBy: grant })).toBe('Riley · checked off by Alex');
    expect(whoLine({ state: 'skipped', credited: null, closedBy: grant })).toBe('Skipped by Alex');
    expect(whoLine({ state: 'done', credited: null, closedBy: null })).toBe('Nobody');
  });
});

describe('wontSeeChores', () => {
  it('flags people with neither the Chores nor the To-do panel', () => {
    const base = { ...riley, active: true };
    expect(wontSeeChores({ ...base, hasChores: false, hasTodo: false })).toBe(true);
    expect(wontSeeChores({ ...base, hasChores: true, hasTodo: false })).toBe(false);
    expect(wontSeeChores({ ...base, hasChores: false, hasTodo: true })).toBe(false);
    expect(wontSeeChores(undefined)).toBe(false);
    expect(wontSeeWarning('Riley')).toBe("Riley has neither the Chores nor the To-do panel, so they won't see this chore.");
  });
});

describe('creditPicker', () => {
  const entry = (p: ChorePerson, active = true): ChorePeopleEntry => ({ ...p, active, hasChores: true, hasTodo: true });
  const jordan: ChorePerson = { id: 3, displayName: 'Jordan', color: '#D85A30' };

  it('starts on the credited person when they are active', () => {
    expect(creditPicker(riley, [entry(grant), entry(riley)], grant.id)).toEqual({
      initial: riley.id,
      options: [
        { id: grant.id, label: 'Alex', disabled: false },
        { id: riley.id, label: 'Riley', disabled: false },
      ],
    });
  });

  it('shows a deactivated credited person as a disabled option, and starts on you instead', () => {
    expect(creditPicker(riley, [entry(grant), entry(riley, false), entry(jordan)], grant.id)).toEqual({
      initial: grant.id,
      options: [
        { id: riley.id, label: 'Riley (deactivated)', disabled: true },
        { id: grant.id, label: 'Alex', disabled: false },
        { id: jordan.id, label: 'Jordan', disabled: false },
      ],
    });
  });

  it('leaves out other deactivated people, and starts on the first active person if you are not in the list', () => {
    expect(creditPicker(null, [entry(grant, false), entry(jordan), entry(riley)], 99)).toEqual({
      initial: jordan.id,
      options: [
        { id: jordan.id, label: 'Jordan', disabled: false },
        { id: riley.id, label: 'Riley', disabled: false },
      ],
    });
  });

  it("doesn't start on a credited person who isn't in the people list", () => {
    expect(creditPicker(jordan, [entry(grant)], grant.id)).toEqual({ initial: grant.id, options: [{ id: grant.id, label: 'Alex', disabled: false }] });
  });
});
