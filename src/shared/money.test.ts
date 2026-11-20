import { describe, expect, it } from 'vitest';
import { centsToInput, formatCents, MAX_AMOUNT_CENTS, parseCents, parseCentsInput } from './money.js';

describe('parseCents', () => {
  it.each([
    ['12.74', 1274],
    ['-12.74', -1274],
    ['1,234.56', 123456],
    ['1234.56', 123456],
    ['-5,000.00', -500000],
    ['1,000,000.01', 100000001],
    ['0.5', 50],
    ['5', 500],
    ['-0.01', -1],
    ['0.00', 0],
    ['-0.00', 0],
    ['007.10', 710],
  ])('reads %s as %d cents', (text, cents) => {
    expect(parseCents(text)).toBe(cents);
  });

  it.each(['', ' 1.00', '1.00 ', '$5.00', '+1.00', '--1', '1,23.00', '12,3456.00', '1.234', '12.', '.50', '1.2.3', '1e3', 'abc', '١٢', '1,000000'])(
    'refuses %j',
    (text) => {
      expect(parseCents(text)).toBeNull();
    },
  );

  it('takes up to $10,000,000.00 either way, and refuses more', () => {
    expect(parseCents('10,000,000.00')).toBe(MAX_AMOUNT_CENTS);
    expect(parseCents('-10000000')).toBe(-MAX_AMOUNT_CENTS);
    expect(parseCents('10000000.01')).toBeNull();
    expect(parseCents('999999999999.99')).toBeNull();
    expect(parseCents('0000000000012.00')).toBe(1200);
  });
});

describe('parseCentsInput', () => {
  it('takes a dollar sign and spaces around what was typed', () => {
    expect(parseCentsInput(' $12.50 ')).toBe(1250);
    expect(parseCentsInput('-$0.01')).toBe(-1);
    expect(parseCentsInput('- $ 3')).toBe(-300);
    expect(parseCentsInput('12')).toBe(1200);
    expect(parseCentsInput('$')).toBeNull();
    expect(parseCentsInput('12 dollars')).toBeNull();
  });
});

describe('formatCents', () => {
  it('formats with Intl, in dollars', () => {
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(-1274)).toBe('-$12.74');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(-0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
  });

  it("uses the transaction's currency, and falls back to USD for a code Intl refuses", () => {
    expect(formatCents(1000, 'EUR')).toBe('€10.00');
    expect(formatCents(1000, 'not a code')).toBe('$10.00');
  });
});

describe('centsToInput', () => {
  it('writes cents as plain decimal text that parses back', () => {
    for (const cents of [0, 1, -1, 1250, -500000, 99]) {
      expect(parseCents(centsToInput(cents))).toBe(cents);
    }
    expect(centsToInput(1250)).toBe('12.50');
    expect(centsToInput(-1)).toBe('-0.01');
  });
});
