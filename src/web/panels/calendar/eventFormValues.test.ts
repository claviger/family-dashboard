import { describe, expect, it } from 'vitest';
import type { CalendarEvent, CalendarSeries } from '../../../shared/calendar.js';
import {
  createdDiffers, createMayHaveLanded, eventValues, followStartWeekday, formChanged, newEventValues, repeatChoices, repeatFromValues, repeatStartFor, repeatValues, toEventInput, updateBody,
  withAllDay, withStart, type FormMode,
} from './eventFormValues.js';

const event: CalendarEvent = {
  id: 'swim0001_20261118T000000Z', etag: '"5"', seriesId: 'swim0001', title: 'Swim', location: 'Pool', description: null, descriptionIsHtml: false,
  allDay: false, startDate: '2026-11-17', endDate: '2026-11-17', lastDate: '2026-11-17', startTime: '16:00', endTime: '17:00',
  startsAt: '2026-11-18T00:00:00.000Z', readOnly: null, eventType: 'default', htmlLink: null, createdBy: null, updatedBy: null,
};
const series: CalendarSeries = {
  id: 'swim0001', etag: '"4"', allDay: false, startDate: '2026-11-03', startTime: '16:00', timeZone: 'America/Los_Angeles',
  repeat: { freq: 'weekly', weekdays: ['TU'], end: { type: 'never' } }, repeatEditable: true, repeatText: 'Every week on Tuesday', moveBlocked: null,
};
const ALL: FormMode = { kind: 'edit', scope: 'all', repeatEditable: true, moveBlocked: null, seriesStart: '2026-11-03' };

describe('repeat values', () => {
  it("start from the series' rule, or a weekly default on the start's weekday", () => {
    expect(repeatValues(null, '2026-11-17')).toEqual({ freq: 'none', weekdays: ['TU'], endType: 'never', endDate: '2026-12-17', count: '10' });
    expect(repeatValues({ freq: 'daily', weekdays: [], end: { type: 'after', count: 4 } }, '2026-11-17')).toMatchObject({ freq: 'daily', endType: 'after', count: '4' });
  });

  it('turn back into a rule, or say what to fix', () => {
    const base = repeatValues(null, '2026-11-17');
    expect(repeatFromValues(base)).toEqual({ rule: null });
    expect(repeatFromValues({ ...base, freq: 'weekly', weekdays: ['FR', 'MO'] })).toEqual({ rule: { freq: 'weekly', weekdays: ['MO', 'FR'], end: { type: 'never' } } });
    expect(repeatFromValues({ ...base, freq: 'monthly', weekdays: ['MO'], endType: 'on', endDate: '2027-01-31' })).toEqual({ rule: { freq: 'monthly', weekdays: [], end: { type: 'on', date: '2027-01-31' } } });
    expect(repeatFromValues({ ...base, freq: 'weekly', weekdays: [] })).toEqual({ error: 'Pick at least one day of the week.', field: 'weekdays' });
    for (const count of ['0', '1.5', 'ten', '1001']) expect(repeatFromValues({ ...base, freq: 'daily', endType: 'after', count })).toHaveProperty('error');
  });
});

describe('the form', () => {
  it('starts a new event at 9 on the day, and moves the end with the start', () => {
    const v = newEventValues('2026-11-20');
    expect(v).toMatchObject({ startDate: '2026-11-20', startTime: '09:00', endTime: '10:00', allDay: false });
    expect(withStart(v, '2026-11-21', '23:30')).toMatchObject({ startDate: '2026-11-21', startTime: '23:30', endDate: '2026-11-22', endTime: '00:30' });
    expect(withStart({ ...v, allDay: true, endDate: '2026-11-22' }, '2026-11-25', '09:00')).toMatchObject({ startDate: '2026-11-25', endDate: '2026-11-27' });
  });

  it("loads an instance's own times with its series' repeat", () => {
    expect(eventValues(event, series)).toMatchObject({ startDate: '2026-11-17', startTime: '16:00', location: 'Pool', repeat: { freq: 'weekly', weekdays: ['TU'] } });
  });

  it('sends the repeat only where it can change and when it did, and blanks as null', () => {
    const initial = eventValues(event, series);
    const v = { ...initial, location: '  ' };
    const thisOne = toEventInput(v, { kind: 'edit', scope: 'this', instance: true }, initial);
    expect(thisOne).toEqual({ input: { title: 'Swim', allDay: false, startDate: '2026-11-17', endDate: '2026-11-17', startTime: '16:00', endTime: '17:00', location: null, description: null } });
    const twice = { ...v, repeat: { ...v.repeat, weekdays: ['TU', 'TH'] as const } } as typeof v;
    expect(toEventInput(twice, ALL, initial)).toMatchObject({ input: { repeat: { freq: 'weekly', weekdays: ['TU', 'TH'] } } });
    const sent = (mode: FormMode, values = twice) => 'repeat' in (toEventInput(values, mode, initial) as { input: object }).input;
    expect(sent(ALL, v)).toBe(false); // unchanged
    expect(sent({ ...ALL, repeatEditable: false } as FormMode)).toBe(false);
    expect(sent({ ...ALL, moveBlocked: 'Some events in this series were changed or deleted on their own.' } as FormMode)).toBe(false);
    expect(toEventInput({ ...v, repeat: { ...v.repeat, freq: 'none' } }, { kind: 'create' })).toMatchObject({ input: { repeat: null } });
    expect(toEventInput({ ...v, allDay: true }, { kind: 'create' })).toMatchObject({ input: { startTime: null, endTime: null } });
    expect(toEventInput({ ...v, title: ' ' }, { kind: 'create' })).toEqual({ error: 'Enter a title.', field: 'title' });
  });

  it("sends the series' etag only for All events", () => {
    const input = { title: 'x', allDay: true, startDate: '2026-11-17', endDate: '2026-11-17', startTime: null, endTime: null, location: null, description: null };
    expect(updateBody(input, 'all', event, series)).toEqual({ scope: 'all', etag: '"5"', seriesEtag: '"4"', event: input });
    expect(updateBody(input, 'this', event, series).seriesEtag).toBeNull();
  });
});

