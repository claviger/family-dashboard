import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { serverNowEstimate } from '../../freshness.js';
import { useNow } from '../../useNow.js';
import { todayIn } from '../calendar/calendarView.js';
import { Breakdown } from './Breakdown.js';
import { draftCount } from './drafts.js';
import {
  cardName, changeLine, cycleLabel, cycleOption, excludedNote, otherCurrencyLine, pendingAmount, periodNames, personName, rowLabels, totalWords,
} from './format.js';
import { bankName, cardFreshness, reconnectHref } from './plaidText.js';
import type { SpendTransaction } from '../../../shared/spend.js';
import { useMe } from '../../shell/useMe.js';
import { usePendingTransactions, useSpendCategories, useSpendOverview, useSpendPeople } from './queries.js';
import { SaveBar } from './SaveBar.js';
import { filterTransactions, searchForView, sortTransactions, spendViewFromSearch, type SortColumn, type SortDirection, type SpendView } from './spendSearch.js';
import { TransactionList, type StatusUndo } from './TransactionList.js';
import { useMediaQuery } from '../../useMediaQuery.js';
import { useCardDrafts } from './useCardDrafts.js';
import { onTrackLine } from './projection.js';

/**
 * The drill-down's overview (spec §12.12): card and cycle pickers, the cycle's total against the
 * previous one, spending by category and by person (a name filters the table), filters, and the
 * transactions. Everything that picks or filters is in the query string (spec §7). The table's
 * unsaved category and person picks are kept here, so they outlive a filter or another cycle.
 */
