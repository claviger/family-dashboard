import { Link } from '@tanstack/react-router';
import { SAVINGS_STALE_AFTER_MS } from '../../../shared/savings.js';
import { formatAgo, isStale, serverNowEstimate } from '../../freshness.js';
import { useMe } from '../../shell/useMe.js';
import { useNow } from '../../useNow.js';
import { reconnectHref } from '../spend/plaidText.js';
import { CardBalanceChart } from './CardBalanceChart.js';
import { accountLabel, money, signedMoney, summaryBalanceLine, updatedAsOf } from './format.js';
import { useSavingsSummary } from './queries.js';

/**
 * The home card (the Savings spec, "Home card"): each shown account's nickname, balance, and this
 * month's change, plus a brokerage's market change when its flows are known; the total; when the balances were read; a stale note when the oldest is more
 * than a day old (26 hours, plan decision 13) by the server's clock, ticking. A connection that
 * needs reconnecting says so instead of the stale note, with Reconnect for admins (a full page
 * load to the Link page, which reads the purpose from the connection and comes back to Savings).
 * A balance that didn't come from Plaid says its day and where it came from (imported, or set by
 * hand) under the account; "Updated" counts only linked accounts. Under the total, the last month's
 * graph with its deposit and withdrawal lines (CardBalanceChart), once it has two days.
 */
export function SavingsSummary() {
  const isAdmin = useMe().data!.user.role === 'admin';
  const summary = useSavingsSummary();
  const clientNow = useNow(30_000);

  if (summary.isPending) return <p className="muted">Loading…</p>;
  if (!summary.data) return <p className="error">{summary.error?.message}</p>;
  const { accounts, totalCents, totalChangeCents, stale, attention, serverNow, series } = summary.data;
  const now = serverNowEstimate(serverNow, summary.dataUpdatedAt, clientNow);
  // "Updated" and stale count linked accounts' Plaid reads only (plan decision 23).
  const oldest = updatedAsOf(accounts);
  const old = stale || isStale(oldest, now, SAVINGS_STALE_AFTER_MS);

  return (
    <div className="savings-summary">
      {summary.error && <p className="error" role="alert">{summary.error.message}</p>}
      {attention.map((a) => {
        const name = a.institutionName?.trim() || 'The savings connection';
        return (
          <p key={a.itemId} className="todo-due warning">
            {a.fix === 'remove' ? `${name} needs to be removed and connected again, so these balances aren't updating.` : `${name} needs to be reconnected, so these balances aren't updating.`}
            {isAdmin && a.fix !== 'remove' && <> <a href={reconnectHref(a.itemId)} aria-label={`Reconnect ${name}`}>Reconnect</a></>}
          </p>
        );
      })}
      {accounts.length === 0 ? (
        <p className="muted">
          No accounts yet.
          {isAdmin && <> <Link to="/$panelId" params={{ panelId: 'savings' }} search={{ tab: 'settings' }}>Connect an account</Link></>}
        </p>
      ) : (
        <>
          <ul className="todo-list" aria-label="Accounts">
            {accounts.map((a) => (
              <li key={a.account.id} className="todo-row savings-card-row">
                <span className="todo-main">
                  <span className="todo-title">{accountLabel(a.account)}</span>
                  {a.monthChangeCents !== null && <span className="todo-due savings-num">{signedMoney(a.monthChangeCents)} this month</span>}
                  {a.marketChangeCents !== null && <span className="todo-due savings-num">{signedMoney(a.marketChangeCents)} market change</span>}
                  {summaryBalanceLine(a) && <span className="todo-due">{summaryBalanceLine(a)}</span>}
                </span>
                <span className="savings-amount">{a.balanceCents === null ? <span className="todo-due">{a.account.source === 'manual' ? 'No balance yet' : 'Not synced yet'}</span> : money(a.balanceCents)}</span>
              </li>
            ))}
          </ul>
          {totalCents !== null && (
            <p className="savings-total">
              <span className="savings-total-label">
                Total
                {totalChangeCents !== null && <span className="todo-due savings-num">{signedMoney(totalChangeCents)} this month</span>}
              </span>
              <span className="savings-total-amount">{money(totalCents)}</span>
            </p>
          )}
          <CardBalanceChart series={series} />
          {oldest && <p className="todo-due">Updated {formatAgo(oldest, now)}</p>}
          {old && attention.length === 0 && <p className="todo-due warning">These balances are more than a day old, so they may be out of date.</p>}
        </>
      )}
    </div>
  );
}
