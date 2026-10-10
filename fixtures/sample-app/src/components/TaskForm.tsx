import { useState, type FormEvent } from 'react';
import { api, ApiError, type Task } from '../api.ts';
import { useApp } from '../app-context.tsx';
import { Dialog } from './Dialog.tsx';
import { Field } from './Field.tsx';

export function TaskForm({ projectId, task, onSaved, onClose }: {
  projectId: string; task?: Task; onSaved: (t: Task, created: boolean) => void; onClose: () => void;
}) {
  const { config, toast } = useApp();
  const [title, setTitle] = useState(task?.title ?? '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [priority, setPriority] = useState(task?.priority ?? 'normal');
  const [due, setDue] = useState(task?.due ?? '');
  const [estimate, setEstimate] = useState(task?.estimate?.toString() ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const withEstimate = config.variants.includes('new-field');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError('');
    const body = { title, notes, priority, due: due || null, ...(withEstimate ? { estimate } : {}) };
    try {
      const saved = task
        ? await api<Task>(`/api/tasks/${task.id}`, { method: 'PATCH', body })
        : await api<Task>(`/api/projects/${projectId}/tasks`, { method: 'POST', body });
      toast(task ? 'Task updated' : 'Task created');
      onSaved(saved, !task);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setFormError(err.status === 422 ? '' : err.message);
        if (err.status !== 422) toast('Could not save the task', 'error');
      }
      setBusy(false);
    }
  }

  return (
    <Dialog title={task ? 'Edit task' : config.variants.includes('rename-cta') ? 'Add task' : 'New task'} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Field label="Title" error={errors.title}>
          {(p) => <input {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label="Notes">
          {(p) => <textarea {...p} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
        <Field label="Priority" error={errors.priority}>
          {(p) => (
            <select {...p} value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          )}
        </Field>
        <Field label="Due date" error={errors.due}>
          {(p) => <input {...p} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}
        </Field>
        {withEstimate && (
          <Field label="Estimate in hours (optional)" error={errors.estimate}>
            {(p) => <input {...p} inputMode="decimal" value={estimate} onChange={(e) => setEstimate(e.target.value)} />}
          </Field>
        )}
        {formError && <p className="error" role="alert">{formError}</p>}
        <div className="actions">
          <button type="submit" className="primary" disabled={busy || !title.trim()}>Save task</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}
