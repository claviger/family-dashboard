import { describe, expect, it } from 'vitest';
import { DUPLICATE_TEST, DuplicateMatcher, findDuplicate, normalizeMerchant, SCAN_LIMIT, similarMerchants, type DuplicateCandidate } from './duplicates.js';

describe('normalizeMerchant', () => {
  it('uppercases, turns anything but letters and digits into spaces, and collapses them', () => {
    expect(normalizeMerchant('  Blue-Bottle  Coffee #12 ')).toBe('BLUE BOTTLE COFFEE 12');
    expect(normalizeMerchant('AMZN Mktp US*2K4AB1')).toBe('AMZN MKTP US 2K4AB1');
    expect(normalizeMerchant('Café Rouge')).toBe('CAFÉ ROUGE');
    expect(normalizeMerchant('*** ---')).toBe('');
  });
});

describe('similarMerchants', () => {
  it("is true when one starts with the other's first 8 characters", () => {
    expect(similarMerchants('STARBUCKS STORE 12345 SEATTLE WA', 'Starbucks')).toBe(true);
    expect(similarMerchants('AMAZON MKTPL*ABC', 'Amazon Marketplace')).toBe(true);
    // A name shorter than 8 characters has to start the other one whole.
    expect(similarMerchants('UBER', 'UBER EATS')).toBe(true);
    // Short names match loosely; the amount and the dates have to match as well.
    expect(similarMerchants('UBER', 'UBERLIN BAKERY')).toBe(true);
    expect(similarMerchants('LYFT', 'UBER')).toBe(false);
  });

  it('runs the prefix test without spaces too', () => {
    expect(similarMerchants('CVS/PHARMACY #123', 'CVSPHARMACY')).toBe(true);
    expect(similarMerchants('WAL-MART #1234', 'WALMART #1234')).toBe(true);
  });

  it('is true when at least half of the larger set of words is shared', () => {
    expect(similarMerchants('TST* JOES PIZZA OAKLAND', 'JOES PIZZA')).toBe(true); // 2 of 4
    expect(similarMerchants('SHELL OIL 1234 WA', 'CHEVRON WA')).toBe(false); // 1 of 4
    expect(similarMerchants('THE HOME DEPOT', 'HOME DEPOT INC')).toBe(true); // 2 of 3
  });

  it('is never true for text with no letters or digits', () => {
    expect(similarMerchants('***', '***')).toBe(false);
    expect(similarMerchants('', 'X')).toBe(false);
  });

  it('follows tuned thresholds', () => {
    expect(similarMerchants('TST* JOES PIZZA OAKLAND', 'JOES PIZZA', { ...DUPLICATE_TEST, wordShare: 0.75 })).toBe(false);
    expect(similarMerchants('STARBUCKS STORE', 'STARBUCKZ', { ...DUPLICATE_TEST, prefixChars: 9 })).toBe(false);
    expect(similarMerchants('STARBUCKS STORE', 'STARBUCKZ')).toBe(true);
  });
});

