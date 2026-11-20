import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { panelGrants, todos, users } from '../../db/schema.js';
import { WEBHOOK_PAYLOAD } from '../../test/todoistFixtures.js';
import { addUser, linkTodoistForTest, makeTestApp, type TestApp } from '../../test/helpers.js';
import { verifyTodoistSignature } from './webhook.js';

function deliver(t: TestApp, body: string, signature = t.fakeTodoist.sign(body)) {
  // No session, no Origin, no X-Requested-With: Todoist sends none of them.
  return t.app.request('/webhooks/todoist', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-todoist-hmac-sha256': signature, 'x-todoist-delivery-id': 'd-1' },
    body,
  });
}

function setup() {
  const t = makeTestApp({ todoist: true });
  const kid = addUser(t.db, t.clock, { email: 'kid@example.com', panels: ['todo'] });
  const account = linkTodoistForTest(t, kid);
  return { t, kid, account, body: JSON.stringify({ ...WEBHOOK_PAYLOAD, user_id: account.id }) };
}

describe('verifyTodoistSignature', () => {
  it('accepts the base64 HMAC-SHA256 of the raw body, and nothing else', () => {
    const body = new TextEncoder().encode('{"a":1}');
    // Computed independently: node -e "console.log(require('crypto').createHmac('sha256','secret').update('{\"a\":1}').digest('base64'))"
    const good = 'qp4uNXX11wmLbKzNeQiIw21f22M0KnO62i1qUXR6hJQ=';
    expect(verifyTodoistSignature(body, good, 'secret')).toBe(true);
    expect(verifyTodoistSignature(body, good, 'other')).toBe(false);
    expect(verifyTodoistSignature(new TextEncoder().encode('{"a": 1}'), good, 'secret')).toBe(false);
    expect(verifyTodoistSignature(body, undefined, 'secret')).toBe(false);
    expect(verifyTodoistSignature(body, 'short', 'secret')).toBe(false);
  });
});

describe('POST /webhooks/todoist', () => {
  it('answers exactly 200 to a signed delivery and syncs that person in the background', async () => {
    const { t, kid, body } = setup();
    const res = await deliver(t, body);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(t.todoist!.state(kid)!.lastSyncAt).not.toBeNull());
  });

  it('starts at most one sync per person every 5 seconds: deliveries within that gap make one sync when it ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { t, kid, body } = setup();
      const settle = async () => {
        for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
      };
      const syncs = () => t.fakeTodoist.requests.filter((r) => r.path === '/api/v1/sync').length;
      expect((await deliver(t, body)).status).toBe(200);
      await settle();
      expect(t.todoist!.state(kid)!.lastSyncAt).not.toBeNull();
      const afterFirst = syncs();
      t.clock.advance(1_000);
      t.fakeTodoist.addTask(t.fakeTodoist.accounts.get(t.todoist!.state(kid)!.todoistUserId)!, { content: 'Milk' });
      for (let i = 0; i < 3; i++) expect((await deliver(t, body)).status).toBe(200);
      await settle();
      expect(syncs()).toBe(afterFirst);
      t.clock.advance(4_000);
      await vi.advanceTimersByTimeAsync(4_000);
      await settle();
      expect(syncs()).toBe(afterFirst + 1);
      expect(t.db.select().from(todos).all().map((r) => r.title)).toEqual(['Milk']);
      // Once the gap has passed, the next delivery syncs at once again.
      t.clock.advance(5_000);
      expect((await deliver(t, body)).status).toBe(200);
      await settle();
      expect(syncs()).toBe(afterFirst + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers 200 for an account nobody linked, and for a signed body it cannot read', async () => {
    const { t, kid } = setup();
    expect((await deliver(t, JSON.stringify({ ...WEBHOOK_PAYLOAD, user_id: 'nobody' }))).status).toBe(200);
    expect((await deliver(t, 'not json')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.todoist!.state(kid)!.lastSyncAt).toBeNull();
  });

  it('rejects a bad or missing signature with 401', async () => {
    const { t, body } = setup();
    expect((await deliver(t, body, t.fakeTodoist.sign(body + ' '))).status).toBe(401);
    expect((await t.app.request('/webhooks/todoist', { method: 'POST', body })).status).toBe(401);
  });

  it("doesn't sync someone without the To-do panel", async () => {
    const { t, kid, body } = setup();
    t.db.delete(panelGrants).where(eq(panelGrants.userId, kid)).run();
    expect((await deliver(t, body)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.todoist!.state(kid)!.lastSyncAt).toBeNull();
  });

  it("doesn't sync a deactivated person", async () => {
    const { t, kid, body } = setup();
    t.db.update(users).set({ active: false }).where(eq(users.id, kid)).run();
    expect((await deliver(t, body)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.todoist!.state(kid)!.lastSyncAt).toBeNull();
  });

  it('allows 600 deliveries a minute per IP, and checks the signature after the limit', async () => {
    const { t } = setup();
    const body = JSON.stringify({ ...WEBHOOK_PAYLOAD, user_id: 'nobody' });
    for (let i = 0; i < 600; i++) expect((await deliver(t, body)).status).toBe(200);
    expect((await deliver(t, body)).status).toBe(429);
    // Limited before the signature is even looked at.
    expect((await t.app.request('/webhooks/todoist', { method: 'POST', body, headers: { 'x-todoist-hmac-sha256': 'bad' } })).status).toBe(429);
    t.clock.advance(60_000);
    expect((await deliver(t, body)).status).toBe(200);
  });

  it("is a 404 when Todoist isn't configured", async () => {
    const t = makeTestApp();
    expect((await t.app.request('/webhooks/todoist', { method: 'POST', body: '{}' })).status).toBe(404);
  });
});
