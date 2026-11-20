import { HTTPException } from 'hono/http-exception';
import type { Context, ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Logger } from 'pino';
import type { z } from 'zod';

export type ErrorCode =
  | 'unauthenticated' | 'forbidden' | 'not_found' | 'validation'
  | 'conflict' | 'rate_limited' | 'integration_unavailable' | 'outcome_unknown' | 'internal';

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation: 400,
  conflict: 409,
  rate_limited: 429,
  /** A linked service (Todoist, later Google and Plaid) refused or couldn't be reached. Spec §13. */
  integration_unavailable: 503,
  /**
   * Also 503, for a write that was sent to a linked service and got no good answer: it may have
   * been made. A page keeps what was sent as it was, so trying again sends the same thing (C-M4).
   */
  outcome_unknown: 503,
  internal: 500,
};

export class AppError extends Error {
  /**
   * `details` goes to the client beside the message, for a page to act on (which rows a batch
   * refused, say). Never put anything there the client didn't send or can't already read.
   */
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
  }
  get status(): ContentfulStatusCode {
    return STATUS[this.code];
  }
}

/**
 * What a log line may say about an error: its name, and a code when there is one (an AppError's
 * code, or SQLite's, possibly wrapped by Drizzle as `cause`). Never the message or the error
 * itself: Drizzle's message quotes the query's values, which can be people's task titles and notes.
 */
export function loggableError(err: unknown): { error: string; code?: string } {
  const error = err instanceof Error ? err.name : 'unknown';
  if (err instanceof AppError) return { error, code: err.code };
  for (let e = err; e instanceof Error; e = e.cause) {
    const code = (e as Error & { code?: unknown }).code;
    if (typeof code === 'string') return { error, code };
  }
  return { error };
}

export function errorHandler(logger: Logger): ErrorHandler {
  return (err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) } }, err.status);
    }
    if (err instanceof HTTPException) return err.getResponse();
    // Only the error's name and code: a Drizzle error quotes the query's values (task titles).
    logger.error(loggableError(err), 'unhandled error');
    return c.json({ error: { code: 'internal', message: 'Something went wrong. Try again.' } }, 500);
  };
}

/** Parse and validate a JSON request body, throwing AppError('validation') on failure. */
export async function parseJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError('validation', 'Request body must be JSON.');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    // Messages are shown to people as-is, so each schema's messages must read well alone.
    const message = [...new Set(result.error.issues.map((i) => i.message))].join('; ');
    throw new AppError('validation', message);
  }
  return result.data;
}
