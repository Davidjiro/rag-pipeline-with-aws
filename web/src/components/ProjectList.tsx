/** The signed-in user's projects: list, create, delete. */

import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, type ApiClient } from '../lib/api';
import { navigate } from '../lib/router';
import type { Project } from '../lib/types';
import { formatDate } from './format';

export function ProjectList({ api }: { api: ApiClient }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listProjects()
      .then(setProjects)
      .catch((e) => setError(message(e)));
  }, [api]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject(name.trim());
      navigate(`/projects/${project.project_id}/documents`);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }

  async function remove(project: Project) {
    if (!window.confirm(`Delete "${project.name}" with all its documents and chats? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.deleteProject(project.project_id);
      setProjects((list) => list?.filter((p) => p.project_id !== project.project_id) ?? null);
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <section className="panel">
      <h1>Projects</h1>
      <p className="muted">A project holds documents and the chats that answer questions from them.</p>
      <form className="row" onSubmit={create}>
        <input
          aria-label="New project name"
          placeholder="New project name"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="primary" disabled={busy || !name.trim()}>
          Create project
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {projects === null && !error && <p className="muted">Loading…</p>}
      {projects?.length === 0 && <p className="muted">No projects yet. Create one to upload documents.</p>}
      <ul className="list">
        {projects?.map((p) => (
          <li key={p.project_id} className="list-item">
            <a
              href={`/projects/${p.project_id}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(`/projects/${p.project_id}`);
              }}
            >
              {p.name}
            </a>
            <span className="muted small">{formatDate(p.created_at)}</span>
            <button className="link danger" onClick={() => void remove(p)} aria-label={`Delete project ${p.name}`}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function message(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
}
