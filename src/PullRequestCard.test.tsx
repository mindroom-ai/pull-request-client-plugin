// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from './index';
import { PullRequestCard } from './PullRequestCard';

vi.mock('focus-trap-react', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

const room = vi.hoisted(() => ({
  panel: undefined as { open: ReturnType<typeof vi.fn> } | undefined,
}));
vi.mock('@mindroom/client-sdk/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@mindroom/client-sdk/core')>();
  return { ...core, useRoomSidePanel: () => room.panel };
});

const HREF = 'https://github.com/mindroom-ai/mindroom-chat/pull/200';

const pull = (over: Record<string, unknown> = {}) => ({
  title: 'Add pull request cards',
  state: 'open',
  draft: false,
  merged_at: null,
  user: {
    login: 'basnijholt',
    avatar_url: 'https://avatars.githubusercontent.com/u/1',
    html_url: 'x',
  },
  created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  ...over,
});

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// A test of a plugin cannot import Testing Library itself (its CommonJS build would load a second
// React), so it uses the queries of what `renderPluginComponent` returns and these two events.
const click = (element: HTMLElement) => act(async () => element.click());
const type = (element: HTMLElement, value: string) =>
  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setValue?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const show = async (close = vi.fn()) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderPluginComponent(
    <QueryClientProvider client={client}>
      <PullRequestCard href={HREF} roomId="!room:example.org" close={close} />
    </QueryClientProvider>,
    { id: 'pull-requests', plugin }
  );
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  room.panel = undefined;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PullRequestCard', () => {
  it('shows the repository, number, state, title and author', async () => {
    fetchMock.mockImplementation(async () => respond(pull()));
    const view = await show();
    expect(await view.findByText('Add pull request cards')).toBeTruthy();
    expect(view.getByText('mindroom-ai/mindroom-chat')).toBeTruthy();
    expect(view.getByText('#200')).toBeTruthy();
    expect(view.getByText('Open')).toBeTruthy();
    expect(view.getByText('basnijholt')).toBeTruthy();
    expect(view.getByText(/opened 3 days ago/)).toBeTruthy();
  });

  it('shows the merged state', async () => {
    fetchMock.mockImplementation(async () =>
      respond(pull({ state: 'closed', merged_at: '2026-11-01T00:00:00Z' }))
    );
    const view = await show();
    expect(await view.findByText('Merged')).toBeTruthy();
  });

  it('shows the token form for a private pull request', async () => {
    fetchMock.mockResolvedValueOnce(respond({}, 404));
    const view = await show();
    expect(
      await view.findByText(
        'GitHub did not find this pull request. A private repository needs a token.'
      )
    ).toBeTruthy();
    fetchMock.mockImplementation(async () => respond(pull()));
    await type(view.getByLabelText('GitHub token'), 'ghp_secret');
    await click(view.getByRole('button', { name: 'Save' }));
    expect(await view.findByText('Add pull request cards')).toBeTruthy();
    const init = fetchMock.mock.calls.at(-1)?.[1];
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer ghp_secret');
  });

  it('shows the bad token state', async () => {
    localStorage.clear();
    fetchMock.mockResolvedValueOnce(respond({}, 404));
    const view = await show();
    await view.findByLabelText('GitHub token');
    fetchMock.mockImplementation(async () => respond({}, 401));
    await type(view.getByLabelText('GitHub token'), 'ghp_old');
    await click(view.getByRole('button', { name: 'Save' }));
    expect(await view.findByText('GitHub refused the saved token.')).toBeTruthy();
    await click(view.getByRole('button', { name: 'Forget token' }));
    await vi.waitFor(() => expect(view.queryByText('GitHub refused the saved token.')).toBeNull());
  });

  it('opens the side panel with the reference and closes', async () => {
    fetchMock.mockImplementation(async () => respond(pull()));
    room.panel = { open: vi.fn() };
    const close = vi.fn();
    const view = await show(close);
    await click(await view.findByText('Open in side panel'));
    expect(room.panel.open).toHaveBeenCalledWith({
      owner: 'mindroom-ai',
      repo: 'mindroom-chat',
      number: 200,
    });
    expect(close).toHaveBeenCalled();
  });

  it('has no side panel action outside a room page', async () => {
    fetchMock.mockImplementation(async () => respond(pull()));
    const view = await show();
    await view.findByText('Add pull request cards');
    expect(view.queryByText('Open in side panel')).toBeNull();
    expect(view.getByText('Open on GitHub')).toBeTruthy();
  });

  it('opens GitHub without an opener and copies the link', async () => {
    fetchMock.mockImplementation(async () => respond(pull()));
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const view = await show();
    await click(await view.findByText('Open on GitHub'));
    expect(open).toHaveBeenCalledWith(HREF, '_blank', 'noopener,noreferrer');
    await click(view.getByText('Copy link'));
    expect(writeText).toHaveBeenCalledWith(HREF);
    expect(await view.findByText('Copied')).toBeTruthy();
  });
});
