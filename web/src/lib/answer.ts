/** Split an answer into text and `[n]` citation markers, so markers can link to their source. */

export type Segment = { kind: 'text'; text: string } | { kind: 'cite'; number: number };

export function splitCitations(text: string, known: ReadonlySet<number>): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(/\[(\d{1,3})\]/g)) {
    const number = Number(match[1]);
    if (!known.has(number)) continue; // a number without a source stays plain text
    if (match.index > last) segments.push({ kind: 'text', text: text.slice(last, match.index) });
    segments.push({ kind: 'cite', number });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
  return segments;
}
