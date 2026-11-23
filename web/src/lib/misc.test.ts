import { splitCitations } from './answer';
import { parseConfig } from './config';
import { parseRoute } from './router';
import { needsPolling } from '../components/DocumentsTab';

test.each([
  ['/', { name: 'projects' }],
  ['/projects/abc-1', { name: 'project', projectId: 'abc-1', tab: 'chats' }],
  ['/projects/abc-1/', { name: 'project', projectId: 'abc-1', tab: 'chats' }],
  ['/projects/abc-1/documents', { name: 'project', projectId: 'abc-1', tab: 'documents' }],
  ['/projects/abc-1/retrieval', { name: 'project', projectId: 'abc-1', tab: 'retrieval' }],
  ['/projects/abc-1/chats/c-2', { name: 'project', projectId: 'abc-1', tab: 'chats', chatId: 'c-2' }],
  ['/projects/../etc', { name: 'notFound' }],
  ['/projects/abc/unknown', { name: 'notFound' }],
])('parseRoute(%s)', (path, route) => {
  expect(parseRoute(path)).toEqual(route);
});

test('citation markers become links only when a source with that number exists', () => {
  expect(splitCitations('A [1] and [3].', new Set([1]))).toEqual([
    { kind: 'text', text: 'A ' },
    { kind: 'cite', number: 1 },
    { kind: 'text', text: ' and [3].' },
  ]);
  expect(splitCitations('[2]', new Set([2]))).toEqual([{ kind: 'cite', number: 2 }]);
});

test('config parsing: required fields, defaults, limits', () => {
  const base = { region: 'us-east-1', userPoolId: 'p', userPoolClientId: 'c' };
  expect(parseConfig(base)).toMatchObject({
    apiBasePath: '/api',
    maxFileMb: 20,
    allowedExtensions: ['pdf', 'txt', 'md', 'html', 'docx', 'csv'],
  });
  expect(parseConfig({ ...base, apiBasePath: '/api/', maxFileMb: 5, allowedExtensions: ['PDF'] })).toMatchObject({
    apiBasePath: '/api',
    maxFileMb: 5,
    allowedExtensions: ['pdf'],
  });
  expect(() => parseConfig({ region: 'us-east-1' })).toThrow('userPoolId');
  expect(() => parseConfig(null)).toThrow();
});

test('documents are polled only while something is still processing', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const doc = (status: string, minutesAgo = 1) =>
    ({ doc_id: status, filename: 'f', status, created_at: new Date(now - minutesAgo * 60000).toISOString() }) as never;
  expect(needsPolling([doc('READY'), doc('FAILED')], now)).toBe(false);
  expect(needsPolling([doc('READY'), doc('INGESTING')], now)).toBe(true);
  expect(needsPolling([doc('PENDING_UPLOAD', 2)], now)).toBe(true);
  expect(needsPolling([doc('PENDING_UPLOAD', 30)], now)).toBe(false); // an upload that never arrived
});
