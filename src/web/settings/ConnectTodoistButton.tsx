import { useEffect, useState, type Ref } from 'react';
import { useStartTodoistLink } from './queries.js';

/**
 * Connect or Reconnect Todoist. Starting a link is a POST, so the server's CSRF check covers it;
 * the answer is Todoist's consent page, which the browser then visits, and Todoist sends it back
 * to /settings.
 *
 * It stays disabled once the consent page's URL arrives, so a second press can't start a second
 * link while the browser is leaving. Pressing Back can bring this page back from the browser's
 * back-forward cache exactly as it was left, so a restored page enables it again.
 */
export function ConnectTodoistButton({ label, buttonRef }: { label: 'Connect Todoist' | 'Reconnect Todoist'; buttonRef?: Ref<HTMLButtonElement> }) {
  const [error, setError] = useState<string | null>(null);
  const start = useStartTodoistLink({ onError: (err) => setError(err.message) });
  const { reset } = start;
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) reset();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [reset]);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="primary"
        disabled={start.isPending || start.isSuccess}
        onClick={() => {
          setError(null);
          start.mutate();
        }}
      >
        {label}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