describe('DuplicateMatcher', () => {
  it("tests a stored row's raw name too, when it has one beside its merchant name", () => {
    // The shapes a year of real imports showed: Plaid's merchant name against BofA's payee.
    expect(similarMerchants("McDonald's", 'McDonalds 5795 142-5483579 W')).toBe(true);
    expect(similarMerchants('Needles & Hooks', 'Needles Hooks Lake Forest PW')).toBe(true);
    expect(similarMerchants('Haleakala National Park', 'HALEAKALA NATIONAL PARK KULA')).toBe(true);
    expect(similarMerchants('Seattle Childrens Hospital', 'MED*SEATTLE CHILDRENS HOS206')).toBe(true); // 2 of 4 words
    // Plaid's cleaned name alone isn't enough here (1 of 4 words); its raw name is.
    expect(similarMerchants('Tinynonsens', 'PAYPAL *TINYNONSENS 207-200-')).toBe(false);
    const row = { cardId: 1, date: '2026-11-02', amountCents: 1500, merchant: 'PAYPAL *TINYNONSENS 207-200-', reference: '1' };
    const stored = { id: 1, cardId: 1, date: '2026-11-02', amountCents: 1500, merchant: 'Tinynonsens', reference: null };
    expect(new DuplicateMatcher([stored]).match(row)).toBeNull();
    expect(new DuplicateMatcher([{ ...stored, rawName: 'PAYPAL *TINYNONSENS' }]).match(row)).toMatchObject({ id: 1 });
    // The near-match warning reads both too.
    const numbered = { ...stored, reference: '2', rawName: 'PAYPAL *TINYNONSENS' };
    expect(new DuplicateMatcher([numbered]).differentReference(row)).toMatchObject({ id: 1 });
  });

  it('matches one to one: two same-amount tolls against one stored toll make one duplicate', () => {
    const stored = [{ id: 1, cardId: 1, date: '2026-11-01', amountCents: 275, merchant: 'FASTRAK CSC', reference: null }];
    const m = new DuplicateMatcher(stored);
    expect(m.match({ cardId: 1, date: '2026-11-02', amountCents: 275, merchant: 'FASTRAK CSC', reference: 'R1' })?.id).toBe(1);
    expect(m.match({ cardId: 1, date: '2026-11-03', amountCents: 275, merchant: 'FASTRAK CSC', reference: 'R2' })).toBeNull();
  });

  it('gives each row the nearest stored transaction still free', () => {
    const toll = (id: number, date: string) => ({ id, cardId: 1, date, amountCents: 275, merchant: 'FASTRAK CSC' });
    const m = new DuplicateMatcher([toll(1, '2026-11-01'), toll(2, '2026-11-03')]);
    expect(m.match({ cardId: 1, date: '2026-11-03', amountCents: 275, merchant: 'FASTRAK' })?.id).toBe(2);
    expect(m.match({ cardId: 1, date: '2026-11-03', amountCents: 275, merchant: 'FASTRAK' })?.id).toBe(1);
    expect(m.match({ cardId: 1, date: '2026-11-03', amountCents: 275, merchant: 'FASTRAK' })).toBeNull();
  });

  it('stays linear with 5,000 rows of one amount and date against 5,000 stored ones', () => {
    // Matching each row against every stored one, as a plain loop would, is 12.5 million steps
    // past taken rows. Counting the work, not the time, keeps this steady on a busy machine.
    const stored = Array.from({ length: 5_000 }, (_, id) => ({ id, cardId: 1, date: '2026-01-01', amountCents: 100, merchant: 'P' }));
    const m = new DuplicateMatcher(stored);
    let matched = 0;
    for (let i = 0; i < 5_000; i++) if (m.match({ cardId: 1, date: '2026-01-01', amountCents: 100, merchant: 'P' })) matched++;
    expect(matched).toBe(5_000);
    // Each row tests the first free stored row, which matches.
    expect(m.work.tested).toBe(5_000);
    // Skipping taken rows is amortized (O(log n) a call at most), not one step per taken row.
    expect(m.work.skipped).toBeLessThan(5_000 * 4 * Math.log2(stored.length));
  });

  it('finds the stored row with the same reference number among many with others', () => {
    const stored = Array.from({ length: 1_000 }, (_, id) => ({ id, cardId: 1, date: '2026-01-01', amountCents: 100, merchant: 'TOLL', reference: `R${id}` }));
    const m = new DuplicateMatcher(stored);
    expect(m.match({ cardId: 1, date: '2026-01-02', amountCents: 100, merchant: 'TOLL', reference: 'R777' })?.id).toBe(777);
    expect(m.match({ cardId: 1, date: '2026-01-02', amountCents: 100, merchant: 'TOLL', reference: 'R777' })).toBeNull();
  });

  it('stays linear with 20,000 rows against 20,000 stored ones of one amount and date, all with different reference numbers', () => {
    // Every row is checked for a duplicate and for a near match, as the importer does. Half the
    // stored rows look like every row, half look like none.
    const stored = Array.from({ length: 20_000 }, (_, id) => ({ id, cardId: 1, date: '2026-01-01', amountCents: 100, merchant: id % 2 ? 'TOLL ROAD' : `SHOP${id}`, reference: `S${id}` }));
    const m = new DuplicateMatcher(stored);
    let duplicates = 0;
    let near = 0;
    let calls = 0;
    for (let i = 0; i < 20_000; i++) {
      const row = { cardId: 1, date: '2026-01-01', amountCents: 100, merchant: i % 2 ? 'TOLL ROAD' : `ELSEWHERE${i}`, reference: `F${i}` };
      calls++;
      if (m.match(row)) duplicates++;
      else {
        calls++;
        if (m.differentReference(row)) near++;
      }
    }
    expect(duplicates).toBe(0);
    // Warnings are one to one, so each toll row has to get past every unlike stored row ahead of
    // the next unwarned toll, and those are never used up. After SCAN_LIMIT - 1 warnings the bound
    // stops it: the price of staying linear on a bucket this odd (10,000 shops on one day at one amount).
    expect(near).toBe(SCAN_LIMIT - 1);
    // The work, not the time, so a busy machine can't fail it: no call tests more than SCAN_LIMIT
    // candidates, and skipping used rows costs O(log n) a call, amortized (path compression; about
    // 1.3 million steps here). Scanning the whole day for every row, as an earlier version did, is
    // hundreds of millions.
    expect(m.work.tested).toBeLessThanOrEqual(calls * SCAN_LIMIT);
    expect(m.work.skipped).toBeLessThan(calls * 4 * Math.log2(stored.length));
  });

  it('skips stored rows already named in a warning without spending the scan limit on them', () => {
    // One unlike row, then a long run of renumbered tolls: every toll in the file is warned about.
    const stored = [{ id: 0, cardId: 1, date: '2026-01-01', amountCents: 100, merchant: 'SHOP', reference: 'S0' }];
    for (let id = 1; id <= 5 * SCAN_LIMIT; id++) stored.push({ id, cardId: 1, date: '2026-01-01', amountCents: 100, merchant: 'TOLL ROAD', reference: `S${id}` });
    const m = new DuplicateMatcher(stored);
    const named = Array.from({ length: 5 * SCAN_LIMIT }, (_, i) => m.differentReference({ cardId: 1, date: '2026-01-01', amountCents: 100, merchant: 'TOLL ROAD', reference: `F${i}` })?.id);
    expect(named).toEqual(stored.slice(1).map((s) => s.id));
  });

  it(`tests at most ${SCAN_LIMIT} stored rows for one row`, () => {
    const unlike = Array.from({ length: SCAN_LIMIT }, (_, id) => ({ id, cardId: 1, date: '2026-01-01', amountCents: 100, merchant: `SHOP ${id}` }));
    const like = { id: 999, cardId: 1, date: '2026-01-01', amountCents: 100, merchant: 'TOLL ROAD' };
    const row = { cardId: 1, date: '2026-01-01', amountCents: 100, merchant: 'TOLL ROAD' };
    expect(new DuplicateMatcher([...unlike.slice(1), like]).match(row)?.id).toBe(999);
    expect(new DuplicateMatcher([...unlike, like]).match(row)).toBeNull();
  });
});

