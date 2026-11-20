import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Spec §15 and research notes §5: `X-Todoist-Hmac-SHA256` is the base64 HMAC-SHA256 of the raw
 * request body, keyed with the app's client secret. Compared in constant time, on the raw bytes
 * (never re-serialized JSON).
 */
export function verifyTodoistSignature(body: Uint8Array, header: string | undefined, clientSecret: string): boolean {
  if (!header) return false;
  const given = Buffer.from(header.trim(), 'base64');
  const expected = createHmac('sha256', clientSecret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}
