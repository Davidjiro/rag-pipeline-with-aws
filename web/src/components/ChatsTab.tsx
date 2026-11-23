/** The chats of a project: a list with "new chat", and the open chat. */

import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../lib/api';
import { navigate } from '../lib/router';
import type { Chat, Strategy } from '../lib/types';
import { ChatView } from './ChatView';
import { message } from './ProjectList';

export function ChatsTab({ api, projectId, chatId }: { api: ApiClient; projectId: string; chatId?: string }) {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [strategy, setStrategy] = useState<Strategy>('basic');
  const [error, setError] = useState<string | null>(null);
  const base = `/projects/${projectId}`;

  const refresh = useCallback(
    () =>
      api
        .listChats(projectId)
        .then(setChats)
        .catch((e) => setError(message(e))),
    [api, projectId],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create() {
    setError(null);
    try {
      const chat = await api.createChat(projectId, strategy);
      setChats((list) => [chat, ...(list ?? [])]);
      navigate(`${base}/chats/${chat.chat_id}`);
    } catch (e) {
      setError(message(e));
    }
  }

  async function remove(chat: Chat) {
    if (!window.confirm(`Delete the chat "${chat.title}"?`)) return;
    try {
      await api.deleteChat(projectId, chat.chat_id);
      setChats((list) => list?.filter((c) => c.chat_id !== chat.chat_id) ?? null);
      if (chat.chat_id === chatId) navigate(base);
    } catch (e) {
      setError(message(e));
    }
  }

  const open = chats?.find((c) => c.chat_id === chatId);
  return (
    <div className="chats">
      <aside className="panel chat-list">
        <div className="new-chat">
          <label className="small">
            Search
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as Strategy)}
              aria-label="Search strategy"
            >
              <option value="basic">Basic</option>
              <option value="multi_query">Multi-query (broader, slower)</option>
            </select>
          </label>
          <button className="primary" onClick={() => void create()}>
            New chat
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {chats?.length === 0 && <p className="muted small">No chats yet.</p>}
        <ul className="list">
          {chats?.map((c) => (
            <li key={c.chat_id} className={c.chat_id === chatId ? 'list-item selected' : 'list-item'}>
              <a
                href={`${base}/chats/${c.chat_id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`${base}/chats/${c.chat_id}`);
                }}
              >
                {c.title}
              </a>
              <button
                className="link danger small"
                onClick={() => void remove(c)}
                aria-label={`Delete chat ${c.title}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="chat-main">
        {chatId && chats && !open && <p className="error">Chat not found.</p>}
        {open ? (
          <ChatView key={open.chat_id} api={api} projectId={projectId} chat={open} onAnswered={() => void refresh()} />
        ) : (
          !chatId && (
            <p className="muted panel">
              Start a new chat, or open one from the list. Answers come only from this project's documents.
            </p>
          )
        )}
      </div>
    </div>
  );
}
