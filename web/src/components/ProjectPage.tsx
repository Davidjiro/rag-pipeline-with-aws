/** One project: tabs for chats, documents and test retrieval. */

import { useEffect, useState } from 'react';
import type { ApiClient } from '../lib/api';
import type { AppConfig } from '../lib/config';
import { navigate, type Tab } from '../lib/router';
import type { Project } from '../lib/types';
import { ChatsTab } from './ChatsTab';
import { DocumentsTab } from './DocumentsTab';
import { message } from './ProjectList';
import { RetrievalTab } from './RetrievalTab';

const TABS: { id: Tab; label: string; path: string }[] = [
  { id: 'chats', label: 'Chats', path: '' },
  { id: 'documents', label: 'Documents', path: '/documents' },
  { id: 'retrieval', label: 'Test retrieval', path: '/retrieval' },
];

interface Props {
  api: ApiClient;
  config: AppConfig;
  projectId: string;
  tab: Tab;
  chatId?: string;
}

export function ProjectPage({ api, config, projectId, tab, chatId }: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getProject(projectId)
      .then(setProject)
      .catch((e) => setError(message(e)));
  }, [api, projectId]);

  if (error) {
    return (
      <section className="panel">
        <p className="error" role="alert">
          {error}
        </p>
        <button onClick={() => navigate('/')}>Back to projects</button>
      </section>
    );
  }
  if (!project) return <p className="muted">Loading…</p>;

  const base = `/projects/${projectId}`;
  return (
    <section>
      <nav className="crumbs">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
        >
          Projects
        </a>{' '}
        / <strong>{project.name}</strong>
      </nav>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'tab active' : 'tab'}
            onClick={() => navigate(base + t.path)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'chats' && <ChatsTab api={api} projectId={projectId} chatId={chatId} />}
      {tab === 'documents' && <DocumentsTab api={api} config={config} projectId={projectId} />}
      {tab === 'retrieval' && <RetrievalTab api={api} projectId={projectId} />}
    </section>
  );
}
