import { expect, test, type Page } from '@playwright/test';

const GAP = 24; // var(--space-5)

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  const res = await page.request.post('/auth/test-login', {
    data: { email },
    headers: { 'x-requested-with': 'dashboard', origin: 'http://localhost:3100' },
  });
  expect(res.status()).toBe(204);
}

type Box = { x: number; y: number; width: number; height: number };

async function cardBoxes(page: Page): Promise<Box[]> {
  const cards = page.locator('.card-grid > .card');
  await expect(cards.first()).toBeVisible();
  const boxes: Box[] = [];
  for (const card of await cards.all()) {
    const box = await card.boundingBox();
    if (box) boxes.push(box);
  }
  return boxes;
}

/** Groups the cards by their left edge, so each group is one column, top to bottom. */
function columns(boxes: Box[]): Box[][] {
  const byX = new Map<number, Box[]>();
  for (const box of boxes) {
    const key = [...byX.keys()].find((x) => Math.abs(x - box.x) < 2) ?? box.x;
    byX.set(key, [...(byX.get(key) ?? []), box]);
  }
  return [...byX.values()].map((col) => col.sort((a, b) => a.y - b.y));
}

/** Waits for the cards to stop changing size, so the measured layout is the settled one. */
async function settledBoxes(page: Page): Promise<Box[]> {
  let last = '';
  let boxes: Box[] = [];
  await expect(async () => {
    boxes = await cardBoxes(page);
    const now = JSON.stringify(boxes.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.height)]));
    const same = now === last;
    last = now;
    expect(same).toBe(true);
  }).toPass({ intervals: [250, 250, 500, 500, 1000] });
  return boxes;
}

test.describe('home card layout', () => {
  // The spans are set through the CSSOM, which the strict CSP allows: there must be no violations.
  let cspViolations: string[] = [];
  test.beforeEach(async ({ page }) => {
    cspViolations = [];
    page.on('console', (msg) => {
      if (/Content[- ]Security[- ]Policy/i.test(msg.text())) cspViolations.push(msg.text());
    });
    await signIn(page, 'admin@example.com');
  });

  test.afterEach(() => {
    expect(cspViolations).toEqual([]);
  });

  for (const { width, cols } of [
    { width: 820, cols: 2 },
    { width: 1150, cols: 3 },
    { width: 1600, cols: 4 },
  ]) {
    test(`at ${width}px the cards pack into ${cols} masonry columns`, async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop', 'desktop widths');
      await page.setViewportSize({ width, height: 1200 });
      await page.goto('/');
      await expect(page.locator('.card-grid.masonry')).toBeVisible();

      const cols_ = columns(await settledBoxes(page));
      expect(cols_).toHaveLength(cols);
      let stacked = 0;
      for (const col of cols_) {
        for (let i = 1; i < col.length; i++) {
          const above = col[i - 1]!;
          const gap = col[i]!.y - (above.y + above.height);
          expect(gap, `gap below the card at y=${Math.round(above.y)}`).toBeGreaterThanOrEqual(GAP - 3);
          expect(gap, `gap below the card at y=${Math.round(above.y)}`).toBeLessThanOrEqual(GAP + 3);
          stacked++;
        }
      }
      // There are five panels, so at least one column holds two cards.
      expect(stacked).toBeGreaterThan(0);
    });
  }

  test('at phone width the cards are one plain column', async ({ page }, info) => {
    test.skip(info.project.name !== 'phone', 'phone width');
    await page.goto('/');
    const boxes = await settledBoxes(page);
    expect(columns(boxes)).toHaveLength(1);
    await expect(page.locator('.card-grid.masonry')).toHaveCount(0);
    for (const card of await page.locator('.card-grid > .card').all()) {
      expect(await card.evaluate((el) => (el as HTMLElement).style.gridRowEnd)).toBe('');
    }
    for (let i = 1; i < boxes.length; i++) {
      const gap = boxes[i]!.y - (boxes[i - 1]!.y + boxes[i - 1]!.height);
      expect(gap).toBeGreaterThanOrEqual(GAP - 1);
      expect(gap).toBeLessThanOrEqual(GAP + 1);
    }
  });
});