describe('checking only what changed (M-6, M-7)', () => {
  it("checks the times' order on a create, and on an edit only when the times changed", () => {
    const made = { ...eventValues(event, null), endTime: '16:00' }; // made in Google ending when it starts
    expect(toEventInput({ ...made, title: 'Swim!' }, { kind: 'edit', scope: 'this', instance: false }, made)).toHaveProperty('input');
    expect(toEventInput({ ...made, startTime: '16:30' }, { kind: 'edit', scope: 'this', instance: false }, made)).toEqual({ error: 'The end has to be after the start.', field: 'endTime' });
    expect(toEventInput(made, { kind: 'create' })).toEqual({ error: 'The end has to be after the start.', field: 'endTime' });
  });

  it("checks an All events repeat's end against the series' first day", () => {
    const initial = eventValues(event, series);
    const endsOn = (date: string) => ({ ...initial, repeat: { ...initial.repeat, endType: 'on' as const, endDate: date } });
    expect(toEventInput(endsOn('2026-11-10'), ALL, initial)).toMatchObject({ input: { repeat: { end: { type: 'on', date: '2026-11-10' } } } });
    expect(toEventInput(endsOn('2026-11-01'), ALL, initial)).toEqual({ error: 'The repeat has to end on or after the first day.', field: 'repeatEndDate' });
    expect(toEventInput(endsOn('2026-11-10'), { kind: 'create' })).toEqual({ error: 'The repeat has to end on or after the first day.', field: 'repeatEndDate' });
  });
});

describe('a new repeat follows the start (M-8)', () => {
  it("moves a weekly repeat still on the old start's weekday, and leaves weekdays the person picked", () => {
    const prev = { ...newEventValues('2026-11-17'), repeat: { ...newEventValues('2026-11-17').repeat, freq: 'weekly' as const } };
    expect(prev.repeat.weekdays).toEqual(['TU']);
    expect(followStartWeekday(prev, withStart(prev, '2026-11-19', '09:00')).repeat.weekdays).toEqual(['TH']);
    const picked = { ...prev, repeat: { ...prev.repeat, weekdays: ['MO' as const] } };
    expect(followStartWeekday(picked, withStart(picked, '2026-11-19', '09:00')).repeat.weekdays).toEqual(['MO']);
    const two = { ...prev, repeat: { ...prev.repeat, weekdays: ['TU' as const, 'TH' as const] } };
    expect(followStartWeekday(two, withStart(two, '2026-11-18', '09:00')).repeat.weekdays).toEqual(['TU', 'TH']);
  });
});

describe('form errors name their field (R5-I4)', () => {
  it('points at the first field to fix', () => {
    const v = { ...newEventValues('2026-11-20'), title: 'Swim' };
    const err = (values: typeof v) => toEventInput(values, { kind: 'create' });
    expect(err({ ...v, startDate: '' })).toMatchObject({ field: 'startDate' });
    expect(err({ ...v, endDate: '' })).toMatchObject({ field: 'endDate' });
    expect(err({ ...v, startTime: '' })).toMatchObject({ field: 'startTime' });
    expect(err({ ...v, endTime: '' })).toMatchObject({ field: 'endTime' });
    expect(err({ ...v, endDate: '2026-11-19' })).toMatchObject({ field: 'endDate' });
    expect(err({ ...v, allDay: true, endDate: '2026-11-19' })).toMatchObject({ error: 'The end date has to be on or after the start date.', field: 'endDate' });
    expect(err({ ...v, repeat: { ...v.repeat, freq: 'daily', endType: 'on', endDate: '' } })).toMatchObject({ field: 'repeatEndDate' });
    expect(err({ ...v, repeat: { ...v.repeat, freq: 'daily', endType: 'after', count: 'x' } })).toMatchObject({ field: 'repeatCount' });
    expect(err({ ...v, repeat: { ...v.repeat, freq: 'weekly', weekdays: [] } })).toMatchObject({ field: 'weekdays' });
  });
});

