import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, apiUpload, isOutcomeUnknown } from './api.js';

afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('maps a network failure to ApiError(0, network)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = await api('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 0,
      code: 'network',
      message: "Couldn't reach the server. Check your connection and try again.",
    });
  });

  it('returns undefined for 204', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api('/api/x', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('maps the error envelope to ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: { code: 'conflict', message: 'Email taken' } }, { status: 409 })),
    );
    await expect(api('/api/x')).rejects.toMatchObject({ status: 409, code: 'conflict', message: 'Email taken' });
  });

  it('falls back to a generic error for non-envelope failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('oops', { status: 500 })));
    await expect(api('/api/x')).rejects.toMatchObject({ status: 500, code: 'internal' });
  });

  it("tells an answer that never came (no connection, a gateway's 502, 503 or 504, the app's outcome_unknown) from the app's own refusal", async () => {
    const answer = async (res: Response | Error) => {
      vi.stubGlobal('fetch', res instanceof Error ? vi.fn().mockRejectedValue(res) : vi.fn().mockResolvedValue(res));
      return (await api('/api/x', { method: 'POST' }).catch((e: unknown) => e)) as ApiError;
    };
    expect(isOutcomeUnknown(await answer(new TypeError('Failed to fetch')))).toBe(true);
    for (const status of [502, 503, 504]) {
      expect(isOutcomeUnknown(await answer(new Response('<html>Bad gateway</html>', { status, headers: { 'content-type': 'text/html' } })))).toBe(true);
    }
    // The app's own 504 is still a gateway's word: the app never answers 504 itself.
    expect(isOutcomeUnknown(await answer(Response.json({ error: { code: 'internal', message: 'x' } }, { status: 504 })))).toBe(true);
    expect(isOutcomeUnknown(await answer(Response.json({ error: { code: 'outcome_unknown', message: 'Maybe' } }, { status: 503 })))).toBe(true);
    // The app said what happened: a known refusal.
    expect(isOutcomeUnknown(await answer(Response.json({ error: { code: 'integration_unavailable', message: 'Busy' } }, { status: 503 })))).toBe(false);
    expect(isOutcomeUnknown(await answer(Response.json({ error: { code: 'conflict', message: 'No' } }, { status: 409 })))).toBe(false);
    expect(isOutcomeUnknown(await answer(new Response('oops', { status: 500 })))).toBe(false);
    expect(isOutcomeUnknown(new Error('not an ApiError'))).toBe(false);
  });

  it('sends JSON body and CSRF header', async () => {
    const f = vi.fn().mockResolvedValue(Response.json({ ok: 1 }));
    vi.stubGlobal('fetch', f);
    await expect(api('/api/x', { method: 'PUT', body: { a: 1 } })).resolves.toEqual({ ok: 1 });
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toMatchObject({ 'X-Requested-With': 'dashboard', 'Content-Type': 'application/json' });
  });
});

describe('apiUpload', () => {
  it('posts the form with the CSRF header, and no JSON content type', async () => {
    const f = vi.fn().mockResolvedValue(Response.json({ id: 'x' }, { status: 201 }));
    vi.stubGlobal('fetch', f);
    const form = new FormData();
    form.set('cardId', '1');
    await expect(apiUpload('/api/x', form, 'Too big')).resolves.toEqual({ id: 'x' });
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init).toMatchObject({ method: 'POST', body: form, headers: { 'X-Requested-With': 'dashboard' } });
  });

  it("gives the app's error, or the plain size message for the proxy's own 413", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'validation', message: 'Not a CSV' } }, { status: 400 })));
    await expect(apiUpload('/api/x', new FormData(), 'Too big')).rejects.toMatchObject({ status: 400, message: 'Not a CSV' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>413 Request Entity Too Large</html>', { status: 413 })));
    await expect(apiUpload('/api/x', new FormData(), 'Too big')).rejects.toMatchObject({ status: 413, code: 'validation', message: 'Too big' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(apiUpload('/api/x', new FormData(), 'Too big')).rejects.toMatchObject({ status: 0, code: 'network' });
  });
});
