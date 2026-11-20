/**
 * Wall-clock time in an IANA time zone, by hand: Node 22 and the browsers we support have no
 * Temporal. Shared by the server (the Calendar panel, the Todoist due-time mapping) and the web
 * (the calendar views). Pure, and tested in zonedTime.test.ts, including DST changes.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function parts(instant: number, timeZone: string): Record<string, string> {
  return Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
}

/** How far `timeZone`'s wall clock is ahead of UTC at `instant`, in ms. */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const p = parts(instant, timeZone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  // The formatter has whole seconds; drop the instant's milliseconds so they don't count as offset.
  return asUtc - (instant - (((instant % 1000) + 1000) % 1000));
}

/**
 * A wall-clock date and time in `timeZone` as a UTC instant (epoch ms), resolved the way
 * Temporal's `disambiguation: 'compatible'` does:
 * - a time that happens twice (in a fall-back overlap) is the earlier of the two;
 * - a time that doesn't exist (in a spring-forward gap) moves forward by the gap's length, e.g.
 *   02:30 on a night the clocks jump from 02:00 to 03:00 is 03:30.
 *
 * The offsets in force a day before and a day after are the two candidates (zones change at most
 * once a day); a candidate is real if the zone has that offset at the instant it gives.
 */
export function wallToUtcMs(date: string, time: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const naive = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  const DAY = 24 * 60 * 60_000;
  const before = zoneOffsetMs(naive - DAY, timeZone);
  const after = zoneOffsetMs(naive + DAY, timeZone);
  const real = [before, after].map((offset) => naive - offset).filter((instant) => naive - zoneOffsetMs(instant, timeZone) === instant);
  // In a gap neither is real. The offset from before the change puts the wall time that far past it.
  return real.length > 0 ? Math.min(...real) : naive - before;
}

/** The wall-clock date (YYYY-MM-DD) and time (HH:MM) of `instant` in `timeZone`. */
export function utcToWall(instant: number, timeZone: string): { date: string; time: string } {
  const p = parts(instant, timeZone);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** `+HH:MM` or `-HH:MM` for an offset in ms. */
function offsetText(offsetMs: number): string {
  const sign = offsetMs < 0 ? '-' : '+';
  const minutes = Math.round(Math.abs(offsetMs) / 60_000);
  return `${sign}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * RFC 3339 with the zone's offset at that moment, e.g. `2026-11-20T09:00:00-08:00`: what Google
 * Calendar's `start.dateTime` takes. The time is resolved as `wallToUtcMs` does, so a time in a DST
 * gap comes out as the instant it moves to.
 */
export function wallToRfc3339(date: string, time: string, timeZone: string): string {
  const instant = wallToUtcMs(date, time, timeZone);
  const wall = utcToWall(instant, timeZone);
  return `${wall.date}T${wall.time}:00${offsetText(zoneOffsetMs(instant, timeZone))}`;
}

/** Minutes since midnight for `HH:MM`. */
export function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h! * 60 + m!;
}

/** `HH:MM` for minutes since midnight (0 to 1439). */
export function timeOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
