import { Link } from '@tanstack/react-router';
import { serverNowEstimate } from '../../freshness.js';
import { useMe } from '../../shell/useMe.js';
import { useNow } from '../../useNow.js';
import { todayIn } from '../calendar/calendarView.js';
import { cardName, cycleLabel, money, otherCurrencyLine, pendingAmount, personName, shortDate, totalWords } from './format.js';
import { bankName, cardFreshness, reconnectHref } from './plaidText.js';
import { onTrackLine } from './projection.js';
import { useSpendSummary } from './queries.js';

/**
 * The home card (spec §12.11): each included card's current cycle and total so far, then the last
 * 8 transactions, with a Pending label and a person tag when it isn't Household. "Updated X ago"
 * is per card, by the server's clock, and ticks. A card on a bank also warns once it's stale (12
 * hours) and says when its bank needs reconnecting, with Reconnect for admins (a full page load to
 * the Link page). A card with transactions in another currency says how many its total leaves out.
 */
export function SpendSummary() {
  const me = useMe().data!;
  const isAdmin = me.user.role === 'admin';
  const summary = useSpendSummary();
  const clientNow = useNow(30_000);

  if (summary.isPending) return <p className="muted">Loading…</p>;
  if (!summary.data) return <p className="error">{summary.error?.message}</p>;
  const { cards, recent, serverNow } = summary.data;
  const now = serverNowEstimate(serverNow, summary.dataUpdatedAt, clientNow);
  const today = todayIn(me.family.timeZone, now);

  return (
    <div className="spend-summary">
      {summary.error && <p className="error" role="alert">{summary.error.message}</p>}
      {cards.length === 0 ? (
        <p className="muted">
          No cards yet.
          {isAdmin && <> <Link to="/$panelId" params={{ panelId: 'spend' }} search={{ tab: 'settings' }}>Add a card</Link></>}
        </p>
      ) : (
        <ul className="todo-list" aria-label="Cards">
          {cards.map((c) => {
            const fresh = cardFreshness(c.updatedAt, c.bank, now);
            const onTrack = onTrackLine(c.cycle, today, c.totalCents, c.currency);
            return (
            <li key={c.id} className="todo-row spend-card-row">
              <span className="todo-main">
                <span className="todo-title">{cardName(c)}</span>
                <span className="todo-due">
                  {c.mode === 'calendar_month' ? `${cycleLabel(c.cycle, c.mode)} (no closing day set)` : cycleLabel(c.cycle, c.mode)}
                </span>
                <span className="todo-due">{fresh.updated}</span>
                {fresh.stale && <span className="todo-due warning">{fresh.stale}</span>}
                {fresh.reconnect && (
                  <span className="todo-due warning">
                    {fresh.reconnect}
                    {isAdmin && c.bank && <> <a href={reconnectHref(c.bank.itemId)} aria-label={`Reconnect ${bankName(c.bank)}`}>Reconnect</a></>}
                  </span>
                )}
                {otherCurrencyLine(c.otherCurrencyCount) && <span className="todo-due">{otherCurrencyLine(c.otherCurrencyCount)}</span>}
              </span>
              <span className="spend-amount">
                {totalWords(c.totalCents, true, c.currency).amount}
                <span className="todo-due"> {totalWords(c.totalCents, true, c.currency).words}</span>
                {c.pendingCents !== 0 && <span className="todo-due spend-pending-note">{pendingAmount(c.pendingCents, c.currency)} pending</span>}
                {onTrack && <span className="todo-due spend-on-track">{onTrack}</span>}
              </span>
            </li>
            );
          })}
        </ul>
      )}
      {recent.length > 0 && (
        <section aria-labelledby="spend-recent-heading">
          <h3 id="spend-recent-heading" className="chores-subhead">Recent</h3>
          <ul className="todo-list">
            {recent.map((t) => (
              <li key={t.id} className="todo-row">
                <span className="todo-main">
                  <span className="todo-title">{t.merchant}</span>
                  <span className="todo-meta">
                    <span className="todo-due">{shortDate(t.date)}</span>
                    {t.pending && <span className="chore-badge">Pending</span>}
                    {t.person && <span className="chore-tag">{personName(t.person)}</span>}
                  </span>
                </span>
                <span className="spend-amount">{money(t.amountCents, t.currency)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
