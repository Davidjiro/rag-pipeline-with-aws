import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiClient } from '../lib/api';
import type { AnswerEvent, Chat } from '../lib/types';
import { ChatView } from './ChatView';

const CHAT: Chat = { chat_id: 'c1', title: 'Refunds', strategy: 'basic', created_at: '' };
const CITE = {
  number: 1,
  key: 'projects/p/d/policy.txt',
  filename: 'policy.txt',
  snippet: '45 days',
  score: 0.8,
  url: 'https://s3.example/policy',
};

function fakeApi(events: AnswerEvent[]) {
  const ask = vi.fn(async function* () {
    for (const e of events) yield e;
  });
  return { api: { listMessages: vi.fn(async () => []), ask } as unknown as ApiClient, ask };
}

test('streams an answer, links [1] to its source, and keeps it after done', async () => {
  const { api, ask } = fakeApi([
    { type: 'token', text: 'The window is ' },
    { type: 'token', text: '45 days [1].' },
    { type: 'citations', citations: [CITE] },
    { type: 'done', message_id: 'm1' },
  ]);
  const onAnswered = vi.fn();
  render(<ChatView api={api} projectId="p" chat={CHAT} onAnswered={onAnswered} />);
  await userEvent.type(screen.getByLabelText('Your question'), 'How long?{Enter}');

  expect(await screen.findByText('How long?')).toBeInTheDocument();
  const marker = await screen.findByRole('link', { name: 'Source 1' });
  expect(marker.closest('.answer')).toHaveTextContent('The window is 45 days [1].');
  expect(marker).toHaveAttribute('href', '#m1-1');
  const source = screen.getByRole('link', { name: 'policy.txt' });
  expect(source).toHaveAttribute('href', CITE.url);
  expect(source).toHaveAttribute('rel', 'noopener noreferrer');
  expect(ask).toHaveBeenCalledWith('p', 'c1', 'How long?', expect.any(AbortSignal));
  expect(onAnswered).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('Your question')).toHaveValue('');
});

test('a failed answer shows the error, saves nothing, and puts the question back', async () => {
  const { api } = fakeApi([
    { type: 'token', text: 'partial' },
    { type: 'error', message: 'The answer could not be generated. Please try again.' },
  ]);
  const onAnswered = vi.fn();
  render(<ChatView api={api} projectId="p" chat={CHAT} onAnswered={onAnswered} />);
  await userEvent.type(screen.getByLabelText('Your question'), 'Q{Enter}');

  expect(await screen.findByRole('alert')).toHaveTextContent('The answer could not be generated');
  await waitFor(() => expect(screen.getByLabelText('Your question')).toHaveValue('Q'));
  expect(screen.queryByText('partial')).not.toBeInTheDocument();
  expect(onAnswered).not.toHaveBeenCalled();
});

test('answer text is rendered as text, never as HTML', async () => {
  const { api } = fakeApi([
    { type: 'token', text: '<img src=x onerror=alert(1)>' },
    { type: 'done', message_id: 'm' },
  ]);
  const { container } = render(<ChatView api={api} projectId="p" chat={CHAT} onAnswered={() => undefined} />);
  await userEvent.type(screen.getByLabelText('Your question'), 'Q{Enter}');
  expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  expect(container.querySelector('img')).toBeNull();
});
