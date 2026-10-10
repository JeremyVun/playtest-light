import { NavLink, useNavigate } from 'react-router-dom';
import { api } from '../api.ts';
import { useApp } from '../app-context.tsx';
import { Toasts } from './Toasts.tsx';

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, setUser, config, now } = useApp();
  const nav = useNavigate();

  const items = [
    { to: '/projects', label: 'Projects' },
    { to: '/upgrade', label: 'Plan' },
    { to: '/settings', label: 'Settings' },
  ];
  if (config.variants.includes('reorder-nav')) items.reverse();
  if (config.bugs.includes('dead-link')) items.splice(1, 0, { to: '/reports', label: 'Reports' });

  async function signOut() {
    await api('/api/logout', { method: 'POST', body: {} });
    setUser(null);
    nav('/login');
  }

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Tracker</span>
        <nav aria-label="Main">
          <ul>
            {items.map((i) => (
              <li key={i.to}><NavLink to={i.to}>{i.label}</NavLink></li>
            ))}
          </ul>
        </nav>
        <div className="who">
          <span>{user!.name} ({user!.role})</span>
          <button type="button" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main>{children}</main>
      <footer>Server time: <time dateTime={now.toISOString()}>{now.toISOString().slice(0, 16).replace('T', ' ')} UTC</time></footer>
      {config.bugs.includes('overlap') && <button type="button" className="feedback-tab">Feedback</button>}
      <Toasts />
    </div>
  );
}
