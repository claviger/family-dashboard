/**
 * SYNTHETIC CSV files for the Savings importer's tests. Not real exports: the Fidelity files follow
 * the layout of its "History for Account" files (two leading blank lines, the header, quoted
 * negatives and empty cells, `Processing`, a blank line, a disclaimer, "Date downloaded"), and the
 * bank file is a generic export with a preamble, Debit and Credit columns, D/M/YYYY dates, oldest
 * first, and a footer right after the rows. All amounts, account numbers, payees, securities, and
 * the disclaimer's words are invented. Never commit a real export.
 */

export const CASH_HEADER =
  'Run Date,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date';
const BROKERAGE_HEADER =
  'Run Date,Action,Symbol,Description,Type,Exchange Quantity,Exchange Currency,Currency,Price,Quantity,Exchange Rate,Commission,Fees,Accrued Interest,Amount,Cash Balance,Settlement Date';

interface FidelityLine {
  /** MM/DD/YYYY. */
  date: string;
  action: string;
  symbol?: string;
  /** As Fidelity writes it: '1234.56', '-186.64', '0', or ''. */
  amount: string;
  /** '9139.51', '-120.50', 'Processing', or ''. */
  balance: string;
}

/** Fidelity quotes negative numbers and empty cells. */
const cell = (v: string) => (v === '' ? '""' : v.startsWith('-') ? `"${v}"` : v);

export function cashLine(l: FidelityLine): string {
  return `${l.date},${l.action},"${l.symbol ?? ''}",No Description,Cash,"",0,"","","",${cell(l.amount)},${cell(l.balance)},""`;
}

function brokerageLine(l: FidelityLine): string {
  const symbol = l.symbol ?? '';
  return `${l.date},${l.action},${cell(symbol)},${symbol === '' ? 'No Description' : 'EXAMPLE SECURITY'},Cash,0,"",USD,"","0",0,"","","",${cell(l.amount)},${cell(l.balance)},""`;
}

const TAIL = ['', '"Example disclaimer, line one, quoted because it has a comma."', 'Example disclaimer line two.', '', '"Example disclaimer line three."', '', '', 'Date downloaded 11/15/2026 06:54 pm'];

/** A Fidelity file: two blank lines, the header, the rows (newest first, as given), then the disclaimer. */
export function fidelityFile(header: string, lines: readonly string[], opts: { eol?: string; bom?: boolean } = {}): string {
  const eol = opts.eol ?? '\n';
  return `${opts.bom ? '\uFEFF' : ''}${['', '', header, ...lines, ...TAIL].join(eol)}${eol}`;
}

/**
 * A cash management account, Oct 28 to Nov 12, 2026, newest first, every balance consistent: two
 * deposits ($2,000.00), five withdrawals ($601.25, two identical the same day), interest ($1.25),
 * and a zero-amount row. Day-end balances: 7 days.
 */
export const CASH_SAMPLE: FidelityLine[] = [
  { date: '11/12/2026', action: 'DIRECT DEPOSIT EXAMPLE CORPPAYROLL (Cash)', amount: '1500.00', balance: '4200.00' },
  { date: '11/12/2026', action: 'DEBIT CARD PURCHASE EXAMPLE GYM (Cash)', amount: '-27.60', balance: '2700.00' },
  { date: '11/12/2026', action: 'DEBIT CARD PURCHASE EXAMPLE GYM (Cash)', amount: '-27.60', balance: '2727.60' },
  { date: '11/05/2026', action: 'INTEREST EARNED FDIC INSURED DEPOSIT AT EXAMPLE BANK (QXMPQ) (Cash)', symbol: 'QXMPQ', amount: '1.25', balance: '2755.20' },
  { date: '11/03/2026', action: 'TRANSFERRED FROM VS X00-000000-1 (Cash)', amount: '500.00', balance: '2753.95' },
  { date: '11/02/2026', action: 'Check Paid # 1001 (Cash)', amount: '-100.00', balance: '2253.95' },
  { date: '11/01/2026', action: 'DIRECT DEBIT EXAMPLE PAY (Cash)', amount: '-46.05', balance: '2353.95' },
  { date: '10/30/2026', action: 'TRANSFER OF ASSETS (Cash)', amount: '0', balance: '2400.00' },
  { date: '10/28/2026', action: 'TRANSFERRED TO VS X00-000000-2 PRIOR CONTRIBUTION (Cash)', amount: '-400.00', balance: '2400.00' },
];

