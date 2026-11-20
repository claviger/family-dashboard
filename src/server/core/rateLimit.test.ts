import { describe, expect, it } from 'vitest';
import { isTrustedProxy } from './rateLimit.js';

describe('isTrustedProxy', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.10', 'fc00::1', 'fd12:3456::1', '::ffff:10.1.2.3'])(
    'trusts %s',
    (addr) => expect(isTrustedProxy(addr)).toBe(true),
  );
  it.each(['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '2001:db8::1', 'fe80::1', '', 'unknown', '1127.0.0.1'])(
    'does not trust %s',
    (addr) => expect(isTrustedProxy(addr)).toBe(false),
  );
});
