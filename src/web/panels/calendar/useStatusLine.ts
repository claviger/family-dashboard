import { useEffect, useState } from 'react';

/** How long a "Saved" or "Deleted" line stays (R5-M11). */
const STATUS_MS = 10_000;

/**
 * A page's status line ("Saved Swim.", "Deleted Swim."): it goes after a while, or when the
 * caller clears it with the next thing done (R5-M11).
 */
export function useStatusLine(): [string, (text: string) => void] {
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(''), STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);
  return [status, setStatus];
}