/** A brokerage account, Nov 2 to 13, 2026: one deposit ($600.00), one withdrawal ($250.00), and six rows that aren't flows. */
const BROKERAGE_SAMPLE: FidelityLine[] = [
  { date: '11/13/2026', action: 'YOU SOLD EXAMPLE CORP (EXMP) (Margin)', symbol: 'EXMP', amount: '2313.58', balance: 'Processing' },
  { date: '11/12/2026', action: 'YOU BOUGHT EXAMPLE FUND (EXFND) (Cash)', symbol: 'EXFND', amount: '-500.00', balance: '-120.50' },
  { date: '11/10/2026', action: 'TRANSFERRED TO VS X00-000000-1 (Cash)', amount: '-250.00', balance: '379.50' },
  { date: '11/06/2026', action: 'DIVIDEND RECEIVED EXAMPLE CORP (EXMP) (Cash)', symbol: 'EXMP', amount: '12.34', balance: '629.50' },
  { date: '11/06/2026', action: 'REINVESTMENT CASH (SPAXX) (Cash)', symbol: 'SPAXX', amount: '-3.21', balance: '617.16' },
  { date: '11/04/2026', action: 'INTEREST EARNED CASH (SPAXX) (Cash)', symbol: 'SPAXX', amount: '3.21', balance: '620.37' },
  { date: '11/03/2026', action: 'ELECTRONIC FUNDS TRANSFER RECEIVED (Cash)', amount: '600.00', balance: '617.16' },
  { date: '11/02/2026', action: 'MARGIN INTEREST as of 11/02/2026 (Margin)', amount: '-2.84', balance: '17.16' },
];

export const CASH_FILE = fidelityFile(CASH_HEADER, CASH_SAMPLE.map(cashLine));
export const BROKERAGE_FILE = fidelityFile(BROKERAGE_HEADER, BROKERAGE_SAMPLE.map(brokerageLine));

/**
 * One Fidelity Action wording (synthetic, as the samples are) for each label a built-in format's
 * rules name, so the rules can't drift from what groupLabel makes of the real wordings.
 */
export const FIDELITY_RULE_ACTIONS = {
  fidelity_cash: [CASH_SAMPLE[3]!.action],
  fidelity_brokerage: [
    CASH_SAMPLE[4]!.action, CASH_SAMPLE[0]!.action, 'CHECK RECEIVED (Cash)', BROKERAGE_SAMPLE[6]!.action, BROKERAGE_SAMPLE[2]!.action, CASH_SAMPLE[6]!.action,
  ],
} as const;

const BANK_HEADER = 'Date,Description,Debit,Credit,Balance';
/**
 * A generic bank's export: a preamble, D/M/YYYY dates (some days over 12, so unambiguous), oldest
 * first, Debit and Credit columns with thousands separators, and a footer right after the rows.
 * Two deposits ($3,500.00), three withdrawals ($290.20, two identical the same day), interest
 * ($0.75). Day-end balances: 5 days.
 */
export const BANK_FILE = [
  'Example Bank account export',
  'Account,XXXX-0001',
  '',
  BANK_HEADER,
  '13/10/2026,OPENING TRANSFER FROM SAVINGS,,"1,000.00","1,000.00"',
  '15/10/2026,CARD PURCHASE EXAMPLE SHOP 1234,45.10,,954.90',
  '15/10/2026,CARD PURCHASE EXAMPLE SHOP 1234,45.10,,909.80',
  '31/10/2026,INTEREST PAID,,0.75,910.55',
  '02/11/2026,SALARY EXAMPLE EMPLOYER,,"2,500.00","3,410.55"',
  '05/11/2026,ATM WITHDRAWAL 5678,200.00,,"3,210.55"',
  'End of statement',
  '',
].join('\r\n');

export function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}
