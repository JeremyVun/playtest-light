import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type Project, type Task } from '../api.ts';
import { useApp } from '../app-context.tsx';
import { Dialog } from '../components/Dialog.tsx';
import { TaskForm } from '../components/TaskForm.tsx';
import { useFetch } from '../use-fetch.ts';

export function ProjectDetail() {
  const { id = '' } = useParams();
  const { user, config, now, toast } = useApp();
  const project = useFetch<Project>(`/api/projects/${encodeURIComponent(id)}`);
  const tasks = useFetch<{ items: Task[] }>(`/api/projects/${encodeURIComponent(id)}/tasks`);
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const isAdmin = user!.role === 'admin';
  const addLabel = config.variants.includes('rename-cta') ? 'Add task' : 'New task';
  const today = now.toISOString().slice(0, 10);

  const patch = (t: Task) => tasks.setData((d) => d && { items: d.items.map((x) => (x.id === t.id ? t : x)) });

  async function toggle(t: Task) {
    try {
      patch(await api<Task>(`/api/tasks/${t.id}`, { method: 'PATCH', body: { done: !t.done } }));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not update the task', 'error');
    }
  }

  async function confirmDelete() {
    const t = deleting!;
    try {
      await api(`/api/tasks/${t.id}`, { method: 'DELETE' });
      tasks.setData((d) => d && { items: d.items.filter((x) => x.id !== t.id) });
      toast('Task deleted');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not delete the task', 'error');
    }
    setDeleting(null);
  }

  if (project.loading) return <p role="status">Loading project…</p>;
  if (project.error || !project.data)
    return (
      <div role="alert" className="error-state">
        <h1>{project.error?.status === 404 ? 'Project not found' : 'Could not load project'}</h1>
        <p>{project.error?.message}</p>
        <Link to="/projects">Back to projects</Link>
      </div>
    );
  const p = project.data;

  return (
    <>
      <p><Link to="/projects">← All projects</Link></p>
      <div className="page-head">
        <h1>{p.name}</h1>
        <button type="button" className="primary" onClick={() => setEditing('new')}>{addLabel}</button>
      </div>
      <p className="meta"><span className={`badge badge-${p.status}`}>{p.status}</span> Key {p.key}</p>
      {p.description && <p>{p.description}</p>}

      <h2>Tasks</h2>
      {tasks.loading && <p role="status">Loading tasks…</p>}
      {tasks.error && (
        <div role="alert" className="error-state">
          <p>Could not load tasks: {tasks.error.message}</p>
          <button type="button" onClick={tasks.reload}>Try again</button>
        </div>
      )}
      {!tasks.loading && !tasks.error && tasks.data && (
        tasks.data.items.length === 0 ? (
          <div className="empty">
            <p>No tasks yet.</p>
            <p>Create the first task to get this project moving.</p>
          </div>
        ) : (
          <ul className="tasks" aria-label="Tasks">
            {tasks.data.items.map((t) => (
              <li key={t.id} className={t.done ? 'task done' : 'task'}>
                <input type="checkbox" checked={t.done} onChange={() => toggle(t)} aria-label={`Mark "${t.title}" complete`} />
                <div className="task-main">
                  <span className="task-title">{t.title}</span>
                  <span className="meta">
                    Priority {t.priority}
                    {t.due && <> · Due {t.due}{!t.done && t.due < today && <strong className="overdue"> (overdue)</strong>}</>}
                    {t.estimate !== null && <> · {t.estimate} h</>}
                  </span>
                </div>
                <button type="button" onClick={() => setEditing(t)} aria-label={`Edit "${t.title}"`}>Edit</button>
                {isAdmin && <button type="button" className="danger" onClick={() => setDeleting(t)} aria-label={`Delete "${t.title}"`}>Delete</button>}
              </li>
            ))}
          </ul>
        )
      )}

      {editing && (
        <TaskForm
          projectId={p.id}
          task={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(t, created) => {
            if (created) {
              if (!config.bugs.includes('stale-list')) tasks.setData((d) => d && { items: [...d.items, t] });
            } else patch(t);
            setEditing(null);
          }}
        />
      )}
      {deleting && (
        <Dialog title="Delete task?" onClose={() => setDeleting(null)}>
          <p>"{deleting.title}" will be permanently removed.</p>
          <div className="actions">
            <button type="button" className="danger" onClick={confirmDelete}>Delete task</button>
            <button type="button" onClick={() => setDeleting(null)}>Cancel</button>
          </div>
        </Dialog>
      )}
    </>
  );
}
