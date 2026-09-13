import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { clearKey, loadKey, saveKey, type Me } from './lib/api';

interface AuthValue {
  apiKey: string | null;
  me: Me | null;
  signIn: (key: string, me: Me) => void;
  signOut: () => void;
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [apiKey, setApiKey] = useState<string | null>(loadKey);
  const [me, setMe] = useState<Me | null>(null);

  const value = useMemo<AuthValue>(
    () => ({
      apiKey,
      me,
      signIn: (key, who) => {
        saveKey(key);
        setApiKey(key);
        setMe(who);
      },
      signOut: () => {
        clearKey();
        setApiKey(null);
        setMe(null);
      },
    }),
    [apiKey, me],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAuth outside AuthProvider');
  return value;
}

/** Signed-in routes; remembers where you were headed so sign-in returns you there. */
export function RequireKey({ children }: { children: ReactNode }) {
  const { apiKey } = useAuth();
  const location = useLocation();
  if (!apiKey) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}