export function OverviewTab({ view, isAdmin }: { view: SpendView; isAdmin: boolean }) {
  const navigate = useNavigate({ from: '/$panelId' });
  const overview = useSpendOverview(view.card, view.cycle);
  const categories = useSpendCategories();
  const people = useSpendPeople();
  const clientNow = useNow(30_000);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatusText] = useState('');
  /** The status line's Undo (after Remove duplicate); any other status takes it away. */
  const [undo, setUndo] = useState<StatusUndo | null>(null);
  const setStatus = (message: string, action?: StatusUndo) => {
    setStatusText(message);
    setUndo(action ?? null);
  };
  const wide = useMediaQuery('(min-width: 768px)');
  const pending = usePendingTransactions();
  const personFilter = useRef<HTMLSelectElement>(null);
  const transactionsHeading = useRef<HTMLHeadingElement>(null);

  const saveButton = useRef<HTMLButtonElement>(null);
  const me = useMe().data!;
  const { drafts, setDrafts, onSaved, notice, setNotice } = useCardDrafts({
    userId: me.user.id,
    data: overview.data,
    placeholder: overview.isPlaceholderData,
  });
  const count = draftCount(drafts);

  // The search box keeps what's typed and writes it to the URL a moment later, without a history entry per letter.
  const [q, setQ] = useState(view.q);
  useEffect(() => setQ(view.q), [view.q]);
  // Only on `view.q`: a change to another part of the view (a new object each render) mustn't restart the wait.
  useEffect(() => {
    if (q === view.q) return;
    const timer = setTimeout(() => void navigate({ search: (prev: Record<string, unknown>) => searchForView({ ...spendViewFromSearch(prev), q }), replace: true, resetScroll: false }), 300);
    return () => clearTimeout(timer);
  }, [q, view.q, navigate]);

  // From the URL as it is when the navigation runs, so two quick changes don't undo each other.
  // `replace` for the card and cycle pickers: arrowing through one shouldn't add a history entry per option.
  const set = (patch: Partial<SpendView>, replace = false) =>
    void navigate({ search: (prev: Record<string, unknown>) => searchForView({ ...spendViewFromSearch(prev), ...patch }), replace, resetScroll: false });

  if (overview.isPending) return <p className="muted">Loading…</p>;
  if (!overview.data) return <p className="error">{overview.error?.message}</p>;
  const o = overview.data;
  const now = serverNowEstimate(o.serverNow, overview.dataUpdatedAt, clientNow);

  if (!o.card || !o.cycle) {
    return (
      <p className="muted">
        No cards to show yet.
        {isAdmin && <> <Link to="/$panelId" params={{ panelId: 'spend' }} search={{ tab: 'settings' }}>Add a card</Link></>}
      </p>
    );
  }

  const { totals } = o;
  const fresh = cardFreshness(o.updatedAt, o.bank, now);
  const period = periodNames(o.cycle, o.mode);
  // The card's currency: every total is in it, whatever the first transaction's is.
  const { currency } = totals;
  const total = totalWords(totals.totalCents, o.cycle.current, currency);
  // The same total as above, so the same exclusions; null for a past cycle (and on day 1).
  const onTrack = onTrackLine(o.cycle, todayIn(me.family.timeZone, now), totals.totalCents, currency);
  const cats = categories.data ?? [];
  const everyone = people.data ?? [];
  const filteredRows = filterTransactions(o.transactions, { ...view, q });
  // Every row the filters keep, sorted: the drill-down has the whole cycle, so this sorts all of them.
  const shown = sortTransactions(filteredRows, view.sort);
  const matches = (t: SpendTransaction) => filterTransactions([t], { ...view, q }).length === 1;
  // Named in the server's order (newest first), so a row's name ("1 of 2") doesn't change with the sort.
  const labels = rowLabels(filteredRows);
  const filtered = view.person !== null || view.category !== null || q.trim() !== '';
  const personKey = (id: number | null): 'household' | number => (id === null ? 'household' : id);

  return (
    <div className="spend-overview" aria-busy={overview.isPlaceholderData || undefined}>
      <form className="form-row chores-filters" aria-label="Card and cycle" onSubmit={(e) => e.preventDefault()}>
        <label>
          Card
          <select value={o.card.id} onChange={(e) => set({ card: Number(e.target.value), cycle: null }, true)}>
            {o.cards.map((c) => (
              <option key={c.id} value={c.id}>{cardName(c)}{c.archived ? ' (archived)' : ''}</option>
            ))}
          </select>
        </label>
        <label>
          Cycle
          <select value={o.cycle.start} onChange={(e) => set({ cycle: o.cycles.find((c) => c.start === e.target.value)?.current ? null : e.target.value }, true)}>
            {o.cycles.map((c) => (
              <option key={c.start} value={c.start}>{cycleOption(c, o.mode)}</option>
            ))}
          </select>
        </label>
      </form>
      {o.mode === 'calendar_month' && (
        <p className="notice">
          This card has no closing day yet, so spending is grouped by calendar month.
          {isAdmin && <> <Link to="/$panelId" params={{ panelId: 'spend' }} search={{ tab: 'settings' }}>Set its closing day</Link></>}
        </p>
      )}
      {overview.error && <p className="error" role="alert">{overview.error.message}</p>}

      <section aria-labelledby="spend-total-heading" className="spend-totals">
        <h3 id="spend-total-heading">{cycleLabel(o.cycle, o.mode)}</h3>
        <p className="spend-total">
          <span className="spend-total-amount">{total.amount}</span> {total.words}
        </p>
        {onTrack && <p className="spend-on-track">{onTrack}</p>}
        {changeLine(totals.totalCents, totals.previousCents, o.mode, currency) && (
          <p className="muted">{changeLine(totals.totalCents, totals.previousCents, o.mode, currency)}</p>
        )}
        {totals.pendingCents !== 0 && <p className="muted">Includes {pendingAmount(totals.pendingCents, currency)} still pending.</p>}
        {otherCurrencyLine(totals.otherCurrencyCount) && <p className="muted">{otherCurrencyLine(totals.otherCurrencyCount)}</p>}
        <p className="muted todoist-freshness">{[excludedNote(cats), `${fresh.updated}.`].filter(Boolean).join(' ')}</p>
        {fresh.stale && <p className="todoist-freshness warning">{fresh.stale}</p>}
        {fresh.reconnect && (
          <p className="todoist-freshness warning">
            {fresh.reconnect}
            {isAdmin && o.bank && <> <a href={reconnectHref(o.bank.itemId)} aria-label={`Reconnect ${bankName(o.bank)}`}>Reconnect</a></>}
          </p>
        )}
      </section>

      <div className="spend-breakdowns">
        <Breakdown
          id="spend-by-category"
          title="By category"
          period={period}
          hasPrevious={totals.previousCents !== null}
          currency={currency}
          rows={totals.byCategory.map((b) => ({ key: b.category.id, label: `${b.category.name}${b.category.archived ? ' (archived)' : ''}`, cents: b.cents, previousCents: b.previousCents }))}
          selected={view.category}
          onPick={(key) => set({ category: view.category === key ? null : key })}
        />
        <Breakdown
          id="spend-by-person"
          title="By person"
          period={period}
          hasPrevious={totals.previousCents !== null}
          currency={currency}
          rows={totals.byPerson.map((b) => ({ key: personKey(b.person?.id ?? null), label: personName(b.person), cents: b.cents, previousCents: b.previousCents }))}
          selected={view.person}
          onPick={(key) => set({ person: view.person === key ? null : key })}
        />
      </div>

      <section aria-labelledby="spend-transactions-heading" className="spend-transactions">
        <div className="spend-transactions-head">
          <h3 id="spend-transactions-heading" ref={transactionsHeading} tabIndex={-1}>Transactions</h3>
          {/* A long table's last control is far from the bar's Save: this gets there in one step. */}
          {count > 0 && (
            <button type="button" className="spend-go-to-save" onClick={() => saveButton.current?.focus()}>
              Go to Save ({count} {count === 1 ? 'change' : 'changes'})
            </button>
          )}
        </div>
        <form className="form-row chores-filters" aria-label="Filter transactions" onSubmit={(e) => e.preventDefault()}>
          <label>
            Person
            <select ref={personFilter} value={view.person === null ? '' : String(view.person)} onChange={(e) => set({ person: e.target.value === '' ? null : e.target.value === 'household' ? 'household' : Number(e.target.value) })}>
              <option value="">Everyone</option>
              <option value="household">Household</option>
              {everyone.map((p) => (
                <option key={p.id} value={p.id}>{personName(p)}</option>
              ))}
            </select>
          </label>
          <label>
            Category
            <select value={view.category === null ? '' : String(view.category)} onChange={(e) => set({ category: e.target.value === '' ? null : Number(e.target.value) })}>
              <option value="">All categories</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.archived ? ' (archived)' : ''}</option>
              ))}
            </select>
          </label>
          <label>
            Merchant
            <input type="search" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
          </label>
          {!wide && (
            // Phones show the rows as a list, with no headers to sort by.
            <label>
              Sort by
              <select value={`${view.sort.by}-${view.sort.dir}`} onChange={(e) => {
                const [by, dir] = e.target.value.split('-') as [SortColumn, SortDirection];
                set({ sort: { by, dir } }, true);
              }}>
                <option value="date-desc">Date, newest first</option>
                <option value="date-asc">Date, oldest first</option>
                <option value="name-asc">Name, A to Z</option>
                <option value="name-desc">Name, Z to A</option>
                <option value="amount-desc">Amount, largest first</option>
                <option value="amount-asc">Amount, smallest first</option>
              </select>
            </label>
          )}
          {filtered && (
            <button
              type="button"
              onClick={() => {
                setQ('');
                set({ person: null, category: null, q: '' });
                // The button goes away with the filters; focus the first filter.
                personFilter.current?.focus();
              }}
            >
              Clear filters
            </button>
          )}
        </form>
        <p className="muted todo-status" aria-live="polite">
          {filtered ? `Showing ${shown.length} of ${o.transactions.length} transactions.` : `${o.transactions.length} ${o.transactions.length === 1 ? 'transaction' : 'transactions'}.`}
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <TransactionList
          rows={shown}
          categories={cats}
          people={everyone}
          cards={o.cards}
          isAdmin={isAdmin}
          drafts={drafts}
          setDrafts={setDrafts}
          cycle={o.cycle.start}
          labels={labels}
          matches={matches}
          heading={() => transactionsHeading.current}
          sort={view.sort}
          onSort={(sort) => set({ sort })}
          onStatus={setStatus}
          onError={setError}
        />
        <div className="spend-status">
          <p role="status" className="muted todo-status">{status}</p>
          {undo && (
            <button
              type="button"
              aria-label={`Undo removing duplicate ${undo.label}`}
              aria-disabled={pending.has(undo.id)}
              onClick={() => {
                if (!pending.has(undo.id)) undo.run();
              }}
            >
              Undo
            </button>
          )}
        </div>
        {/* Why drafts went without the person doing it (fresh rows, a card no longer shown). */}
        <p className="muted todo-status" aria-live="polite">{notice}</p>
      </section>
      {/* Last in the overview, so it's held to the bottom of the screen wherever the page is scrolled. */}
      <SaveBar
        drafts={drafts}
        setDrafts={setDrafts}
        shown={shown}
        labels={labels}
        matches={matches}
        heading={() => transactionsHeading.current}
        saveButton={saveButton}
        onSaved={onSaved}
        onStatus={(message) => {
          setStatus(message);
          setNotice('');
        }}
        onError={setError}
      />
    </div>
  );
}
