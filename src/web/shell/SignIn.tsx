export function SignIn() {
  const error = new URLSearchParams(window.location.search).get('error');
  return (
    <main className="center-page">
      <h1>Family dashboard</h1>
      {error === 'expired' && <p className="error">Your sign-in took too long. Try again.</p>}
      {error === 'failed' && <p className="error">Google sign-in didn't work. Try again.</p>}
      <a className="button primary" href="/auth/google/start">Sign in with Google</a>
    </main>
  );
}
