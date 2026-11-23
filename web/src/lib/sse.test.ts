import { parseLine, readEvents } from './sse';

function streamOf(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out: unknown[] = [];
  for await (const e of readEvents(stream)) out.push(e);
  return out;
}

test('events split across chunks, several per chunk, CRLF, comments', async () => {
  const events = await collect(
    streamOf(
      ': keep-alive\n\n',
      'data: {"type":"tok',
      'en","text":"a"}\n\ndata: {"type":"token","text":"b"}\r\n\r\n',
      'data: {"type":"done","message_id":"m"}',
    ),
  );
  expect(events).toEqual([
    { type: 'token', text: 'a' },
    { type: 'token', text: 'b' },
    { type: 'done', message_id: 'm' },
  ]);
});

test('a multi-byte character split between chunks is decoded correctly', async () => {
  const bytes = new TextEncoder().encode('data: {"type":"token","text":"é€"}\n\n');
  const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte euro sign
  const events = await collect(streamOf(bytes.slice(0, cut), bytes.slice(cut)));
  expect(events).toEqual([{ type: 'token', text: 'é€' }]);
});

test.each(['data: not json', 'data: [1,2]', 'data:', 'event: x', ': comment', ''])('ignored line %j', (line) => {
  expect(parseLine(line)).toBeUndefined();
});
