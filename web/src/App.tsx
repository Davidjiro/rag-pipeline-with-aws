/**
 * The app shell: load the configuration, restore the session, then show sign-in or the signed-in screens.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClient } from './lib/api';
import { accessToken, configureAuth, currentUser, endSession } from './lib/auth';
import { loadConfig, type AppConfig } from './lib/config';
import { navigate, useRoute } from './lib/router';
import { ProjectList } from './components/ProjectList';
import { ProjectPage } from './components/ProjectPage';
import { SignIn } from './components/SignIn';

type Session = { state: 'loading' } | { state: 'signedOut'; notice?: string } | { state: 'signedIn'; email: string };

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [session, setSession] = useState<Session>({ state: 'loading' });

  useEffect(() => {
    loadConfig()
      .then(async (loaded) => {
        configureAuth(loaded);
        setConfig(loaded);
        const email = await currentUser();
        setSession(email ? { state: 'signedIn', email } : { state: 'signedOut' });
      })
      .catch(() => setConfigError('The app could not load its configuration. Reload the page to try again.'));
  }, []);

  const signOut = useCallback(async (notice?: string) => {
    await endSession().catch(() => undefined);
    setSession({ state: 'signedOut', notice });
    navigate('/');
  }, []);

  const api = useMemo(
    () =>
      config
        ? new ApiClient(
            config.apiBasePath,
            accessToken,
            () => void signOut('Your session has ended. Please sign in again.'),
          )
        : null,
    [config, signOut],
  );

  if (configError)
    return (
      <Centered>
        <p className="error">{configError}</p>
      </Centered>
    );
  if (!config || !api || session.state === 'loading')
    return (
      <Centered>
        <p className="muted">Loading…</p>
      </Centered>
    );
  if (session.state === 'signedOut') {
    return <SignIn notice={session.notice} onSignedIn={(email) => setSession({ state: 'signedIn', email })} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <a
          href="/"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
        >
          Knowledge Chat
        </a>
        <span className="user">
          <span className="muted">{session.email}</span>
          <button className="link" onClick={() => void signOut()}>
            Sign out
          </button>
        </span>
      </header>
      <main className="content">
        <Screens api={api} config={config} />
      </main>
    </div>
  );
}

function Screens({ api, config }: { api: ApiClient; config: AppConfig }) {
  const route = useRoute();
  if (route.name === 'projects') return <ProjectList api={api} />;
  if (route.name === 'project') {
    return (
      <ProjectPage
        key={route.projectId}
        api={api}
        config={config}
        projectId={route.projectId}
        tab={route.tab}
        chatId={route.chatId}
      />
    );
  }
  return (
    <section className="panel">
      <h1>Page not found</h1>
      <button onClick={() => navigate('/')}>Back to projects</button>
    </section>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="centered">{children}</div>;
}
