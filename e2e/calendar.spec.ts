import { devices, expect, test, type Page, type TestInfo } from '@playwright/test';

/**
 * Google Calendar end to end, against the fake Google that playwright.config.ts starts on port
 * 3102. Its consent page approves at once as the family's Google account. The family has one
 * calendar link, so these tests run one at a time, in the `calendar` project (one worker), at
 * desktop and then phone size, and each starts by making sure the calendar is linked (or, for
 * the first, not). Every test's events have their own titles, so repeats don't see each other's.
 */
const MUTATION_HEADERS = { 'x-requested-with': 'dashboard', origin: 'http://localhost:3100' };
const FAKE = 'http://127.0.0.1:3102';

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  const res = await page.request.post('/auth/test-login', { data: { email }, headers: MUTATION_HEADERS });
  expect(res.status()).toBe(204);
}

/**
 * Signs in as a new admin with the Calendar panel, made by the bootstrap admin. One per test:
 * linking is limited to 10 requests a minute per admin, and these tests link many times.
 */
async function signInAdmin(page: Page, info: TestInfo): Promise<{ name: string }> {
  const name = `Cal admin ${stamp(info)}`;
  const email = `cal-admin-${stamp(info).toLowerCase()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  await signIn(page, 'admin@example.com');
  const created = await page.request.post('/api/admin/users', {
    data: { email, displayName: name, color: '#185FA5', role: 'admin', panels: ['calendar'] },
    headers: MUTATION_HEADERS,
  });
  expect(created.status()).toBe(201);
  await signIn(page, email);
  return { name };
}

/**
 * Both sizes in one project, so `--repeat-each` repeats both. A describe group can't set
 * `defaultBrowserType`; both devices are Chromium, which the project already uses.
 */
function size(device: (typeof devices)[string]) {
  const { defaultBrowserType: _browser, ...use } = device;
  return use;
}
const SIZES = [
  { name: 'desktop', use: size(devices['Desktop Chrome']) },
  { name: 'phone', use: size(devices['Pixel 7']) },
] as const;

function stamp(info: TestInfo): string {
  return `${info.titlePath[1]}-${info.repeatEachIndex}-${Date.now().toString(36)}`;
}

/** The family calendar's link: null when it isn't connected, else its status. */
async function linkStatus(page: Page): Promise<string | null> {
  const res = await page.request.get('/api/admin/panels/calendar/link');
  return ((await res.json()) as { connection: { status: string } | null }).connection?.status ?? null;
}

async function linked(page: Page): Promise<boolean> {
  return (await linkStatus(page)) !== null;
}

async function disconnect(page: Page) {
  expect((await page.request.post('/api/admin/panels/calendar/disconnect', { headers: MUTATION_HEADERS })).status()).toBe(200);
}

/** Connects Google Calendar from the admin page and picks "Family". */
async function connectCalendar(page: Page) {
  await page.goto('/admin');
  const integrations = page.getByRole('region', { name: 'Integrations' });
  // A POST (behind the CSRF check), then the browser visits Google's consent page and comes back.
  await integrations.getByRole('button', { name: 'Connect Google Calendar' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  const picker = page.getByRole('form', { name: 'Pick the family calendar' });
  // Which Google account signed in is said before anything is picked.
  await expect(picker.getByText('Connected as family@example.com.')).toBeVisible();
  await expect(picker.getByRole('radio')).toHaveCount(2);
  await picker.getByRole('radio', { name: 'Family' }).check();
  await picker.getByRole('button', { name: 'Use this calendar' }).click();
  await expect(integrations.getByText('Google Calendar is connected.')).toBeVisible();
  await expect(integrations.getByText(/^Showing Family, through Google as family@example\.com\./)).toBeVisible();
}

/** Signs in a new admin, and makes sure the calendar is linked and working (a test may have left it needing a reconnect). */
async function ensureLinked(page: Page, info: TestInfo): Promise<{ name: string }> {
  const admin = await signInAdmin(page, info);
  const status = await linkStatus(page);
  if (status !== null && status !== 'ok') await disconnect(page);
  if (status !== 'ok') await connectCalendar(page);
  return admin;
}

/** Today in the family time zone, and the zone, as the app sees them. */
async function familyDay(page: Page): Promise<{ today: string; timeZone: string }> {
  const res = await page.request.get('/api/panels/calendar/summary');
  return (await res.json()) as { today: string; timeZone: string };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** An event made in Google itself. */
async function addInGoogle(page: Page, fields: Record<string, unknown>) {
  const res = await page.request.post(`${FAKE}/__fake/events`, { data: { calendar: 'Family', ...fields } });
  expect(res.status()).toBe(200);
  return (await res.json()) as { id: string };
}

/** What Google has stored with this title: events and series, with their changed instances. */
async function inGoogle(page: Page, summary: string) {
  const res = await page.request.get(`${FAKE}/__fake/events?calendar=Family&summary=${encodeURIComponent(summary)}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as { id: string; summary: string; location?: string; start: { dateTime?: string; date?: string }; extendedProperties?: { private?: Record<string, string> }; exceptions: Record<string, { summary: string; status?: string }> }[];
}

