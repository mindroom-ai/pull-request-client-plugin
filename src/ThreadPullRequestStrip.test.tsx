// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Room } from 'matrix-js-sdk';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from './index';
import { setShownPullRequest } from './shownPullRequest';
import { linkedRoom, type TestLink, type TestWorktree } from './testing/linkedRoom';
import { ThreadPullRequestStrip } from './ThreadPullRequestStrip';

const ROOM_ID = '!room:example.org';

const page = vi.hoisted(() => ({
  thread: undefined as string | undefined,
  panel: undefined as { isOpen: boolean; open: ReturnType<typeof vi.fn> } | undefined,
}));
vi.mock('@mindroom/client-sdk/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@mindroom/client-sdk/core')>();
  return { ...core, useRoomSidePanel: () => page.panel };
});
vi.mock('@mindroom/client-sdk/room', async (importOriginal) => {
  const room = await importOriginal<typeof import('@mindroom/client-sdk/room')>();
  return { ...room, useShownThread: () => page.thread };
});

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const strip = (room: Room) => (
  <QueryClientProvider client={client}>
    <div data-testid="slot">
      <ThreadPullRequestStrip room={room} />
    </div>
  </QueryClientProvider>
);
const show = async (links: TestLink[], worktrees: TestWorktree[] = []) => {
  const room = linkedRoom(ROOM_ID, links, worktrees);
  const view = await renderPluginComponent(strip(room), { id: 'pull-requests', plugin });
  return { view, room };
};
type View = Awaited<ReturnType<typeof show>>['view'];

const WORKTREE = { path: 'worktrees/redis-sessions', branch: 'redis-sessions' };
const BRANCH = 'Worktree worktrees/redis-sessions, branch redis-sessions';

const chip = (view: View, number: number) =>
  view.getByRole('button', { name: `Pull request mindroom-ai/mindroom-chat #${number}` });

/** The text of the chips marked as the one the panel shows. */
const pressed = (view: View) =>
  view
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.textContent);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  client.clear();
  page.thread = '$t1';
  page.panel = { isOpen: false, open: vi.fn() };
  setShownPullRequest(ROOM_ID, undefined);
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ThreadPullRequestStrip', () => {
  it('renders nothing while no thread shows', async () => {
    page.thread = undefined;
    const { view } = await show([{ number: 1 }]);
    expect(view.getByTestId('slot').childElementCount).toBe(0);
  });

  it('renders nothing for a thread without links or a worktree', async () => {
    page.thread = '$t2';
    const { view } = await show([{ number: 1 }], [WORKTREE]);
    expect(view.getByTestId('slot').childElementCount).toBe(0);
  });

  it("shows the thread's branch first, as text, then its pull requests", async () => {
    const { view } = await show([{ number: 1 }, { number: 2 }], [WORKTREE]);
    const branch = view.getByRole('img', { name: BRANCH });
    expect(view.getByRole('group').firstElementChild).toBe(branch);
    expect(branch.tagName).toBe('SPAN');
    expect(branch.textContent).toBe('redis-sessions');
    expect(view.getAllByRole('button').map((button) => button.textContent)).toEqual(['#1', '#2']);
  });

  it("draws the branch's repository in a room whose links span several", async () => {
    const worktree = { ...WORKTREE, repo: 'mindroom-chat' };
    const name =
      'Worktree worktrees/redis-sessions, repository mindroom-chat, branch redis-sessions';
    const one = await show([{ number: 1 }], [worktree]);
    expect(one.view.getByRole('img', { name }).querySelector('.mrpr-chip-repo')).toBeNull();
    one.view.unmount();
    const several = await show([{ number: 1 }, { repo: 'mindroom', number: 2 }], [worktree]);
    const chip = several.view.getByRole('img', { name });
    expect(chip.querySelector('.mrpr-chip-repo')?.textContent).toBe('mindroom-chat');
  });

  it('shows the branch alone for a thread with a worktree and no links', async () => {
    const { view } = await show([], [WORKTREE]);
    expect(view.getByRole('img', { name: BRANCH }).textContent).toBe('redis-sessions');
    expect(view.queryAllByRole('button')).toEqual([]);
  });

  it("shows each of the thread's pull requests as a button", async () => {
    const { view } = await show([{ number: 1 }, { thread: '$t2', number: 2 }, { number: 3 }]);
    expect(view.getAllByRole('button').map((button) => button.textContent)).toEqual(['#1', '#3']);
  });

  it('opens the pull request in the side panel', async () => {
    const { view } = await show([{ number: 1 }, { number: 2 }]);
    await act(async () => chip(view, 2).click());
    expect(page.panel?.open).toHaveBeenCalledWith({
      owner: 'mindroom-ai',
      repo: 'mindroom-chat',
      number: 2,
    });
  });

  it('marks the pull request the panel shows, only while the panel is open', async () => {
    page.panel = { isOpen: true, open: vi.fn() };
    const { view, room } = await show([{ number: 1 }, { number: 2 }]);
    expect(pressed(view)).toEqual([]);
    act(() =>
      setShownPullRequest(ROOM_ID, { owner: 'mindroom-ai', repo: 'mindroom-chat', number: 2 })
    );
    expect(pressed(view)).toEqual(['#2']);
    page.panel = { isOpen: false, open: vi.fn() };
    view.rerender(strip(room));
    expect(pressed(view)).toEqual([]);
  });

  it('marks a pull request the panel shows in other letter case', async () => {
    page.panel = { isOpen: true, open: vi.fn() };
    setShownPullRequest(ROOM_ID, { owner: 'MindRoom-AI', repo: 'MindRoom-Chat', number: 1 });
    const { view } = await show([{ number: 1 }, { number: 2 }]);
    expect(pressed(view)).toEqual(['#1']);
  });
});
