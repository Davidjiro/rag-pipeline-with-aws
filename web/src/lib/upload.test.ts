import { checkFile, extensionOf, postToS3 } from './upload';

const ALLOWED = ['pdf', 'txt', 'md'];

test.each([
  ['report.PDF', 1000, null],
  ['notes.txt', 1, null],
  ['virus.exe', 10, 'not supported'],
  ['noextension', 10, 'not supported'],
  ['.pdf', 10, 'not supported'],
  ['empty.md', 0, 'empty'],
  ['big.pdf', 2 * 1024 * 1024 + 1, 'larger than 2 MB'],
])('checkFile(%s, %i bytes)', (name, size, expected) => {
  const result = checkFile({ name, size }, 2, ALLOWED);
  if (expected === null) expect(result).toBeNull();
  else expect(result).toContain(expected);
});

test('the reserved metadata name is refused even with an allowed extension', () => {
  expect(checkFile({ name: 'x.pdf.metadata.json', size: 5 }, 2, [...ALLOWED, 'json'])).toContain('reserved');
});

test('extensionOf', () => {
  expect(extensionOf('a.b.TXT')).toBe('txt');
  expect(extensionOf('README')).toBe('');
});

test('policy fields are sent first and the file last, as S3 requires', async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
  await postToS3(
    {
      url: 'https://bucket.s3.us-east-1.amazonaws.com/',
      fields: { key: 'k', policy: 'p', 'Content-Type': 'text/plain' },
    },
    new Blob(['hi']),
    fetchImpl as unknown as typeof fetch,
  );
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://bucket.s3.us-east-1.amazonaws.com/');
  expect([...(init.body as FormData).keys()]).toEqual(['key', 'policy', 'Content-Type', 'file']);
});

test('S3 rejection messages', async () => {
  const tooLarge = (async () => new Response('<Code>EntityTooLarge</Code>', { status: 400 })) as typeof fetch;
  await expect(postToS3({ url: 'u', fields: {} }, new Blob(['x']), tooLarge)).rejects.toThrow('larger than allowed');
  const denied = (async () => new Response('<Code>AccessDenied</Code>', { status: 403 })) as typeof fetch;
  await expect(postToS3({ url: 'u', fields: {} }, new Blob(['x']), denied)).rejects.toThrow('HTTP 403');
});
