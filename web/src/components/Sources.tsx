/** An answer with clickable [n] markers, and the list of sources it cites. */

import type { Citation } from '../lib/types';
import { splitCitations } from '../lib/answer';

export function AnswerText({ text, citations, anchor }: { text: string; citations: Citation[]; anchor: string }) {
  const numbers = new Set(citations.map((c) => c.number).filter((n): n is number => n !== null));
  return (
    <p className="answer">
      {splitCitations(text, numbers).map((part, i) =>
        part.kind === 'text' ? (
          <span key={i}>{part.text}</span>
        ) : (
          <a key={i} className="cite" href={`#${anchor}-${part.number}`} aria-label={`Source ${part.number}`}>
            [{part.number}]
          </a>
        ),
      )}
    </p>
  );
}

export function SourceList({ citations, anchor }: { citations: Citation[]; anchor: string }) {
  if (!citations.length) return null;
  return (
    <ol className="sources" aria-label="Sources">
      {citations.map((c) => (
        <li key={c.key} id={`${anchor}-${c.number ?? ''}`} value={c.number ?? undefined}>
          {/* Download links are valid for 5 minutes; reopening the chat creates fresh ones. */}
          <a href={c.url} target="_blank" rel="noopener noreferrer">
            {c.filename}
          </a>
          {c.snippet && <blockquote className="snippet">{c.snippet}</blockquote>}
        </li>
      ))}
    </ol>
  );
}
