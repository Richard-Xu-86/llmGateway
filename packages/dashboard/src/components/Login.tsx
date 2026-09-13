import { useState } from 'react';
import { ApiError, verifyKey } from '../api';

export function Login({ onSignedIn }: { onSignedIn: (key: string, name: string) => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await verifyKey(key.trim());
      onSignedIn(key.trim(), me.name);
    } catch (err) {
      // "Wrong key" and "backend is down" are different problems and deserve
      // different sentences - conflating them sends you hunting for the wrong one.
      const status = err instanceof ApiError ? err.status : null;
      setError(
        status === 401
          ? 'That key was not recognised. The dashboard wants a gateway key (gw_live_...), not your OpenAI key.'
          : 'Could not reach the backend on :4020. Is `npm run dev` still running?',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>LLM Gateway</h1>
        <p className="muted">
          Sign in with a gateway API key. You will see the traffic made with that key, and nothing
          else.
        </p>
        <input
          autoFocus
          className="mono"
          type="password"
          placeholder="gw_live_…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button type="submit" disabled={busy || key.trim().length === 0}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        {error && <p className="error">{error}</p>}
        <p className="hint muted">
          Running the defaults? Try <code>gw_live_demo_key_1</code>.
        </p>
      </form>
    </div>
  );
}
