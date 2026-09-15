import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth';
import { verifyKey } from '../lib/api';

/**
 * The app frame: pill tab navigation, key identity, sign out.
 *
 * Three routes rather than one page is the point — it is what turns a screen into
 * a product, and all of them are real (no decorative nav items). Requests is
 * "find me that one call"; Analytics is "what has been happening"; Key is who
 * you are and who else may connect.
 */
export function Shell() {
  const { apiKey, me, signOut } = useAuth();
  // Identity survives a refresh: the key is in storage, the name is not.
  const fetched = useQuery({
    queryKey: ['me', apiKey],
    queryFn: () => verifyKey(apiKey!),
    enabled: Boolean(apiKey) && !me,
  });
  const who = me ?? fetched.data ?? null;

  return (
    <div className="shell">
      <div className="frame">
        <header className="topbar">
          <span className="brand">LLM Gateway</span>
          <nav className="tabs">
            <NavLink to="/requests">Requests</NavLink>
            <NavLink to="/analytics">Analytics</NavLink>
            <NavLink to="/keys">Key</NavLink>
          </nav>
          <div className="keytag">
            <span className="avatar">{(who?.name ?? '··').slice(0, 2).toUpperCase()}</span>
            <span>{who?.name ?? 'signed in'}</span>
          </div>
          <button className="link" onClick={signOut}>
            sign out
          </button>
        </header>
        <Outlet />
      </div>
    </div>
  );
}
