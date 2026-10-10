import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type Config, type User } from './api.ts';

interface Toast { id: number; text: string; kind: 'success' | 'error' }

interface AppState {
  config: Config;
  now: Date;
  user: User | null;
  setUser: (u: User | null) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
}

const Ctx = createContext<AppState | null>(null);
export const useApp = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('outside AppProvider');
  return v;
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<{ config: Config; now: Date; user: User | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  useEffect(() => {
    api<{ config: Config; now: string; user: User | null }>('/api/bootstrap')
      .then((b) => {
        setBoot({ config: b.config, now: new Date(b.now), user: b.user });
        setUser(b.user);
        const noMotion = b.config.testMode || new URLSearchParams(location.search).has('nomotion');
        document.body.classList.toggle('nomotion', noMotion);
        for (const bug of b.config.bugs) document.body.classList.add(`bug-${bug}`);
      })
      .catch(() => setFailed(true));
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((text: string, kind: Toast['kind'] = 'success') => {
    const id = nextId.current++;
    if (boot?.config.testMode) {
      setToasts([{ id, text, kind }]);
      return;
    }
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => dismissToast(id), 4000);
  }, [dismissToast, boot?.config.testMode]);

  if (failed) return <p role="alert" className="boot">Could not reach the server.</p>;
  if (!boot) return <p role="status" className="boot">Loading…</p>;
  return (
    <Ctx.Provider value={{ config: boot.config, now: boot.now, user, setUser, toast, toasts, dismissToast }}>
      {children}
    </Ctx.Provider>
  );
}