describe('DuplicateMatcher.differentReference', () => {
  const stored = [
    { id: 1, cardId: 1, date: '2026-11-01', amountCents: 275, merchant: 'FASTRAK CSC', reference: 'S1' },
    { id: 2, cardId: 1, date: '2026-11-04', amountCents: 275, merchant: 'FASTRAK CSC', reference: 'S2' },
  ];
  const row = { cardId: 1, date: '2026-11-02', amountCents: 275, merchant: 'FASTRAK', reference: 'F1' };

  it('finds the nearest stored row that passes every test but the reference number, without taking it for a match', () => {
    const m = new DuplicateMatcher(stored);
    expect(m.match(row)).toBeNull();
    expect(m.differentReference(row)?.id).toBe(1);
    expect(m.differentReference({ ...row, date: '2026-11-04' })?.id).toBe(2);
    // A warning, not a match: a row with the stored reference still matches it.
    expect(m.match({ ...row, reference: 'S1' })?.id).toBe(1);
  });

  it('warns one to one: a stored row named in one warning is not named in the next', () => {
    const m = new DuplicateMatcher(stored);
    expect(m.differentReference(row)?.id).toBe(1);
    expect(m.differentReference(row)?.id).toBe(2);
    expect(m.differentReference(row)).toBeNull();
    // A stored row taken by a match isn't named in a warning either.
    const n = new DuplicateMatcher(stored);
    expect(n.match({ ...row, reference: 'S1' })?.id).toBe(1);
    expect(n.differentReference(row)?.id).toBe(2);
  });

  it('needs the rest of the duplicate test to pass, and a reference number on both sides that differs', () => {
    const m = new DuplicateMatcher(stored);
    expect(m.differentReference({ ...row, amountCents: 276 })).toBeNull();
    expect(m.differentReference({ ...row, cardId: 2 })).toBeNull();
    expect(m.differentReference({ ...row, merchant: 'PARKING' })).toBeNull();
    expect(m.differentReference({ ...row, date: '2026-11-08' })).toBeNull();
    expect(m.differentReference({ ...row, reference: null })).toBeNull();
    expect(new DuplicateMatcher([{ ...stored[0]!, reference: null }]).differentReference(row)).toBeNull();
  });
});

