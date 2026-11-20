import { useEffect, useRef } from 'react';

type Find = () => HTMLElement | null | undefined;

/**
 * Focus management for lists that change under the user (phase 2's drill-down pattern). Elements
 * register by key with `reg(key)`; `focusLater(find)` keeps calling `find` after each render until
 * it returns an element that isn't disabled (controls are disabled while their request is in
 * flight, and a disabled element can't take focus), then focuses it once.
 *
 * A request only takes focus from the control it was made from (`from`, by default whatever had
 * focus when it was made), or from nothing (the page body, as when that control went away). If
 * the person has moved focus somewhere else meanwhile, the request is dropped, so a slow save
 * never pulls them back (review S3-M2).
 */
export function useFocusRegistry() {
  const els = useRef(new Map<string, HTMLElement>());
  const request = useRef<{ find: Find; from: Element | null } | null>(null);
  useEffect(() => {
    const r = request.current;
    if (!r) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== r.from) {
      request.current = null;
      return;
    }
    const target = r.find();
    if (target && !target.matches(':disabled')) {
      request.current = null;
      target.focus();
    }
  });
  return {
    reg(key: string) {
      return (el: HTMLElement | null) => {
        if (!el) return;
        els.current.set(key, el);
        return () => {
          if (els.current.get(key) === el) els.current.delete(key);
        };
      };
    },
    get: (key: string) => els.current.get(key),
    focusLater(find: Find, from: Element | null = document.activeElement) {
      request.current = { find, from };
    },
    /** Drops a pending request, e.g. when the change it waited for failed. */
    cancel() {
      request.current = null;
    },
  };
}
