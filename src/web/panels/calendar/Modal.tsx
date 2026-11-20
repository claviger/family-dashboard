import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A modal dialog on the native `<dialog>` element: the browser keeps focus inside it, Escape
 * closes it (as `onClose`), and the page behind it is inert. A close the browser makes itself
 * (the native `close` event, M-2) is `onClose` too, so the page never thinks a closed dialog is
 * open. On closing, focus goes back to `returnFocus` (the button that opened it), or whatever the
 * caller says. `returnFocus` may be called twice, so it should check `isConnected` and fall back.
 *
 * `locked` (a request from the dialog that can't be stopped is out) ignores Escape. Browsers let a
 * page cancel Escape only once without a click or key in between (close watchers), so a second
 * Escape closes a dialog anyway: while locked, a close the browser makes is undone by opening the
 * dialog again, and `onClose` isn't called.
 */
export function Modal({ labelledBy, onClose, returnFocus, children, className, locked = false }: {
  labelledBy: string;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null | undefined;
  children: ReactNode;
  className?: string;
  locked?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const restore = useRef(returnFocus);
  restore.current = returnFocus;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      // Focus goes back once React has removed the dialog. The page may re-render meanwhile and
      // take the target away (a refetch that drops the event), so it's checked again then, and a
      // target that's gone asks `returnFocus` once more, which falls back for itself (M-3).
      const target = restore.current?.();
      if (!target) return;
      setTimeout(() => {
        const now = target.isConnected ? target : restore.current?.();
        if (now?.isConnected) now.focus();
      }, 0);
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={['calendar-dialog', className].filter(Boolean).join(' ')}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        if (!lockedRef.current) onClose();
      }}
      onClose={() => {
        const dialog = ref.current;
        if (lockedRef.current && dialog?.isConnected) {
          if (!dialog.open) dialog.showModal();
          return;
        }
        closeRef.current();
      }}
    >
      {children}
    </dialog>
  );
}
