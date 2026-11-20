import { Link, useNavigate } from '@tanstack/react-router';
import { useId } from 'react';
import { SAVINGS_MESSAGES, type MonthBreakdown, type SavingsOverview } from '../../../shared/savings.js';
import { serverNowEstimate } from '../../freshness.js';
import { useNow } from '../../useNow.js';
import { todayIn } from '../calendar/calendarView.js';
import { BalanceChart } from './BalanceChart.js';
import { accountLabel, changeLabel, dayLabel, endLine, heldLine, mixedStartLine, money, monthLabel, noFlowsNote, signedMoney } from './format.js';
import { useSavingsOverview } from './queries.js';
import { savingsViewFromSearch, searchForSavingsView } from './savingsSearch.js';

const NA = 'Not available';

/**
 * Overview (the Savings spec, "Numbers shown"): a month picker (the current month and every past
 * month with data), then a table with a row per account and the total: Start, Deposits,
 * Withdrawals, Market or Other change, and Now (End for a past month) with when it was read. An
 * account without flows shows its total change, with the spec's note. On phones the table becomes
 * labelled rows. Then, for the current month, the graph.
 */
export function OverviewTab({ month, timeZone }: { month: string | null; timeZone: string }) {
  const overview = useSavingsOverview(month);
  const navigate = useNavigate({ from: '/$panelId' });
  const clientNow = useNow(60_000);
  const pickerId = useId();
  if (overview.isPending) return <p className="muted">Loading…</p>;
  if (!overview.data) {
    return (
      <div className="savings-overview">
        <p className="error" role="alert">{overview.error?.message}</p>
        {/* A month from an old link the server refuses (before the data, or not started): the way back. */}
        {month !== null && <p><Link to="/$panelId" params={{ panelId: 'savings' }} search={{}}>Show this month</Link></p>}
      </div>
    );
  }
  const o: SavingsOverview = overview.data;
  const today = o.series.points.at(-1)?.date ?? todayIn(timeZone, serverNowEstimate(o.serverNow, overview.dataUpdatedAt, clientNow));
  const loadingOther = overview.isPlaceholderData;
  // A past month lists only the accounts with a balance in it; the current month lists every shown account, synced or not.
  const rows = o.current ? o.accounts : o.accounts.filter((a) => a.breakdown.end !== null);
  // Some accounts start from last month's end and others only this month: the total's start says so.
  const mixed = mixedStartLine(rows.map((r) => ({ name: r.account.nickname, start: r.breakdown.start })));
  // The current month is the default, so it's left out of the URL.
  const pick = (value: string) =>
    void navigate({
      search: (prev: Record<string, unknown>) => searchForSavingsView({ ...savingsViewFromSearch(prev), month: value === o.months[0] ? null : value }),
      resetScroll: false,
    });

  return (
    <div className="savings-overview" aria-busy={loadingOther || undefined}>
      {overview.error && <p className="error" role="alert">{overview.error.message}</p>}
      <div className="form-row chores-filters">
        <label>
          Month
          <select value={o.month} onChange={(e) => pick(e.target.value)}>
            {o.months.map((m, i) => <option key={m} value={m}>{i === 0 ? `${monthLabel(m)} (this month)` : monthLabel(m)}</option>)}
          </select>
        </label>
      </div>

      <section className="savings-block" aria-labelledby={`${pickerId}-heading`}>
        <h3 id={`${pickerId}-heading`}>{monthLabel(o.month)}</h3>
        {rows.length === 0 ? (
          <p className="muted">No balances for {monthLabel(o.month)}{o.current ? ' yet' : ''}.</p>
        ) : (
          <table className="savings-breakdown">
            <caption className="visually-hidden">{monthLabel(o.month)}, by account</caption>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Start</th>
                <th scope="col">Deposits</th>
                <th scope="col">Withdrawals</th>
                <th scope="col">Change</th>
                <th scope="col">{o.current ? 'Now' : 'End'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ account, breakdown }) => (
                <Row
                  key={account.id}
                  name={accountLabel(account)}
                  breakdown={breakdown}
                  overview={o}
                  change={changeLabel(account.kind)}
                  timeZone={timeZone}
                  notes={[account.connectionRemoved ? 'Connection removed' : null, noFlowsNote(account)]}
                />
              ))}
            </tbody>
            {rows.length > 1 && (
              <tfoot>
                <Row name="Total" breakdown={o.total} overview={o} change="Change" timeZone={timeZone} startNote={mixed}
                  notes={[o.total.start !== null && o.total.depositsCents === null ? 'Deposits and withdrawals aren\'t available for every account, so this is the total change.' : null]} />
              </tfoot>
            )}
          </table>
        )}
      </section>

      {o.current && <BalanceChart series={o.series} today={today} />}
    </div>
  );
}

/** `startNote` replaces the Start cell's "Since <date>" (the total's mixed start). */
function Row(props: { name: string; breakdown: MonthBreakdown; overview: SavingsOverview; change: string; timeZone: string; notes: (string | null)[]; startNote?: string | null }) {
  const b = props.breakdown;
  const flows = b.depositsCents !== null;
  const endLabel = props.overview.current ? 'Now' : 'End';
  const held = props.overview.current ? heldLine(b.end, props.overview.month) : null;
  const notes = props.notes.filter((n): n is string => n !== null);
  return (
    <tr>
      <th scope="row">
        {props.name}
        {notes.map((n) => <span key={n} className="todo-due">{n}</span>)}
      </th>
      <td data-label="Start">
        <span>
          {b.start ? money(b.start.cents) : <span className="todo-due">{NA}</span>}
          {props.startNote ? <span className="todo-due savings-start-note">{props.startNote}</span> : b.start?.sinceFirstSnapshot && <span className="todo-due">Since {dayLabel(b.start.date)}</span>}
        </span>
      </td>
      <td data-label="Deposits">{flows ? money(b.depositsCents!) : <span className="todo-due">{NA}</span>}</td>
      <td data-label="Withdrawals">{b.withdrawalsCents !== null ? money(b.withdrawalsCents) : <span className="todo-due">{NA}</span>}</td>
      <td data-label={flows ? props.change : 'Total change'}>
        <span>
          {flows ? signedMoney(b.changeCents!) : b.totalChangeCents !== null ? signedMoney(b.totalChangeCents) : <span className="todo-due">{NA}</span>}
          {b.totalChangeCents !== null && <span className="todo-due savings-wide-only">{flows ? props.change : 'Total change'}</span>}
        </span>
      </td>
      <td data-label={endLabel}>
        <span>
          {b.end ? money(b.end.cents) : <span className="todo-due">{NA}</span>}
          {b.end && <span className={b.end.source === 'plaid' ? 'todo-due' : 'todo-due savings-end-source'}>{endLine(b.end, props.timeZone)}</span>}
          {held && <span className="todo-due">{held}</span>}
        </span>
      </td>
    </tr>
  );
}
