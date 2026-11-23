/** Test retrieval: which passages the knowledge base returns for a query, with scores. No model call, no daily cap. */

import { useState, type FormEvent } from 'react';
import type { ApiClient } from '../lib/api';
import type { Citation } from '../lib/types';
import { formatScore } from './format';
import { message } from './ProjectList';

export function RetrievalTab({ api, projectId }: { api: ApiClient; projectId: string }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Citation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await api.retrieve(projectId, query.trim()));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <p className="muted">
        See which passages your documents return for a query, and how closely they match. This does not ask the model.
      </p>
      <form className="row" onSubmit={search}>
        <input
          aria-label="Search query"
          placeholder="Search your documents"
          maxLength={2000}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="primary" disabled={busy || !query.trim()}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {results?.length === 0 && <p className="muted">No passages found. Check that your documents are ready.</p>}
      <ol className="results">
        {results?.map((r, i) => (
          <li key={`${r.key}-${i}`}>
            <div className="result-head">
              <a href={r.url} target="_blank" rel="noopener noreferrer">
                {r.filename}
              </a>
              <span className="muted small">score {formatScore(r.score)}</span>
            </div>
            <blockquote className="snippet">{r.snippet}</blockquote>
          </li>
        ))}
      </ol>
    </div>
  );
}
