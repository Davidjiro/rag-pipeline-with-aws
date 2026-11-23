/**
 * One chat: its messages, and a box to ask the next question. The answer is shown as it streams in.
 *
 * The API saves a question and its answer only when the answer completes, so after an error nothing was saved and the
 * question stays in the box to send again.
 */

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ApiClient } from '../lib/api';
import type { Chat, Citation, Message } from '../lib/types';
import { message } from './ProjectList';
import { AnswerText, SourceList } from './Sources';

const MAX_QUESTION = 2000;

/** The answer failed; its message comes from the API and is safe to show. */
class AnswerError extends Error {}

interface Pending {
  question: string;
  answer: string;
  citations: Citation[];
}

export function ChatView({
  api,
  projectId,
  chat,
  onAnswered,
}: {
  api: ApiClient;
  projectId: string;
  chat: Chat;
  onAnswered: () => void;
}) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .listMessages(projectId, chat.chat_id)
      .then(setMessages)
      .catch((e) => setError(message(e)));
    return () => abort.current?.abort();
  }, [api, projectId, chat.chat_id]);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, pending]);

  async function ask(event?: FormEvent) {
    event?.preventDefault();
    const text = question.trim();
    if (!text || pending) return;
    setError(null);
    setQuestion('');
    const controller = new AbortController();
    abort.current = controller;
    let current: Pending = { question: text, answer: '', citations: [] };
    setPending(current);
    try {
      for await (const ev of api.ask(projectId, chat.chat_id, text, controller.signal)) {
        if (ev.type === 'token') current = { ...current, answer: current.answer + ev.text };
        else if (ev.type === 'citations') current = { ...current, citations: ev.citations };
        else if (ev.type === 'error') throw new AnswerError(ev.message);
        else if (ev.type === 'done') {
          const now = new Date().toISOString();
          const done = current;
          setMessages((list) => [
            ...(list ?? []),
            { message_id: `${ev.message_id}-q`, role: 'user', text: done.question, citations: [], created_at: now },
            {
              message_id: ev.message_id,
              role: 'assistant',
              text: done.answer,
              citations: done.citations,
              created_at: now,
            },
          ]);
          onAnswered();
        }
        setPending(current);
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof AnswerError ? e.message : message(e));
      setQuestion(text);
    } finally {
      setPending(null);
      abort.current = null;
    }
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void ask();
    }
  }

  return (
    <div className="panel chat">
      <div className="chat-head">
        <h2>{chat.title}</h2>
        <span className="muted small">{chat.strategy === 'multi_query' ? 'Multi-query search' : 'Basic search'}</span>
      </div>
      <div className="messages" aria-live="polite">
        {messages === null && !error && <p className="muted">Loading…</p>}
        {messages?.length === 0 && !pending && <p className="muted">Ask a question about this project's documents.</p>}
        {messages?.map((m) => (
          <MessageView key={m.message_id} message={m} />
        ))}
        {pending && (
          <>
            <div className="message user">
              <p>{pending.question}</p>
            </div>
            <div className="message assistant">
              {pending.answer ? (
                <AnswerText text={pending.answer} citations={pending.citations} anchor="pending" />
              ) : (
                <p className="muted">Searching your documents…</p>
              )}
              <SourceList citations={pending.citations} anchor="pending" />
            </div>
          </>
        )}
        <div ref={bottom} />
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form className="ask" onSubmit={ask}>
        <textarea
          aria-label="Your question"
          placeholder="Ask a question (Enter to send, Shift+Enter for a new line)"
          rows={2}
          maxLength={MAX_QUESTION}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKey}
          disabled={pending !== null}
        />
        <button type="submit" className="primary" disabled={pending !== null || !question.trim()}>
          {pending ? 'Answering…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

function MessageView({ message: m }: { message: Message }) {
  if (m.role === 'user')
    return (
      <div className="message user">
        <p>{m.text}</p>
      </div>
    );
  return (
    <div className="message assistant">
      <AnswerText text={m.text} citations={m.citations} anchor={m.message_id} />
      <SourceList citations={m.citations} anchor={m.message_id} />
    </div>
  );
}
