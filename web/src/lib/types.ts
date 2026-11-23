/** Shapes returned by the API (backend/api/app/schemas.py and routes/). */

export type DocStatus = 'PENDING_UPLOAD' | 'INGESTING' | 'READY' | 'FAILED';
export type Strategy = 'basic' | 'multi_query';

export interface Project {
  project_id: string;
  name: string;
  created_at: string;
}

export interface DocumentItem {
  doc_id: string;
  filename: string;
  status: DocStatus;
  created_at: string;
  warning?: string;
  reason?: string;
}

/** A presigned POST: the browser sends `fields` plus the file to `url`, straight to S3. */
export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

export interface UploadTicket extends DocumentItem {
  upload: PresignedPost;
  max_bytes: number;
}

export interface Chat {
  chat_id: string;
  title: string;
  strategy: Strategy;
  created_at: string;
}

/** A source of an answer. `number` is the [n] the answer text uses. `url` is a download link valid for 5 minutes. */
export interface Citation {
  number: number | null;
  key: string;
  filename: string;
  snippet: string;
  score: number | null;
  url: string;
}

export interface Message {
  message_id: string;
  role: 'user' | 'assistant';
  text: string;
  citations: Citation[];
  created_at: string;
}

/** Events of a streamed answer (backend/api/app/sse.py). */
export type AnswerEvent =
  | { type: 'token'; text: string }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'done'; message_id: string }
  | { type: 'error'; message: string };
