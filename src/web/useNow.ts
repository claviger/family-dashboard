import { useEffect, useState } from 'react';

/**
 * This device's clock, read again every `intervalMs`, so text like "updated 5 minutes ago" and the
 * stale warning keep up on a page that stays open (the home screen on a wall tablet, say).
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
