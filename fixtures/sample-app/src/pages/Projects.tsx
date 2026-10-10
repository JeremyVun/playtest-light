import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Page, Project } from '../api.ts';
import { useApp } from '../app-context.tsx';
import { useFetch } from '../use-fetch.ts';

export function Projects() {
  const { config } = useApp();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = params.get('status') ?? 'all';
  const page = Number(params.get('page') ?? 1) || 1;

  const qs = new URLSearchParams({ q, status, page: String(page) });
  const { data, error, loading, reload } = useFetch<Page<Project>>(`/api/projects?${qs}`);

  useEffect(() => {
    if (config.bugs.includes('console-error'))
      console.error('TypeError: Cannot read properties of undefined (reading "sparkline") at ProjectCard');
  }, [config.bugs]);

  const update = (patch: Record<string, string>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v && v !== 'all' ? next.set(k, v) : next.delete(k));
    if (resetPage) next.delete('page');
    setParams(next, { replace: 'q' in patch });
  };

  return (
    <>
      <div className="page-head">
        <h1>Projects</h1>
        <Link to="/projects/new" className="button primary">New project</Link>
      </div>
      <div className="toolbar" role="search">
        <label>
          Search projects
          <input type="search" value={q} onChange={(e) => update({ q: e.target.value })} placeholder="Search by name" />
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => update({ status: e.target.value })}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="archived">Archived</option>
          </select>
        </label>
      </div>

      {loading && <p role="status">Loading projects…</p>}
      {error && (
        <div role="alert" className="error-state">
          <p>Could not load projects: {error.message}</p>
          <button type="button" onClick={reload}>Try again</button>
        </div>
      )}
      {!loading && !error && data && (
        data.items.length === 0 ? (
          <p className="empty">No projects match your search.</p>
        ) : (
          <>
            <p className="count" aria-live="polite">{data.total} projects</p>
            <ul className="cards" aria-label="Projects">
              {data.items.map((p) => (
                <li key={p.id} className="card">
                  <h2><Link to={`/projects/${p.id}`}>{p.name}</Link></h2>
                  <p className="meta"><span className={`badge badge-${p.status}`}>{p.status}</span> {p.openTasks} open of {p.totalTasks} tasks</p>
                </li>
              ))}
            </ul>
            <nav className="pager" aria-label="Pagination">
              <button type="button" disabled={data.page <= 1} onClick={() => update({ page: String(data.page - 1) }, false)}>Previous</button>
              <span>Page {data.page} of {data.pages}</span>
              <button type="button" disabled={data.page >= data.pages} onClick={() => update({ page: String(data.page + 1) }, false)}>Next</button>
            </nav>
          </>
        )
      )}
    </>
  );
}
