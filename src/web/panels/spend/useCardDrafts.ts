import { useBlocker } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SpendOverview, SpendTransaction } from '../../../shared/spend.js';
import { readStored, registerUnsaved, writeStored } from '../../unsavedChanges.js';
import {
  cardGoneMessage, discardQuestion, draftCount, draftsKey, keepsDrafts, matchedMessage, NO_DRAFTS, parseDrafts, pruneMissing, removedMessage,
  serializeDrafts, settleDrafts, STILL_SAVING_QUESTION, type Drafts,
} from './drafts.js';
import { useIsSavingTransactions } from './queries.js';

const fieldsIn = (drafts: Drafts, id: number) => draftCount(new Map([...drafts].filter(([k]) => k === id)));

/**
 * The drill-down's unsaved picks (spec §12.12), for the card they were made on. Another cycle, a
 * filter, or a search keeps them (hidden rows' drafts still count and are still saved).
 *
 * - **Reloads:** they're mirrored to sessionStorage by person and card (ids and picks only), and
 *   restored when the card opens, against its fresh rows. Saving, discarding, agreeing to leave,
 *   and signing out clear them.
 * - **Fresh rows** (a refetch, a rule): a draft that now holds the saved value goes, a field someone
 *   else has changed is flagged, and a draft for a row that's gone from the cycle it was picked in
 *   goes. `notice` says why, unless the person's own Save did it.
 * - **Leaving** the card's overview asks first: another card, Spend settings, another page (the
 *   router's blocker), signing out (`registerUnsaved`), or closing or reloading the tab (the
 *   browser's own prompt). A card the server fell back from (excluded meanwhile) drops its drafts,
 *   and `notice` says so.
 */
export function useCardDrafts(opts: { userId: number; data: SpendOverview | undefined; placeholder: boolean }) {
  const { userId, data } = opts;
  const cardId = data?.card?.id ?? null;
  const [state, setState] = useState<{ card: number | null; drafts: Drafts }>({ card: null, drafts: NO_DRAFTS });
  const [notice, setNotice] = useState('');
  const drafts = cardId !== null && state.card === cardId ? state.drafts : NO_DRAFTS;
  /** The rows the person's own last Save returned: settling those needs no notice. */
  const justSaved = useRef<ReadonlySet<number>>(new Set());

  const setDrafts = useCallback(
    (update: (d: Drafts) => Drafts) =>
      setState((s) => {
        const base = s.card === cardId ? s.drafts : NO_DRAFTS;
        const next = update(base);
        return next === base && s.card === cardId ? s : { card: cardId, drafts: next };
      }),
    [cardId],
  );

  // A card opens (first load, an agreed switch, or the server falling back): restore its stored
  // drafts against its rows. Drafts left on another card without agreeing mean it fell back.
  useEffect(() => {
    if (cardId === null || !data?.cycle || state.card === cardId) return;
    const left = state.card === null ? 0 : draftCount(state.drafts);
    if (left > 0) {
      writeStored(draftsKey(userId, state.card!), null);
      setNotice(cardGoneMessage(left));
    }
    const restored = pruneMissing(settleDrafts(parseDrafts(readStored(draftsKey(userId, cardId))), data.transactions), data.cycle.start, data.transactions);
    setState({ card: cardId, drafts: restored });
  }, [cardId, data, state, userId]);

  // Mirror them, once they're this card's (an empty set removes the key).
  useEffect(() => {
    if (cardId !== null && state.card === cardId) writeStored(draftsKey(userId, cardId), state.drafts.size === 0 ? null : serializeDrafts(state.drafts));
  }, [cardId, state, userId]);

  // Fresh rows from the server: settle, flag, and drop drafts for rows that are gone, saying why.
  const fresh = data && !opts.placeholder ? data : null;
  useEffect(() => {
    if (!fresh?.cycle || cardId === null || fresh.card?.id !== cardId || state.card !== cardId) return;
    const current = state.drafts;
    const settled = settleDrafts(current, fresh.transactions);
    const pruned = pruneMissing(settled, fresh.cycle.start, fresh.transactions);
    if (pruned === current) return;
    let matched = 0;
    for (const id of current.keys()) if (!justSaved.current.has(id)) matched += fieldsIn(current, id) - fieldsIn(settled, id);
    const missing = draftCount(settled) - draftCount(pruned);
    setState((s) => (s.drafts === current ? { card: cardId, drafts: pruned } : s));
    const why = [matched > 0 ? matchedMessage(matched) : '', missing > 0 ? removedMessage(missing) : ''].filter(Boolean).join(' ');
    if (why) setNotice(why);
  }, [fresh, cardId, state]);

  /** The person's Save went through: its rows settle quietly. */
  const onSaved = useCallback(
    (saved: SpendTransaction[]) => {
      justSaved.current = new Set(saved.map((t) => t.id));
      setDrafts((d) => settleDrafts(d, saved, true));
    },
    [setDrafts],
  );

  const saving = useIsSavingTransactions();
  const shownCards = data?.cards ?? [];
  const unsaved = useRef({ count: 0, saving: false, card: null as number | null, defaultCard: null as number | null, shownCards: [] as number[] });
  unsaved.current = {
    count: draftCount(drafts),
    saving,
    card: cardId,
    defaultCard: shownCards.find((c) => !c.archived)?.id ?? shownCards[0]?.id ?? null,
    shownCards: shownCards.map((c) => c.id),
  };

  const question = useCallback((): string | null => {
    const u = unsaved.current;
    if (u.count === 0) return null;
    return u.saving ? STILL_SAVING_QUESTION : discardQuestion(u.count);
  }, []);

  /** The person agreed to leave: drop the drafts now, so the page doesn't ask again on its way out. */
  const discardAll = useCallback(() => {
    const card = unsaved.current.card;
    unsaved.current.count = 0;
    if (card !== null) writeStored(draftsKey(userId, card), null);
    setState({ card: null, drafts: NO_DRAFTS });
  }, [userId]);

  const shouldBlockFn = useCallback(
    ({ next }: { next: { pathname: string; search: Record<string, unknown> } }) => {
      const u = unsaved.current;
      if (u.count === 0 || u.card === null || keepsDrafts(next, u.card, u.defaultCard, u.shownCards)) return false;
      if (!window.confirm(question()!)) return true;
      discardAll();
      return false;
    },
    [question, discardAll],
  );
  const enableBeforeUnload = useCallback(() => unsaved.current.count > 0, []);
  useBlocker({ shouldBlockFn, enableBeforeUnload });
  useEffect(() => registerUnsaved({ question, discard: discardAll }), [question, discardAll]);

  return { drafts, setDrafts, onSaved, notice, setNotice };
}
