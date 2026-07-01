import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

export function LoginScreen() {
  const { signIn, configured } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="legal-pad rounded-lg p-8 pl-16 shadow-card">
          <h1 className="font-hand text-5xl ink">TVCHub</h1>
          <p className="mb-6 font-type text-xs text-pad-inkSoft">
            Intake &amp; Sales Command Center
          </p>

          {!configured ? (
            <div className="rounded-md bg-pad-red/10 p-3 font-type text-xs text-pad-ink">
              <p className="font-bold text-pad-red">Firebase not configured</p>
              <p className="mt-1">
                Copy <code>.env.example</code> to <code>.env.local</code> and add
                your Firebase web app keys, then restart the dev server.
              </p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-3 font-type text-sm">
              <label className="block">
                <span className="field-label">Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-md border border-black/10 bg-white/80 p-2 text-pad-ink"
                  required
                />
              </label>
              <label className="block">
                <span className="field-label">Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1 w-full rounded-md border border-black/10 bg-white/80 p-2 text-pad-ink"
                  required
                />
              </label>
              {error && <p className="text-xs font-semibold text-pad-red">{error}</p>}
              <button type="submit" className="btn-primary w-full" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign In'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
