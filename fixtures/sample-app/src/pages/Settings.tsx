import { useState, type FormEvent } from 'react';
import { api, ApiError, type User } from '../api.ts';
import { useApp } from '../app-context.tsx';
import { Field } from '../components/Field.tsx';

export function Settings() {
  const { user, setUser, toast } = useApp();
  const [name, setName] = useState(user!.name);
  const [notifications, setNotifications] = useState(user!.notifications);
  const [digest, setDigest] = useState(user!.digest);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setUser(await api<User>('/api/settings', { method: 'PATCH', body: { name, notifications, digest } }));
      toast('Settings saved');
    } catch (err) {
      setError(err instanceof ApiError ? (err.fields.name ?? err.message) : 'Something went wrong');
      toast('Could not save settings', 'error');
    }
    setBusy(false);
  }

  return (
    <>
      <h1>Settings</h1>
      <form onSubmit={submit} noValidate className="form">
        <Field label="Display name" error={error}>
          {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <div className="field checkbox">
          <input id="notif" type="checkbox" role="switch" checked={notifications} onChange={(e) => setNotifications(e.target.checked)} />
          <label htmlFor="notif">Email notifications</label>
        </div>
        <Field label="Digest frequency">
          {(p) => (
            <select {...p} value={digest} onChange={(e) => setDigest(e.target.value)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="never">Never</option>
            </select>
          )}
        </Field>
        <div className="actions">
          <button type="submit" className="primary" disabled={busy || !name.trim()}>Save settings</button>
        </div>
      </form>
    </>
  );
}
