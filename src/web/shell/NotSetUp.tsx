export function NotSetUp() {
  const reason = new URLSearchParams(window.location.search).get('reason');
  const message =
    reason === 'unverified'
      ? "Your Google account's email isn't verified."
      : reason === 'account_mismatch'
        ? 'That email is already linked to a different Google account. Ask your admin.'
        : "You're not set up yet. Ask your admin.";
  return (
    <main className="center-page">
      <h1>Family dashboard</h1>
      <p>{message}</p>
      <a className="button" href="/auth/google/start">Try a different account</a>
    </main>
  );
}
