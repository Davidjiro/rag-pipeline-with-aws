/**
 * A minimal router over the History API: three screens do not need a routing library.
 *
 *   /                                  projects
 *   /projects/<id>                     a project (chats tab)
 *   /projects/<id>/<tab>               documents | retrieval
 *   /projects/<id>/chats/<chatId>      a chat
 *
 * CloudFront returns the app for every such path (a CloudFront Function), so deep links and reloads work.
 */

import { useEffect, useState } from 'react';

export type Tab = 'chats' | 'documents' | 'retrieval';

export type Route =
  { name: 'projects' } | { name: 'project'; projectId: string; tab: Tab; chatId?: string } | { name: 'notFound' };

const ID = '([A-Za-z0-9-]{1,64})';

export function parseRoute(path: string): Route {
  const clean = path.replace(/\/+$/, '') || '/';
  if (clean === '/') return { name: 'projects' };
  let m = clean.match(new RegExp(`^/projects/${ID}$`));
  if (m) return { name: 'project', projectId: m[1]!, tab: 'chats' };
  m = clean.match(new RegExp(`^/projects/${ID}/(documents|retrieval)$`));
  if (m) return { name: 'project', projectId: m[1]!, tab: m[2] as Tab };
  m = clean.match(new RegExp(`^/projects/${ID}/chats/${ID}$`));
  if (m) return { name: 'project', projectId: m[1]!, tab: 'chats', chatId: m[2]! };
  return { name: 'notFound' };
}

export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return route;
}
