/**
 * Read a Server-Sent Events body into JSON events.
 *
 * The browser's EventSource cannot send an Authorization header or a POST body, so the answer is read from a normal
 * fetch response. Network chunks do not respect line boundaries: a line may arrive in pieces, and one chunk may hold
 * several events. Comment lines (`: keep-alive`) and lines that are not `data: <json object>` are skipped.
 */

export async function* readEvents<T = unknown>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? '' : (lines.pop() ?? '');
      for (const line of lines) {
        const event = parseLine<T>(line);
        if (event !== undefined) yield event;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseLine<T>(line: string): T | undefined {
  if (!line.startsWith('data:')) return undefined;
  const payload = line.slice(5).trim();
  if (!payload) return undefined;
  try {
    const value: unknown = JSON.parse(payload);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}