describe('the repeat choices (R5-I5, R5-M2)', () => {
  it("say which months and years skip a day, in describeRecurrence's words", () => {
    const label = (start: string, value: string) => repeatChoices(start, { allowNone: true }).find((c) => c.value === value)!.label;
    expect(label('2026-01-28', 'monthly')).toBe('Every month on the 28th');
    expect(label('2026-01-29', 'monthly')).toBe('Every month on the 29th, in months that have one');
    expect(label('2026-01-31', 'monthly')).toBe('Every month on the 31st, in months that have one');
    expect(label('2028-02-29', 'yearly')).toBe('Every year on February 29, in leap years only');
    expect(label('2026-03-01', 'yearly')).toBe('Every year on March 1');
  });

  it("leaves out \"Doesn't repeat\" for All events", () => {
    expect(repeatChoices('2026-11-03', { allowNone: true }).map((c) => c.value)).toEqual(['none', 'daily', 'weekly', 'monthly', 'yearly']);
    expect(repeatChoices('2026-11-03', { allowNone: false }).map((c) => c.value)).toEqual(['daily', 'weekly', 'monthly', 'yearly']);
  });

  it("shift the series' first day by however far the form moved the start, for the end check, its min, and the labels", () => {
    const initial = eventValues(event, series);
    expect(repeatStartFor(ALL, initial, initial)).toBe('2026-11-03');
    const moved = withStart(initial, '2026-11-19', '16:00');
    expect(repeatStartFor(ALL, initial, moved)).toBe('2026-11-05');
    expect(repeatStartFor({ kind: 'create' }, initial, moved)).toBe('2026-11-19');
    // Moved two days later, a repeat ending on the old first day ends too early now.
    const endsOn = { ...moved, repeat: { ...moved.repeat, weekdays: ['TH' as const], endType: 'on' as const, endDate: '2026-11-04' } };
    expect(toEventInput(endsOn, ALL, initial)).toMatchObject({ error: 'The repeat has to end on or after the first day.', field: 'repeatEndDate' });
    expect(toEventInput({ ...endsOn, repeat: { ...endsOn.repeat, endDate: '2026-11-05' } }, ALL, initial)).toHaveProperty('input');
  });
});

describe('switching to all day (R5-M4)', () => {
  it('ends the day before when the timed event ended at midnight', () => {
    const v = { ...newEventValues('2026-11-20'), startTime: '20:00', endDate: '2026-11-21', endTime: '00:00' };
    expect(withAllDay(v, true)).toMatchObject({ allDay: true, startDate: '2026-11-20', endDate: '2026-11-20' });
    expect(withAllDay({ ...v, endTime: '01:00' }, true)).toMatchObject({ allDay: true, endDate: '2026-11-21' });
    expect(withAllDay({ ...v, allDay: true, endDate: '2026-11-20' }, false)).toMatchObject({ allDay: false, endDate: '2026-11-20' });
  });
});

describe('unsaved changes (R5-M5)', () => {
  it('are anything that differs from what the form opened with', () => {
    const v = newEventValues('2026-11-20');
    expect(formChanged(v, v)).toBe(false);
    expect(formChanged({ ...v }, v)).toBe(false);
    expect(formChanged({ ...v, title: 'x' }, v)).toBe(true);
    expect(formChanged({ ...v, repeat: { ...v.repeat, freq: 'daily' } }, v)).toBe(true);
  });
});

describe('a create read back after a retry (R5-M14)', () => {
  it('differs when what Google kept is not what the form sent', () => {
    const input = { title: 'Swim', allDay: false, startDate: '2026-11-17', endDate: '2026-11-17', startTime: '16:00', endTime: '17:00', location: 'Pool', description: null };
    const kept = { ...event, seriesId: null };
    expect(createdDiffers(input, kept)).toBe(false);
    expect(createdDiffers({ ...input, title: 'Swim lesson' }, kept)).toBe(true);
    expect(createdDiffers({ ...input, endTime: '17:30' }, kept)).toBe(true);
    expect(createdDiffers({ ...input, location: null }, kept)).toBe(true);
    expect(createdDiffers({ ...input, description: 'Bring goggles' }, kept)).toBe(true);
  });
});

describe("a create that didn't finish (R5-M14)", () => {
  it('may have been saved when no answer came back, the proxy failed, or the server says Google may have it (C-M4)', () => {
    for (const status of [0, 502, 504]) expect(createMayHaveLanded(status, 'internal'), String(status)).toBe(true);
    expect(createMayHaveLanded(503, 'outcome_unknown')).toBe(true);
    // A definite refusal: Google busy, the link needing a reconnect, the API off, or our own error.
    expect(createMayHaveLanded(503, 'integration_unavailable')).toBe(false);
    for (const status of [400, 403, 404, 409, 429, 500]) expect(createMayHaveLanded(status, 'internal'), String(status)).toBe(false);
  });
});
