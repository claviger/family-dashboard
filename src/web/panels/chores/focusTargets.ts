/** Where focus goes after a chore action, for `useFocusRegistry().focusLater`. Pure, so it's unit-tested. */

type Get = (key: string) => HTMLElement | undefined;

/**
 * After completing occurrence `occurrenceId` of chore `choreId` on the home tile. The checkbox is
 * registered as `check-<choreId>` with `data-occurrence`, so a late repeating chore whose next
 * occurrence comes at once (same key, new occurrence) is told apart from the one just completed.
 * Null (keep waiting) while the checkbox is still the completed occurrence's; then that chore's
 * checkbox if it's back for its next occurrence, else the next due chore's in `after`, else
 * `fallbackKey`.
 */
export function afterComplete(get: Get, choreId: number, occurrenceId: number, after: number[], fallbackKey: string): HTMLElement | null | undefined {
  const own = get(`check-${choreId}`);
  if (own) return own.dataset.occurrence === String(occurrenceId) ? null : own;
  for (const id of after) {
    const next = get(`check-${id}`);
    if (next) return next;
  }
  return get(fallbackKey);
}

/**
 * Wraps a focus target so it resolves only once the action has settled. While it's in flight the
 * request keeps waiting, so a failed action (whose handler cancels the request) leaves focus to be
 * returned to the control that failed, instead of having already moved it.
 */
export function onceSettled(pending: () => boolean, find: () => HTMLElement | null | undefined): () => HTMLElement | null | undefined {
  return () => (pending() ? null : find());
}