describe('findDuplicate', () => {
  const stored: DuplicateCandidate[] = [
    { id: 1, cardId: 1, date: '2026-11-02', amountCents: 1274, merchant: 'BLUE BOTTLE COFFEE' },
    { id: 2, cardId: 1, date: '2026-11-04', amountCents: 1274, merchant: 'Blue Bottle' },
    { id: 3, cardId: 2, date: '2026-11-03', amountCents: 1274, merchant: 'BLUE BOTTLE COFFEE' },
  ];
  const row = { cardId: 1, date: '2026-11-03', amountCents: 1274, merchant: 'BLUE BOTTLE COFFEE OAKLAND' };

  it('needs the same card, the same amount, dates at most 3 days apart, and similar text', () => {
    expect(findDuplicate({ ...row, cardId: 3 }, stored)).toBeNull();
    expect(findDuplicate({ ...row, amountCents: 1275 }, stored)).toBeNull();
    expect(findDuplicate({ ...row, merchant: 'PEETS' }, stored)).toBeNull();
    expect(findDuplicate({ ...row, date: '2026-11-05' }, stored)?.id).toBe(2);
    expect(findDuplicate({ ...row, date: '2026-11-07' }, stored)?.id).toBe(2);
    expect(findDuplicate({ ...row, date: '2026-11-08' }, stored)).toBeNull();
    expect(findDuplicate({ ...row, date: '2026-10-30' }, stored)?.id).toBe(1);
    expect(findDuplicate({ ...row, date: '2026-10-29' }, stored)).toBeNull();
  });

  it('picks the nearest date when several match', () => {
    expect(findDuplicate({ ...row, date: '2026-11-02' }, stored)?.id).toBe(1);
    expect(findDuplicate({ ...row, date: '2026-11-04' }, stored)?.id).toBe(2);
  });

  it("never matches stored rows whose reference number differs from the row's; the bank says they differ", () => {
    const csv = { id: 5, cardId: 1, date: '2026-11-02', amountCents: 1274, merchant: 'BLUE BOTTLE COFFEE', reference: 'A1' };
    expect(findDuplicate({ ...row, reference: 'B2' }, [csv])).toBeNull();
    expect(findDuplicate({ ...row, reference: 'A1' }, [csv])?.id).toBe(5);
    // Without a reference on either side (a Plaid row in 6b), the full test decides.
    expect(findDuplicate({ ...row, reference: null }, [csv])?.id).toBe(5);
    expect(findDuplicate({ ...row, reference: 'B2' }, [{ ...csv, reference: null }])?.id).toBe(5);
  });

  it('matches refunds by their negative amount', () => {
    const refund = { id: 9, cardId: 1, date: '2026-11-10', amountCents: -2500, merchant: 'REI' };
    expect(findDuplicate({ cardId: 1, date: '2026-11-11', amountCents: -2500, merchant: 'REI #12' }, [refund])?.id).toBe(9);
    expect(findDuplicate({ cardId: 1, date: '2026-11-11', amountCents: 2500, merchant: 'REI #12' }, [refund])).toBeNull();
  });
});
