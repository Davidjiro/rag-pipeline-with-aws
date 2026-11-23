/**
 * The API client. Every call carries the user's Cognito access token; the API checks it and the project's owner.
 *
 * Errors become an `ApiError` with a message fit to show the user. Server details are never shown for 5xx errors.
 */

import { readEvents } from './sse';
import type { AnswerEvent, Chat, Citation, DocumentItem, Message, Project, Strategy, UploadTicket } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type TokenProvider = () => Promise<string | null>;

/** A user-facing message for an HTTP error. `detail` is the API's own message (FastAPI's `{"detail": ...}`). */
export function errorMessage(status: number, detail: unknown): string {
  const text = typeof detail === 'string' ? detail : null;
  switch (status) {
    case 0:
      return 'Network error. Check your connection and try again.';
    case 401:
      return 'Your session has ended. Please sign in again.';
    case 404:
      return 'Not found. It may have been deleted.';
    case 409:
    case 429:
      return text ?? (status === 429 ? 'Daily question limit reached. Try again tomorrow.' : 'Limit reached.');
    case 422:
      // Pydantic validation errors are a list; our own checks are a string.
      return text ?? 'Some of the input is not valid.';
    case 502:
    case 503:
      return 'The service is temporarily unavailable. Please try again.';
    default:
      return status >= 500
        ? 'Something went wrong on our side. Please try again.'
        : (text ?? `Request failed (${status}).`);
  }
}

async function detailOf(response: Response): Promise<unknown> {
  try {
    return ((await response.json()) as { detail?: unknown }).detail;
  } catch {
    return undefined;
  }
}

export class ApiClient {
  constructor(
    private readonly base: string,
    private readonly token: TokenProvider,
    /** Called once when the API rejects the token, so the app can return to the sign-in screen. */
    private readonly onUnauthorized: () => void = () => undefined,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.token();
    if (!token) {
      this.onUnauthorized();
      throw new ApiError(401, errorMessage(401, undefined));
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, { ...init, headers });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(0, errorMessage(0, undefined));
    }
    if (!response.ok) {
      if (response.status === 401) this.onUnauthorized();
      throw new ApiError(response.status, errorMessage(response.status, await detailOf(response)));
    }
    return response;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.send(path, init)).json()) as T;
  }

  private async remove(path: string): Promise<void> {
    await this.send(path, { method: 'DELETE' });
  }

  listProjects = () => this.json<Project[]>('/projects');
  createProject = (name: string) => this.json<Project>('/projects', { method: 'POST', body: JSON.stringify({ name }) });
  getProject = (id: string) => this.json<Project>(`/projects/${encodeURIComponent(id)}`);
  deleteProject = (id: string) => this.remove(`/projects/${encodeURIComponent(id)}`);

  listFiles = (pid: string) => this.json<DocumentItem[]>(`/projects/${encodeURIComponent(pid)}/files`);
  requestUpload = (pid: string, filename: string) =>
    this.json<UploadTicket>(`/projects/${encodeURIComponent(pid)}/files`, {
      method: 'POST',
      body: JSON.stringify({ filename }),
    });
  deleteFile = (pid: string, docId: string) =>
    this.remove(`/projects/${encodeURIComponent(pid)}/files/${encodeURIComponent(docId)}`);

  listChats = (pid: string) => this.json<Chat[]>(`/projects/${encodeURIComponent(pid)}/chats`);
  createChat = (pid: string, strategy: Strategy) =>
    this.json<Chat>(`/projects/${encodeURIComponent(pid)}/chats`, {
      method: 'POST',
      body: JSON.stringify({ strategy }),
    });
  deleteChat = (pid: string, cid: string) =>
    this.remove(`/projects/${encodeURIComponent(pid)}/chats/${encodeURIComponent(cid)}`);
  listMessages = (pid: string, cid: string) =>
    this.json<Message[]>(`/projects/${encodeURIComponent(pid)}/chats/${encodeURIComponent(cid)}/messages`);

  retrieve = (pid: string, query: string) =>
    this.json<Citation[]>(`/projects/${encodeURIComponent(pid)}/retrieve`, {
      method: 'POST',
      body: JSON.stringify({ query }),
    });

  /** Ask a question; yields the answer's events as they arrive. Abort with `signal` to stop reading. */
  async *ask(pid: string, cid: string, text: string, signal?: AbortSignal): AsyncGenerator<AnswerEvent> {
    const response = await this.send(`/projects/${encodeURIComponent(pid)}/chats/${encodeURIComponent(cid)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
      signal,
    });
    if (!response.body) throw new ApiError(0, errorMessage(0, undefined));
    let finished = false;
    for await (const event of readEvents<AnswerEvent>(response.body)) {
      if (event.type === 'done' || event.type === 'error') finished = true;
      yield event;
    }
    // The stream closed without saying it was done: the connection dropped. The API saved nothing.
    if (!finished) yield { type: 'error', message: 'The connection was interrupted. Please ask again.' };
  }
}
