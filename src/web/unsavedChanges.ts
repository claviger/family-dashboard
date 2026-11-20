/**
 * Unsaved work a page holds outside the router's reach: signing out reloads the whole app, so it
 * asks here before the logout request, and clears what pages keep in sessionStorage afterwards.
 * Router navigations are asked about by each page's own blocker.
 */
export interface UnsavedGuard {
  /** The question to ask before throwing the work away, or null when there's none. */
  question: () => string | null;
  /** Throws the work away (the person agreed). */
  discard: () => void;
}

const guards = new Set<UnsavedGuard>();

export function registerUnsaved(guard: UnsavedGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

/** Asks about each page's unsaved work; true when there's none, or the person agreed to drop it. */
export function confirmDiscardUnsaved(): boolean {
  const asking = [...guards].map((g) => ({ g, q: g.question() })).filter((x) => x.q !== null);
  for (const { q } of asking) if (!window.confirm(q!)) return false;
  for (const { g } of asking) g.discard();
  return true;
}

/** Every sessionStorage key a page keeps drafts under starts with this. */
export const DRAFTS_PREFIX = 'drafts:';

/** Signing out: drafts belong to the person who made them. */
export function clearStoredDrafts(): void {
  try {
    for (const key of Object.keys(window.sessionStorage)) if (key.startsWith(DRAFTS_PREFIX)) window.sessionStorage.removeItem(key);
  } catch {
    // Storage can be unavailable (a private window, blocked site data): nothing was stored then.
  }
}

export function readStored(key: string): string | null {
  try {
    return window.sessionStorage.getItem(DRAFTS_PREFIX + key);
  } catch {
    return null;
  }
}

/** Writes `text`, or removes the key when it's null. */
export function writeStored(key: string, text: string | null): void {
  try {
    if (text === null) window.sessionStorage.removeItem(DRAFTS_PREFIX + key);
    else window.sessionStorage.setItem(DRAFTS_PREFIX + key, text);
  } catch {
    // Full or unavailable: the drafts still work, they just won't survive a reload.
  }
}
