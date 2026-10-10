import { useApp } from '../app-context.tsx';

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span>{t.text}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => dismissToast(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
