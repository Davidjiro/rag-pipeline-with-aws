/**
 * Documents of a project: upload (picker or drag and drop), live status, delete.
 *
 * After an upload S3 starts indexing by itself; the list asks the API for fresh status every few seconds while any
 * document is still being processed, and stops when none is.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import type { ApiClient } from '../lib/api';
import type { AppConfig } from '../lib/config';
import type { DocumentItem } from '../lib/types';
import { checkFile, postToS3 } from '../lib/upload';
import { formatDate } from './format';
import { message } from './ProjectList';

const POLL_MS = 4000;
const PENDING_WATCH_MS = 15 * 60 * 1000; // an upload that never arrived stops being watched after this

const STATUS_LABEL: Record<DocumentItem['status'], string> = {
  PENDING_UPLOAD: 'Waiting for upload',
  INGESTING: 'Processing',
  READY: 'Ready',
  FAILED: 'Failed',
};

export function needsPolling(docs: DocumentItem[], now = Date.now()): boolean {
  return docs.some(
    (d) =>
      d.status === 'INGESTING' || (d.status === 'PENDING_UPLOAD' && now - Date.parse(d.created_at) < PENDING_WATCH_MS),
  );
}

export function DocumentsTab({ api, config, projectId }: { api: ApiClient; config: AppConfig; projectId: string }) {
  const [docs, setDocs] = useState<DocumentItem[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [uploading, setUploading] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const refresh = useCallback(
    () =>
      api
        .listFiles(projectId)
        .then(setDocs)
        .catch((e) => setErrors([message(e)])),
    [api, projectId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!docs || !needsPolling(docs)) return;
    const timer = window.setTimeout(() => void refresh(), POLL_MS);
    return () => window.clearTimeout(timer);
  }, [docs, refresh]);

  async function upload(files: File[]) {
    const problems: string[] = [];
    const accepted = files.filter((f) => {
      const problem = checkFile(f, config.maxFileMb, config.allowedExtensions);
      if (problem) problems.push(problem);
      return !problem;
    });
    setErrors(problems);
    for (const file of accepted) {
      setUploading((u) => [...u, file.name]);
      try {
        const ticket = await api.requestUpload(projectId, file.name);
        await postToS3(ticket.upload, file);
      } catch (e) {
        problems.push(`${file.name}: ${e instanceof Error ? e.message : 'upload failed'}`);
        setErrors([...problems]);
      } finally {
        setUploading((u) => u.filter((n) => n !== file.name));
        void refresh();
      }
    }
  }

  async function remove(doc: DocumentItem) {
    if (!window.confirm(`Delete "${doc.filename}"? It will no longer be used to answer questions.`)) return;
    try {
      await api.deleteFile(projectId, doc.doc_id);
      setDocs((list) => list?.filter((d) => d.doc_id !== doc.doc_id) ?? null);
    } catch (e) {
      setErrors([message(e)]);
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void upload(Array.from(event.dataTransfer.files));
  }

  return (
    <div className="panel">
      <div
        className={dragging ? 'dropzone dragging' : 'dropzone'}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p>Drop files here, or</p>
        <button className="primary" onClick={() => input.current?.click()}>
          Choose files
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Choose files to upload"
          accept={config.allowedExtensions.map((e) => '.' + e).join(',')}
          onChange={(e) => {
            void upload(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <p className="muted small">
          {config.allowedExtensions.map((e) => '.' + e).join(', ')} · up to {config.maxFileMb} MB each
        </p>
      </div>
      {uploading.length > 0 && <p className="muted">Uploading {uploading.join(', ')}…</p>}
      {errors.map((e) => (
        <p key={e} className="error" role="alert">
          {e}
        </p>
      ))}
      {docs === null && <p className="muted">Loading…</p>}
      {docs?.length === 0 && <p className="muted">No documents yet.</p>}
      {docs && docs.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>File</th>
              <th>Status</th>
              <th>Added</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.doc_id}>
                <td>{d.filename}</td>
                <td>
                  <span className={`badge ${d.status.toLowerCase()}`}>{STATUS_LABEL[d.status]}</span>
                  {d.warning && <div className="muted small">{d.warning}</div>}
                  {d.reason && <div className="error small">{d.reason}</div>}
                </td>
                <td className="muted small">{formatDate(d.created_at)}</td>
                <td>
                  <button className="link danger" onClick={() => void remove(d)} aria-label={`Delete ${d.filename}`}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
