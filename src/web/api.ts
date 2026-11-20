export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
    /** Whether the answer was the app's own error JSON, not a proxy's page or no answer at all. */
    public readonly fromApp = false,
  ) {
    super(message);
  }
}

/**
 * A request whose outcome isn't known (review G4-I1): no answer at all (status 0), a gateway's
 * 502 or 503 that isn't the app's own JSON, any 504 (the app never answers 504; nginx does when
 * the app takes too long), or the app's own `outcome_unknown`. The change may or may not have
 * been made, so a page checks before saying it failed.
 */
export function isOutcomeUnknown(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 0 || err.status === 504) return true;
  if ((err.status === 502 || err.status === 503) && !err.fromApp) return true;
  return err.code === 'outcome_unknown';
}

/** Fetch wrapper: JSON in and out, CSRF header on every request, typed errors. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'dashboard' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', "Couldn't reach the server. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
    const fromApp = typeof err?.code === 'string' && typeof err.message === 'string';
    throw new ApiError(res.status, err?.code ?? 'internal', err?.message ?? 'Something went wrong. Try again.', err?.details, fromApp);
  }
  return data as T;
}

/**
 * Uploads a form (a file, say) like `api` sends JSON: the CSRF header, typed errors. A 413 that
 * isn't the app's own JSON comes from the proxy in front of it (nginx's `client_max_body_size`),
 * so it gets the same plain message as the app's limit.
 */
export async function apiUpload<T>(path: string, form: FormData, tooBig: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'dashboard' }, body: form });
  } catch {
    throw new ApiError(0, 'network', "Couldn't reach the server. Check your connection and try again.");
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    if (!err && res.status === 413) throw new ApiError(413, 'validation', tooBig);
    throw new ApiError(res.status, err?.code ?? 'internal', err?.message ?? 'Something went wrong. Try again.');
  }
  return data as T;
}
