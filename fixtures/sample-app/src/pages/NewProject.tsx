import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, type Project } from '../api.ts';
import { useApp } from '../app-context.tsx';
import { Field } from '../components/Field.tsx';

function validate(name: string, key: string) {
  const errors: Record<string, string> = {};
  if (name.trim().length < 3 || name.trim().length > 60) errors.name = 'Name must be 3 to 60 characters';
  if (!/^[A-Z]{2,5}$/.test(key)) errors.key = 'Key must be 2 to 5 capital letters';
  return errors;
}

export function NewProject() {
  const { toast } = useApp();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const errors = validate(name, key);
  const valid = Object.keys(errors).length === 0;
  const shown = (f: string) => serverErrors[f] ?? (touched[f] ? errors[f] : undefined);
  const touch = (f: string) => setTouched((t) => ({ ...t, [f]: true }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setServerErrors({});
    setFormError('');
    try {
      const p = await api<Project>('/api/projects', { method: 'POST', body: { name, key, description } });
      toast(`Project "${p.name}" created`);
      nav(`/projects/${p.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setServerErrors(err.fields);
        setFormError(err.message);
      }
      setBusy(false);
    }
  }

  return (
    <>
      <h1>New project</h1>
      <form onSubmit={submit} noValidate className="form">
        <Field label="Name" error={shown('name')}>
          {(p) => <input {...p} value={name} onChange={(e) => { setName(e.target.value); setServerErrors({}); }} onBlur={() => touch('name')} />}
        </Field>
        <Field label="Key" error={shown('key')} hint="2 to 5 capital letters, for example WEB">
          {(p) => <input {...p} value={key} onChange={(e) => { setKey(e.target.value); setServerErrors({}); }} onBlur={() => touch('key')} />}
        </Field>
        <Field label="Description (optional)">
          {(p) => <textarea {...p} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        {formError && <p className="error" role="alert">{formError}</p>}
        <div className="actions">
          <button type="submit" className="primary" disabled={!valid || busy}>Create project</button>
          <Link to="/projects" className="button">Cancel</Link>
        </div>
      </form>
    </>
  );
}
