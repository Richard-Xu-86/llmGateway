import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { ApiError, verifyKey } from '../lib/api';

export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await verifyKey(key.trim());
      signIn(key.trim(), me);
      navigate((location.state as { from?: string } | null)?.from ?? '/requests', { replace: true });
    } catch (err) {
      // "Wrong key" and "backend is down" are different problems and deserve
      // different sentences — conflating them sends you after the wrong one.
      const status = err instanceof ApiError ? err.status : null;
      setError(
        status === 401
          ? 'That key was not recognised. The dashboard wants a gateway key (gw_live_…), not your OpenAI key.'
          : 'Could not reach the backend on :4020. Is `npm run dev` still running?',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>LLM Gateway</h1>
        <p>
          Sign in with a gateway API key. You will see the traffic made with that key, and nothing
          else.
        </p>
        <input
          autoFocus
          className="field"
          type="password"
          placeholder="gw_live_…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button className="primary" type="submit" disabled={busy || key.trim().length === 0}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        {error && <p className="bad small">{error}</p>}
        <p className="small">
          Running the defaults? Try <code>gw_live_demo_key_1</code>.
        </p>
      </form>
    </div>
  );
}