function timed(date: string, time: string, timeZone: string) {
  return { dateTime: `${date}T${time}:00`, timeZone };
}

/** An event in a list, by its title: the button that opens it. */
function eventButton(page: Page, title: string) {
  return page.getByRole('button', { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, `) });
}

function acceptNextDialog(page: Page): { message: string | null } {
  const seen: { message: string | null } = { message: null };
  page.once('dialog', (d) => {
    seen.message = d.message();
    void d.accept();
  });
  return seen;
}

function dismissNextDialog(page: Page): { message: string | null } {
  const seen: { message: string | null } = { message: null };
  page.once('dialog', (d) => {
    seen.message = d.message();
    void d.dismiss();
  });
  return seen;
}

/** "Wednesday, November 18" as the app says it (en-US, the devices' locale), with the year when it isn't this year's. */
function longDay(date: string, today: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: date.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric', timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Signs in as a new member (not an admin) with the Calendar panel, or the panels given. */
async function signInMember(page: Page, info: TestInfo, panels: string[] = ['calendar']) {
  const email = `cal-member-${stamp(info).toLowerCase()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  await signIn(page, 'admin@example.com');
  const created = await page.request.post('/api/admin/users', {
    data: { email, displayName: `Cal member ${stamp(info)}`, color: '#185FA5', role: 'member', panels },
    headers: MUTATION_HEADERS,
  });
  expect(created.status()).toBe(201);
  await signIn(page, email);
}

/**
 * An all-day event today, made in Google, and fetched past the 5-minute cache. The card shows at
 * most 6 events, and earlier tests' events are still in the fake, but all-day events come first in
 * a day, then by title, so one whose title starts with "Aa" is on the card.
 */
async function allDayToday(page: Page, title: string, fields: Record<string, unknown> = {}): Promise<{ id: string; today: string }> {
  const { today } = await familyDay(page);
  const { id } = await addInGoogle(page, { summary: title, start: { date: today }, end: { date: addDays(today, 1) }, ...fields });
  await page.request.get(`/api/panels/calendar/events?start=${today}&end=${addDays(today, 7)}&refresh=1`);
  return { id, today };
}

/**
 * Deletes every event or series with these titles through the app's DELETE route, for a test's
 * cleanup: a test that fails partway leaves nothing behind for the next one's card. A failed
 * delete fails the test softly, so it doesn't hide the test's own error.
 */
async function deleteInApp(page: Page, ...titles: string[]) {
  for (const title of titles) {
    for (const stored of await inGoogle(page, title)) {
      const read = await page.request.get(`/api/panels/calendar/events/${encodeURIComponent(stored.id)}`);
      if (read.status() === 404) continue;
      expect.soft(read.ok(), `read "${title}" to delete it`).toBe(true);
      if (!read.ok()) continue;
      const detail = (await read.json()) as { event: { etag: string; seriesId: string | null }; series: { etag: string } | null };
      const all = detail.event.seriesId !== null;
      const query = new URLSearchParams({ scope: all ? 'all' : 'this', etag: detail.event.etag, ...(all && detail.series ? { seriesEtag: detail.series.etag } : {}) });
      const removed = await page.request.delete(`/api/panels/calendar/events/${encodeURIComponent(stored.id)}?${query.toString()}`, { headers: MUTATION_HEADERS });
      expect.soft(removed.ok(), `delete "${title}"`).toBe(true);
    }
  }
}

/** The home card's button for an event today: its name has the title, the day, and the time. */
function cardEvent(page: Page, title: string) {
  return page.getByRole('region', { name: 'Calendar' }).getByRole('button', { name: `${title}, Today, All day`, exact: true });
}

/** The card's title, where focus goes when the event that was open is gone. */
function cardTitle(page: Page) {
  return page.getByRole('heading', { name: 'Calendar', level: 2 }).getByRole('link');
}

for (const sized of SIZES) {
  test.describe(sized.name, () => {
    test.use(sized.use);

    test('an admin connects Google Calendar, picks the family calendar, and the card shows its events', async ({ page }, info) => {
      await signInAdmin(page, info);
      if (await linked(page)) await disconnect(page);
      await page.goto('/');
      const card = page.getByRole('region', { name: 'Calendar' });
      await expect(card.getByText("Calendar isn't connected yet.")).toBeVisible();
      await card.getByRole('link', { name: 'Connect it in Integrations' }).click();
      await expect(page).toHaveURL(/\/admin#integrations$/);

      await connectCalendar(page);
      const { today, timeZone } = await familyDay(page);
      const title = `Dentist ${stamp(info)}`;
      await addInGoogle(page, { summary: title, start: timed(addDays(today, 1), '09:00', timeZone), end: timed(addDays(today, 1), '10:00', timeZone) });
      // Fetched again past the 5-minute cache, as the drill-down's refresh button does.
      await page.request.get(`/api/panels/calendar/events?start=${today}&end=${addDays(today, 7)}&refresh=1`);

      await page.goto('/');
      await expect(card.getByText(/Google Calendar · updated just now/)).toBeVisible();
      // The card shows at most 6 events, and earlier tests' events are still in the fake: it's on
      // the card, or "+N more this week" opens the agenda, where it is.
      const onCard = card.getByRole('group', { name: 'Tomorrow' }).getByText(title);
      const more = card.getByRole('link', { name: /^\+\d+ more this week$/ });
      await expect(onCard.or(more).first()).toBeVisible();
      if (!(await onCard.isVisible())) {
        await more.click();
        await expect(page).toHaveURL(/\/calendar\?view=agenda$/);
      } else {
        await page.goto(`/calendar?view=agenda&date=${today}`);
      }
      await expect(page.getByRole('group', { name: 'Tomorrow' }).getByRole('button', { name: new RegExp(`^${escapeRe(title)}, 9:00`) })).toBeVisible();
    });

    test('an event added on the dashboard goes to Google, says who added it, and shows in each view', async ({ page }, info) => {
      const admin = await ensureLinked(page, info);
      const { today } = await familyDay(page);
      const title = `Piano ${stamp(info)}`;
      const tomorrow = addDays(today, 1);
      await page.goto(`/calendar?view=agenda&date=${today}`);
      await page.getByRole('button', { name: 'New event' }).click();
      const dialog = page.getByRole('dialog', { name: 'New event' });
      await expect(dialog.getByLabel('Title')).toBeFocused();
      // The dialog is in the URL, so Back closes it and stays on the page (R5-I3).
      await expect(page).toHaveURL(/new=1/);
      await page.goBack();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/calendar\\?view=agenda&date=${today}$`));
      await page.getByRole('button', { name: 'New event' }).click();
      // Saving with no title points at the title (R5-I4).
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog.getByRole('alert').filter({ hasText: 'Enter a title.' })).toBeVisible();
      await expect(dialog.getByLabel('Title')).toBeFocused();
      await expect(dialog.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');
      await dialog.getByLabel('Title').fill(title);
      // Escape with something typed asks first (R5-M5).
      const asked = dismissNextDialog(page);
      await page.keyboard.press('Escape');
      await expect.poll(() => asked.message).toBe('Discard your changes?');
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Starts').fill(tomorrow);
      await dialog.getByLabel('Start time').fill('15:00');
      await dialog.getByLabel('End time').fill('15:45');
      await dialog.getByLabel('Location').fill('Music school');
      const posted = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/panels/calendar/events'));
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('status').filter({ hasText: `Added ${title}.` })).toBeVisible();
      await expect(dialog).toHaveCount(0);

      const [stored] = await inGoogle(page, title);
      // Attribution is this install's id and the user's; the id is the one the browser chose when the form opened.
      expect(stored).toMatchObject({ location: 'Music school', extendedProperties: { private: { dashboardCreatedBy: expect.stringMatching(/^[0-9a-f]{16}:\d+$/) } } });
      expect((await posted).postDataJSON()).toMatchObject({ id: stored!.id });
      await eventButton(page, title).click();
      const detail = page.getByRole('dialog', { name: title });
      await expect(detail.getByText(`Added by ${admin.name}.`)).toBeVisible();
      await expect(detail.getByText('Where: Music school')).toBeVisible();
      await detail.getByRole('button', { name: 'Close' }).click();
      await expect(eventButton(page, title)).toBeFocused();

      await page.getByRole('button', { name: 'Week', exact: true }).click();
      await expect(page).toHaveURL(/view=week/);
      await expect(eventButton(page, title)).toBeVisible();
      await page.getByRole('button', { name: 'Month', exact: true }).click();
      await expect(page).toHaveURL(/view=month/);
      if (sized.name === 'desktop') {
        // Tomorrow's month, in case tomorrow is past this month's last row.
        await page.goto(`/calendar?view=month&date=${tomorrow}`);
        const table = page.getByRole('table', { name: new RegExp(`^[A-Z][a-z]+ ${tomorrow.slice(0, 4)}$`) });
        await expect(table.getByRole('columnheader', { name: 'Sunday' })).toBeVisible();
        // A cell shows 3 events, and earlier tests' events are still in the fake: it's in
        // tomorrow's cell (its button named with the day, R5-I2), or that cell's "+N more" opens
        // the agenda at tomorrow, where it is.
        const day = longDay(tomorrow, today);
        const inCell = table.getByRole('button', { name: new RegExp(`^${escapeRe(title)}, ${day}, 3:00`) });
        const more = table.getByRole('button', { name: new RegExp(`^\\d+ more on ${day}$`) });
        await expect(inCell.or(more).first()).toBeVisible();
        if (!(await inCell.isVisible())) {
          await more.click();
          await expect(page).toHaveURL(new RegExp(`view=agenda&date=${tomorrow}`));
          await expect(page.getByRole('group', { name: 'Tomorrow' }).getByRole('button', { name: new RegExp(`^${escapeRe(title)}, `) })).toBeVisible();
        }
      } else {
        // Phones read the month as an agenda.
        await expect(page.getByRole('table')).toHaveCount(0);
        await expect(eventButton(page, title)).toBeVisible();
      }
    });

    test('"This event" changes one instance of a repeating event, and the rest of the series stays', async ({ page }, info) => {
      await ensureLinked(page, info);
      const { today, timeZone } = await familyDay(page);
      const title = `Swim ${stamp(info)}`;
      const weekday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${today}T00:00:00Z`).getUTCDay()];
      await addInGoogle(page, { summary: title, recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${weekday}`], start: timed(today, '17:00', timeZone), end: timed(today, '18:00', timeZone) });
      await page.goto(`/calendar?view=agenda&date=${today}`);
      await page.getByRole('button', { name: 'Refresh' }).click();

      await eventButton(page, title).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText(/^Repeats: Every week on /)).toBeVisible();
      await dialog.getByRole('button', { name: 'Edit' }).click();
      await dialog.getByRole('button', { name: 'This event' }).click();
      await expect(dialog.getByText('This changes only this event, so its repeat stays as it is.')).toBeVisible();
      await dialog.getByLabel('Title').fill(`${title} meet`);
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog.getByRole('heading', { name: `${title} meet` })).toBeVisible();
      await dialog.getByRole('button', { name: 'Close' }).click();

      const [series] = await inGoogle(page, title);
      expect(series!.summary).toBe(title);
      expect(Object.values(series!.exceptions).map((e) => e.summary)).toEqual([`${title} meet`]);
      await page.getByRole('button', { name: 'Next week' }).click();
      await expect(eventButton(page, title)).toBeVisible();
      await expect(eventButton(page, `${title} meet`)).toHaveCount(0);

      // With one instance changed on its own, "All events" can't move the series: its dates and times are locked, and say why.
      await eventButton(page, title).click();
      await dialog.getByRole('button', { name: 'Edit' }).click();
      await dialog.getByRole('button', { name: 'All events' }).click();
      await expect(dialog.getByText(/^Some events in this series were changed or deleted on their own/)).toBeVisible();
      await expect(dialog.getByLabel('Starts')).toHaveAttribute('readonly', '');
      await expect(dialog.getByLabel('Start time')).toHaveAttribute('readonly', '');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await dialog.getByRole('button', { name: 'Close' }).click();
    });

    test('"All events" changes the whole series from one of its instances', async ({ page }, info) => {
      await ensureLinked(page, info);
      const { today, timeZone } = await familyDay(page);
      const title = `Band ${stamp(info)}`;
      await addInGoogle(page, { summary: title, recurrence: ['RRULE:FREQ=DAILY;COUNT=10'], start: timed(addDays(today, -3), '16:00', timeZone), end: timed(addDays(today, -3), '17:00', timeZone) });
      await page.goto(`/calendar?view=agenda&date=${today}`);
      await page.getByRole('button', { name: 'Refresh' }).click();

      await eventButton(page, title).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Edit' }).click();
      await dialog.getByRole('button', { name: 'All events' }).click();
      await expect(dialog.getByRole('heading', { name: `Edit all "${title}" events` })).toBeVisible();
      await expect(dialog.getByLabel('How often')).toHaveValue('daily');
      await dialog.getByLabel('Title').fill(`${title} practice`);
      await dialog.getByLabel('Start time').fill('16:30');
      await dialog.getByRole('button', { name: 'Save' }).click();
      // Moving a series gives its instances new ids, so the dialog closes rather than show the old one.
      await expect(page.getByRole('status').filter({ hasText: `Saved ${title} practice.` })).toBeVisible();
      await expect(dialog).toHaveCount(0);

      const [series] = await inGoogle(page, `${title} practice`);
      // The series moved by 30 minutes from its own first day, three days ago.
      expect(series!.start.dateTime).toContain(`${addDays(today, -3)}T16:30`);
      await expect(eventButton(page, `${title} practice`)).toHaveCount(7);
    });

    test('deleting asks first: one event, or one instance of a series', async ({ page }, info) => {
      await ensureLinked(page, info);
      const { today, timeZone } = await familyDay(page);
      const single = `Haircut ${stamp(info)}`;
      const series = `Reading ${stamp(info)}`;
      await addInGoogle(page, { summary: single, start: timed(today, '11:00', timeZone), end: timed(today, '11:30', timeZone) });
      await addInGoogle(page, { summary: series, recurrence: ['RRULE:FREQ=DAILY;COUNT=3'], start: timed(today, '19:00', timeZone), end: timed(today, '19:30', timeZone) });
      await page.goto(`/calendar?view=agenda&date=${today}`);
      await page.getByRole('button', { name: 'Refresh' }).click();

      await eventButton(page, single).click();
      const confirm = acceptNextDialog(page);
      await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
      await expect(page.getByRole('status').filter({ hasText: `Deleted ${single}.` })).toBeVisible();
      expect(confirm.message).toBe(`Delete "${single}"? It's deleted from Google Calendar.`);
      await expect(eventButton(page, single)).toHaveCount(0);
      expect(await inGoogle(page, single)).toEqual([]);

      await expect(eventButton(page, series)).toHaveCount(3);
      await eventButton(page, series).nth(1).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'This event' }).click();
      await expect(page.getByRole('status').filter({ hasText: `Deleted ${series}.` })).toBeVisible();
      await expect(eventButton(page, series)).toHaveCount(2);
      const [stored] = await inGoogle(page, series);
      expect(Object.values(stored!.exceptions).map((e) => e.status)).toEqual(['cancelled']);

      // "All events" deletes the whole series.
      await eventButton(page, series).first().click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'All events' }).click();
      await expect(page.getByRole('status').filter({ hasText: `Deleted ${series}.` })).toBeVisible();
      await expect(eventButton(page, series)).toHaveCount(0);
      expect(await inGoogle(page, series)).toEqual([]);
    });

    test("a link to a series' own id offers only All events, and deleting says it deletes the whole series", async ({ page }, info) => {
      await ensureLinked(page, info);
      const { today, timeZone } = await familyDay(page);
      const title = `Chess ${stamp(info)}`;
      const { id } = await addInGoogle(page, { summary: title, recurrence: ['RRULE:FREQ=DAILY;COUNT=4'], start: timed(today, '18:00', timeZone), end: timed(today, '19:00', timeZone) });
      await page.goto(`/calendar?view=agenda&date=${today}&event=${id}`);
      const dialog = page.getByRole('dialog', { name: title });
      await expect(dialog.getByText('This is the whole series. Editing or deleting it changes every event in it.')).toBeVisible();
      // Edit goes straight to the whole series: there's no "This event".
      await dialog.getByRole('button', { name: 'Edit' }).click();
      await expect(page.getByRole('dialog').getByRole('heading', { name: `Edit all "${title}" events` })).toBeVisible();
      await expect(page.getByRole('dialog').getByRole('button', { name: 'This event' })).toHaveCount(0);
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
      const confirm = acceptNextDialog(page);
      await dialog.getByRole('button', { name: 'Delete' }).click();
      await expect(page.getByRole('status').filter({ hasText: `Deleted ${title}.` })).toBeVisible();
      expect(confirm.message).toBe(`Delete every "${title}" event? The whole series is deleted from Google Calendar.`);
      // Opened from a link, closing replaces its history entry rather than going back past the page.
      await expect(page).toHaveURL(new RegExp(`/calendar\\?view=agenda&date=${today}$`));
      expect(await inGoogle(page, title)).toEqual([]);
    });

    test('saving over a change made in Google says the event changed, and loads it again', async ({ page }, info) => {
      await ensureLinked(page, info);
      const { today, timeZone } = await familyDay(page);
      const title = `Picnic ${stamp(info)}`;
      await addInGoogle(page, { summary: title, location: 'Park', start: timed(today, '12:00', timeZone), end: timed(today, '13:00', timeZone) });
      await page.goto(`/calendar?view=agenda&date=${today}`);
      await page.getByRole('button', { name: 'Refresh' }).click();
      await eventButton(page, title).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Edit' }).click();

      // Someone changes it in Google while the form is open.
      expect((await page.request.post(`${FAKE}/__fake/events/edit`, { data: { calendar: 'Family', summary: title, patch: { location: 'Beach' } } })).status()).toBe(200);
      await dialog.getByLabel('Title').fill(`${title} lunch`);
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog.getByRole('alert').filter({ hasText: 'This event changed. Review and save again.' })).toBeVisible();
      await expect(dialog.getByLabel('Location')).toHaveValue('Beach');
      await expect(dialog.getByLabel('Title')).toHaveValue(title);

      await dialog.getByLabel('Title').fill(`${title} lunch`);
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog.getByRole('heading', { name: `${title} lunch` })).toBeVisible();
      const [stored] = await inGoogle(page, `${title} lunch`);
      expect(stored).toMatchObject({ location: 'Beach' });
    });

    test('clicking an event on the home card opens its detail over the home page, and Back or Escape closes it', async ({ page }, info) => {
      await ensureLinked(page, info);
      const title = `Aa fair ${stamp(info)}`;
      try {
        const { id } = await allDayToday(page, title, { location: 'Fairgrounds' });
        await page.goto('/');
        const button = cardEvent(page, title);
        await expect(button).toBeVisible();
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);

        await button.click();
        const dialog = page.getByRole('dialog', { name: title });
        await expect(dialog.getByText('Where: Fairgrounds')).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Edit' })).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`/\\?calendarEvent=${escapeRe(id)}$`));
        // The dialog is a history entry: Back closes it and stays on the home page, and focus goes back to the event.
        await page.goBack();
        await expect(dialog).toHaveCount(0);
        await expect(page).toHaveURL(/\/$/);
        await expect(button).toBeFocused();

        await button.click();
        await dialog.getByRole('button', { name: 'Close' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page).toHaveURL(/\/$/);
        await expect(button).toBeFocused();

        // Escape closes it too, the same way.
        await button.click();
        await expect(dialog.getByRole('heading', { name: title })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(page).toHaveURL(/\/$/);
        await expect(button).toBeFocused();

        // Delete works from the popup on the home page too.
        const confirm = acceptNextDialog(page);
        await button.click();
        await dialog.getByRole('button', { name: 'Delete' }).click();
        await expect(page.getByRole('status').filter({ hasText: `Deleted ${title}.` })).toBeVisible();
        expect(confirm.message).toBe(`Delete "${title}"? It's deleted from Google Calendar.`);
      } finally {
        await deleteInApp(page, title);
      }
    });

    test("opening and closing the home card's popup keeps the page where it was scrolled to", async ({ page }, info) => {
      // On a phone the cards stack, so the home page scrolls; on a desktop they fit side by side.
      test.skip(sized.name !== 'phone', 'The home page scrolls only at phone size');
      await ensureLinked(page, info);
      // Every panel, so the home page is long; the Calendar card is always the first one.
      await signInMember(page, info, ['calendar', 'todo', 'chores', 'spend']);
      const title = `Aa parade ${stamp(info)}`;
      // Five more today, after it on the card, so the page is long even on a fresh calendar.
      const more = [1, 2, 3, 4, 5].map((n) => `${title} ${n}`);
      try {
        const { today } = await familyDay(page);
        for (const summary of more) await addInGoogle(page, { summary, start: { date: today }, end: { date: addDays(today, 1) } });
        await allDayToday(page, title);
        await page.goto('/');
        await expect(page.getByRole('region', { name: 'Spend' })).toBeVisible();
        const button = cardEvent(page, title);
        await expect(button).toBeVisible();
        // Scroll the page down until the event is at the top of the screen.
        await button.evaluate((el) => el.scrollIntoView({ block: 'start' }));
        const scrolled = await page.evaluate(() => window.scrollY);
        expect(scrolled, 'the page scrolled down to the event').toBeGreaterThan(100);
        const near = async () => expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(scrolled - 4);

        const dialog = page.getByRole('dialog', { name: title });
        await button.click();
        await expect(dialog).toBeVisible();
        await near();
        await dialog.getByRole('button', { name: 'Close' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(button).toBeFocused();
        await near();
        expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrolled)).toBeLessThanOrEqual(4);

        // Back, which pops the history entry, keeps it too.
        await button.click();
        await expect(dialog).toBeVisible();
        await page.goBack();
        await expect(dialog).toHaveCount(0);
        await near();
        expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrolled)).toBeLessThanOrEqual(4);
      } finally {
        await deleteInApp(page, title, ...more);
      }
    });

    test("a member edits an event from the home card's popup, the card shows the change, and deletes it there", async ({ page }, info) => {
      await ensureLinked(page, info);
      await signInMember(page, info);
      const title = `Aa bake sale ${stamp(info)}`;
      try {
        await allDayToday(page, title);
        await page.goto('/');
        await cardEvent(page, title).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: 'Edit' }).click();
        await expect(dialog.getByRole('heading', { name: `Edit "${title}"` })).toBeVisible();
        await dialog.getByLabel('Title').fill(`${title} moved`);
        await dialog.getByLabel('Location').fill('Gym');
        await dialog.getByRole('button', { name: 'Save' }).click();
        await expect(dialog.getByRole('heading', { name: `${title} moved` })).toBeVisible();
        await expect(dialog.getByText('Where: Gym')).toBeVisible();
        await expect(page).toHaveURL(/\/\?calendarEvent=/);
        await dialog.getByRole('button', { name: 'Close' }).click();
        // The card refreshed, and its button for the event is the one focus goes back to.
        await expect(cardEvent(page, `${title} moved`)).toBeFocused();
        await expect(cardEvent(page, title)).toHaveCount(0);
        const [stored] = await inGoogle(page, `${title} moved`);
        expect(stored).toMatchObject({ location: 'Gym', extendedProperties: { private: { dashboardUpdatedBy: expect.stringMatching(/^[0-9a-f]{16}:\d+$/) } } });

        const confirm = acceptNextDialog(page);
        await cardEvent(page, `${title} moved`).click();
        await dialog.getByRole('button', { name: 'Delete' }).click();
        await expect(page.getByRole('region', { name: 'Calendar' }).getByRole('status').filter({ hasText: `Deleted ${title} moved.` })).toBeVisible();
        expect(confirm.message).toBe(`Delete "${title} moved"? It's deleted from Google Calendar.`);
        await expect(dialog).toHaveCount(0);
        await expect(page).toHaveURL(/\/$/);
        // The event is gone, so focus goes to the card's title.
        await expect(cardTitle(page)).toBeFocused();
        await expect(cardEvent(page, `${title} moved`)).toHaveCount(0);
        expect(await inGoogle(page, `${title} moved`)).toEqual([]);
      } finally {
        await deleteInApp(page, title, `${title} moved`);
      }
    });

    test('"This event" on the home card changes one day of a repeating event, and the card shows it', async ({ page }, info) => {
      await ensureLinked(page, info);
      const title = `Aa daily ${stamp(info)}`;
      try {
        await allDayToday(page, title, { recurrence: ['RRULE:FREQ=DAILY;COUNT=3'] });
        await page.goto('/');
        await cardEvent(page, title).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByText(/^Repeats: Every day/)).toBeVisible();
        await dialog.getByRole('button', { name: 'Edit' }).click();
        await dialog.getByRole('button', { name: 'This event' }).click();
        await expect(dialog.getByText('This changes only this event, so its repeat stays as it is.')).toBeVisible();
        await dialog.getByLabel('Title').fill(`${title} solo`);
        await dialog.getByRole('button', { name: 'Save' }).click();
        await expect(dialog.getByRole('heading', { name: `${title} solo` })).toBeVisible();
        await dialog.getByRole('button', { name: 'Close' }).click();

        // Today's event changed on the card, and focus is back on it; the series kept its title.
        // (Tomorrow's may not fit on the card, which earlier tests' events fill.)
        await expect(cardEvent(page, `${title} solo`)).toBeFocused();
        await expect(cardEvent(page, title)).toHaveCount(0);
        const [series] = await inGoogle(page, title);
        expect(series!.summary).toBe(title);
        expect(Object.values(series!.exceptions).map((e) => e.summary)).toEqual([`${title} solo`]);
      } finally {
        await deleteInApp(page, title);
      }
    });

    test('a link to /?calendarEvent= opens a repeating event over the home page, with This event and All events', async ({ page }, info) => {
      await ensureLinked(page, info);
      const title = `Aa camp ${stamp(info)}`;
      try {
        await allDayToday(page, title, { recurrence: ['RRULE:FREQ=DAILY;COUNT=3'] });
        const summary = (await (await page.request.get('/api/panels/calendar/summary')).json()) as { today: string; events: { id: string; title: string; startDate: string }[] };
        const instance = summary.events.find((e) => e.title === title && e.startDate === summary.today)!;
        await page.goto(`/?calendarEvent=${instance.id}`);
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByRole('heading', { name: title })).toBeVisible();
        await expect(dialog.getByText(/^Repeats: Every day/)).toBeVisible();

        // Edit asks which, and All events edits the whole series.
        await dialog.getByRole('button', { name: 'Edit' }).click();
        await expect(dialog.getByRole('heading', { name: `Change "${title}"` })).toBeVisible();
        await dialog.getByRole('button', { name: 'All events' }).click();
        await expect(dialog.getByRole('heading', { name: `Edit all "${title}" events` })).toBeVisible();
        await dialog.getByLabel('Title').fill(`${title} week`);
        await dialog.getByRole('button', { name: 'Save' }).click();
        await expect(page.getByRole('region', { name: 'Calendar' }).getByRole('status').filter({ hasText: `Saved ${title} week.` })).toBeVisible();
        await expect(dialog).toHaveCount(0);
        // Opened from a link, closing replaces its history entry; after "All events" focus goes to the card's title.
        await expect(page).toHaveURL(/\/$/);
        await expect(cardTitle(page)).toBeFocused();
        await expect(cardEvent(page, `${title} week`)).toBeVisible();

        // Deleting asks which too; All events deletes the series.
        await cardEvent(page, `${title} week`).click();
        await dialog.getByRole('button', { name: 'Delete' }).click();
        await dialog.getByRole('button', { name: 'All events' }).click();
        await expect(page.getByRole('region', { name: 'Calendar' }).getByRole('status').filter({ hasText: `Deleted ${title} week.` })).toBeVisible();
        await expect(cardEvent(page, `${title} week`)).toHaveCount(0);
        expect(await inGoogle(page, `${title} week`)).toEqual([]);
      } finally {
        await deleteInApp(page, title, `${title} week`);
      }
    });

    test("when the link needs reconnecting, the home card's popup shows the event as last fetched, read-only", async ({ page }, info) => {
      await ensureLinked(page, info);
      const title = `Aa recital ${stamp(info)}`;
      try {
        const { today } = await allDayToday(page, title);
        await page.goto('/');
        await expect(cardEvent(page, title)).toBeVisible();

        // The family's Google account removes the dashboard's access, and the next fetch finds out.
        expect((await page.request.post(`${FAKE}/__fake/revoke-account`, { data: { email: 'family@example.com' } })).status()).toBe(200);
        await page.request.get(`/api/panels/calendar/events?start=${today}&end=${addDays(today, 7)}&refresh=1`);
        await page.reload();
        await cardEvent(page, title).click();
        const dialog = page.getByRole('dialog', { name: title });
        await expect(dialog.getByText("Google Calendar needs to be reconnected, so this is the event as last fetched, and it can't be changed until then.")).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Edit' })).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: 'Delete' })).toHaveCount(0);
        await dialog.getByRole('button', { name: 'Close' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(cardEvent(page, title)).toBeFocused();
      } finally {
        // Link again, so the event can be deleted and later tests' all-day events stay on the card.
        const status = await linkStatus(page);
        if (status !== 'ok') {
          if (status !== null) await disconnect(page);
          await connectCalendar(page);
        }
        await deleteInApp(page, title);
      }
    });

    test('when the link needs reconnecting, events show as last fetched, read-only, with a note', async ({ page }, info) => {
      await ensureLinked(page, info);
      const { today, timeZone } = await familyDay(page);
      const title = `Recital ${stamp(info)}`;
      await addInGoogle(page, { summary: title, start: timed(today, '10:00', timeZone), end: timed(today, '11:00', timeZone) });
      await page.goto(`/calendar?view=agenda&date=${today}`);
      await page.getByRole('button', { name: 'Refresh' }).click();
      await expect(eventButton(page, title)).toBeVisible();

      // The family's Google account removes the dashboard's access: the next fetch finds out.
      expect((await page.request.post(`${FAKE}/__fake/revoke-account`, { data: { email: 'family@example.com' } })).status()).toBe(200);
      await page.getByRole('button', { name: 'Refresh' }).click();
      await expect(page.getByRole('status').filter({ hasText: /^Google Calendar needs to be reconnected, so this shows what was last fetched/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'New event' })).toHaveCount(0);

      await eventButton(page, title).click();
      const dialog = page.getByRole('dialog', { name: title });
      await expect(dialog.getByText("Google Calendar needs to be reconnected, so this is the event as last fetched, and it can't be changed until then.")).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Edit' })).toHaveCount(0);
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).toHaveCount(0);
      // The next test links again.
      await disconnect(page);
    });

    test('an admin disconnects Google Calendar, which revokes its access', async ({ page }, info) => {
      await ensureLinked(page, info);
      const before = ((await (await page.request.get(`${FAKE}/__fake/revocations`)).json()) as unknown[]).length;
      await page.goto('/admin');
      const integrations = page.getByRole('region', { name: 'Integrations' });
      const confirm = acceptNextDialog(page);
      await integrations.getByRole('button', { name: 'Disconnect' }).click();
      await expect(integrations.getByText('Google Calendar is disconnected.')).toBeVisible();
      expect(confirm.message).toContain('Nobody is signed out of the dashboard.');
      await expect(integrations.getByRole('button', { name: 'Connect Google Calendar' })).toBeVisible();
      const revocations = (await (await page.request.get(`${FAKE}/__fake/revocations`)).json()) as { kind: string }[];
      expect(revocations.slice(before)).toEqual([expect.objectContaining({ kind: 'refresh' })]);

      await page.goto('/');
      await expect(page.getByRole('region', { name: 'Calendar' }).getByText("Calendar isn't connected yet.")).toBeVisible();
    });
  });
}
