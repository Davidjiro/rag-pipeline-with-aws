import { ApiClient, ApiError, errorMessage } from './api';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function client(fetchImpl: typeof fetch, token: string | null = 'tok', onUnauthorized = vi.fn()) {
  return { api: new ApiClient('/api', async () => token, onUnauthorized, fetchImpl), onUnauthorized };
}

test('sends the bearer token and JSON body to the right path', async () => {
  const fetchImpl = vi.fn(async () => json(201, { project_id: 'p', name: 'N', created_at: '' }));
  const { api } = client(fetchImpl as unknown as typeof fetch);
  await api.createProject('N');
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/projects');
  const headers = new Headers(init.headers);
  expect(headers.get('Authorization')).toBe('Bearer tok');
  expect(headers.get('Content-Type')).toBe('application/json');
  expect(JSON.parse(init.body as string)).toEqual({ name: 'N' });
});

test('ids are URL-encoded in paths', async () => {
  const fetchImpl = vi.fn(async () => json(200, []));
  await client(fetchImpl as unknown as typeof fetch).api.listFiles('a/b?c');
  expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('/api/projects/a%2Fb%3Fc/files');
});

test('no token: does not call the API, reports 401 and signs out', async () => {
  const fetchImpl = vi.fn();
  const { api, onUnauthorized } = client(fetchImpl as unknown as typeof fetch, null);
  await expect(api.listProjects()).rejects.toMatchObject({ status: 401 });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(onUnauthorized).toHaveBeenCalledOnce();
});

test('a 401 from the API signs out', async () => {
  const { api, onUnauthorized } = client((async () =>
    json(401, { detail: 'Invalid or expired token.' })) as typeof fetch);
  await expect(api.listProjects()).rejects.toBeInstanceOf(ApiError);
  expect(onUnauthorized).toHaveBeenCalledOnce();
});

test('the API message is shown for limits, hidden for server errors', async () => {
  const limit = client((async () => json(409, { detail: 'A project holds at most 25 documents.' })) as typeof fetch);
  await expect(limit.api.requestUpload('p', 'a.pdf')).rejects.toThrow('A project holds at most 25 documents.');
  const broken = client((async () => json(500, { detail: 'Traceback: secret internals' })) as typeof fetch);
  await expect(broken.api.listProjects()).rejects.toThrow('Something went wrong on our side');
});

test('network failure becomes a friendly error', async () => {
  const { api } = client((async () => {
    throw new TypeError('Failed to fetch');
  }) as typeof fetch);
  await expect(api.listProjects()).rejects.toMatchObject({ status: 0 });
});

test.each([
  [429, 'Daily limit of 50 questions reached.', 'Daily limit of 50 questions reached.'],
  [422, [{ msg: 'field required' }], 'Some of the input is not valid.'],
  [404, 'Project not found.', 'Not found. It may have been deleted.'],
  [502, 'The knowledge base is unavailable.', 'The service is temporarily unavailable. Please try again.'],
])('errorMessage(%i)', (status, detail, expected) => {
  expect(errorMessage(status, detail)).toBe(expected);
});

test('ask streams events in order', async () => {
  const body =
    ': keep-alive\n\ndata: {"type":"token","text":"Hi "}\n\ndata: {"type":"token","text":"[1]"}\n\n' +
    'data: {"type":"citations","citations":[]}\n\ndata: {"type":"done","message_id":"m1"}\n\n';
  const { api } = client((async () => sse(body)) as typeof fetch);
  const events = [];
  for await (const e of api.ask('p', 'c', 'q')) events.push(e);
  expect(events.map((e) => e.type)).toEqual(['token', 'token', 'citations', 'done']);
});

test('a stream that ends without done or error reports an interrupted answer', async () => {
  const { api } = client((async () => sse('data: {"type":"token","text":"half"}\n\n')) as typeof fetch);
  const events = [];
  for await (const e of api.ask('p', 'c', 'q')) events.push(e);
  expect(events.at(-1)).toEqual({ type: 'error', message: 'The connection was interrupted. Please ask again.' });
});

test('ask rejected before streaming (daily cap) throws with the API message', async () => {
  const { api } = client((async () =>
    json(429, { detail: 'Daily limit of 50 questions reached. Try again tomorrow.' })) as typeof fetch);
  const run = async () => {
    for await (const _ of api.ask('p', 'c', 'q')) void _;
  };
  await expect(run()).rejects.toThrow('Daily limit of 50 questions reached');
});
