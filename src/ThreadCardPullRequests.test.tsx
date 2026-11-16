// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Room } from 'matrix-js-sdk';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from './index';
import { linkedRoom, type TestLink, type TestWorktree } from './testing/linkedRoom';
import { ThreadCardPullRequests } from './ThreadCardPullRequests';

const ROOM_ID = '!room:example.org';
// The thread `linkedRoom` links to unless told otherwise.
const THREAD = '$t1';

const page = vi.hoisted(() => ({
  panel: undefined as { isOpen: boolean; open: ReturnType<typeof vi.fn> } | undefined,
  navigateRoomThread: vi.fn(),
  /** How many times a card asked for the side panel. */
  panelReads: 0,
}));
vi.mock('@mindroom/client-sdk/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@mindroom/client-sdk/core')>();
  return {
    ...core,
    useRoomSidePanel: () => {
      page.panelReads += 1;
      return page.panel;
    },
  };
});
vi.mock('@mindroom/client-sdk/room', async (importOriginal) => {
  const room = await importOriginal<typeof import('@mindroom/client-sdk/room')>();
  return {
    ...room,
    useRoomNavigate: () => ({
      navigateRoom: vi.fn(),
      navigateRoomThread: page.navigateRoomThread,
    }),
  };
});

const roomWith = (links: TestLink[], worktrees: TestWorktree[] = []) =>
  linkedRoom(ROOM_ID, links, worktrees);
const WORKTREE = { path: 'worktrees/redis-sessions', branch: 'redis-sessions' };

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const show = async (
  room: Room,
  { onParentClick = vi.fn(), phone = false }: { onParentClick?: () => void; phone?: boolean } = {}
) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderPluginComponent(
    <QueryClientProvider client={client}>
      {/* The card's button, which opens the thread on a click that reaches it. */}
      <div data-testid="card" onClick={onParentClick}>
        <ThreadCardPullRequests room={room} threadId={THREAD} />
      </div>
    </QueryClientProvider>,
    { id: 'pull-requests', plugin, screenSize: phone ? 'Mobile' : 'Desktop' }
  );
};

const chips = (view: Awaited<ReturnType<typeof show>>) =>
  view.getAllByRole('img', { name: /^Pull request / });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  page.panel = { isOpen: false, open: vi.fn() };
  page.panelReads = 0;
  page.navigateRoomThread.mockReset();
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

describe('ThreadCardPullRequests', () => {
  it('renders nothing for a thread without links or a worktree', async () => {
    const view = await show(
      roomWith([{ thread: '$other', number: 1 }], [{ thread: '$other', ...WORKTREE }])
    );
    expect(view.getByTestId('card').childElementCount).toBe(0);
  });

  it('shows the branch of a thread with a worktree and no links, and lets a click reach the card', async () => {
    const onParentClick = vi.fn();
    const view = await show(roomWith([], [WORKTREE]), { onParentClick });
    const branch = view.getByRole('img', {
      name: 'Worktree worktrees/redis-sessions, branch redis-sessions',
    });
    expect(branch.textContent).toBe('redis-sessions');
    expect(view.getByTestId('card').querySelector('button, a, [tabindex]')).toBeNull();
    // The side panel's hooks are left for a thread with links.
    expect(page.panelReads).toBe(0);
    await act(async () => branch.click());
    expect(onParentClick).toHaveBeenCalledTimes(1);
    expect(page.navigateRoomThread).not.toHaveBeenCalled();
  });

  it("draws a worktree's repository only in a room that works on several", async () => {
    const worktree = { ...WORKTREE, repo: 'mindroom-chat' };
    const name =
      'Worktree worktrees/redis-sessions, repository mindroom-chat, branch redis-sessions';
    // The chip's text in one room, which is unmounted before the next one is shown.
    const drawn = async (room: Room) => {
      const view = await show(room);
      const chip = view.getByRole('img', { name });
      const parts = [...chip.querySelectorAll('.mrpr-branch-chip-names > span')];
      view.unmount();
      return parts.map((part) => part.textContent);
    };
    const other = { ...WORKTREE, thread: '$other' };
    expect(await drawn(roomWith([], [worktree, { ...other, repo: 'mindroom-chat' }]))).toEqual([
      'redis-sessions',
    ]);
    expect(await drawn(roomWith([], [worktree, { ...other, repo: 'mindroom' }]))).toEqual([
      'mindroom-chat',
      'redis-sessions',
    ]);
    const links = [
      { thread: '$other', number: 1 },
      { thread: '$other', repo: 'mindroom', number: 2 },
    ];
    expect(await drawn(roomWith(links, [worktree]))).toEqual(['mindroom-chat', 'redis-sessions']);
    // A worktree whose event names no repository is not one more repository.
    expect(await drawn(roomWith([], [worktree, other]))).toEqual(['redis-sessions']);
  });

  it('shows only the pull requests of a thread with links and a worktree', async () => {
    const view = await show(roomWith([{ number: 1 }], [WORKTREE]));
    expect(chips(view).map((chip) => chip.textContent)).toEqual(['#1']);
    expect(view.queryByRole('img', { name: /^Worktree / })).toBeNull();
  });

  it('reads nothing but the links for a thread without any', async () => {
    await show(roomWith([{ thread: '$other', number: 1 }]));
    expect(page.panelReads).toBe(0);
    await show(roomWith([{ number: 1 }]));
    expect(page.panelReads).toBeGreaterThan(0);
  });

  it('shows two chips and the count of the rest', async () => {
    const view = await show(roomWith([{ number: 1 }, { number: 2 }, { number: 3 }]));
    expect(chips(view).map((chip) => chip.textContent)).toEqual(['#1', '#2']);
    const more = view.getByRole('img', { name: '1 more pull request' });
    expect(more.textContent).toBe('+1');
  });

  it('shows one chip and the count of the rest on a phone', async () => {
    const view = await show(roomWith([{ number: 1 }, { number: 2 }, { number: 3 }]), {
      phone: true,
    });
    expect(chips(view).map((chip) => chip.textContent)).toEqual(['#1']);
    expect(view.getByRole('img', { name: '2 more pull requests' }).textContent).toBe('+2');
  });

  it('shows no count when every chip shows', async () => {
    const view = await show(roomWith([{ number: 1 }, { number: 2 }]));
    expect(chips(view)).toHaveLength(2);
    expect(view.queryByRole('img', { name: /more pull request/ })).toBeNull();
  });

  it("shows the repository only when the room's links span more than one repository", async () => {
    const one = await show(roomWith([{ number: 1 }, { thread: '$other', number: 2 }]));
    expect(chips(one).map((chip) => chip.textContent)).toEqual(['#1']);
    one.unmount();
    const two = await show(
      roomWith([{ number: 1 }, { thread: '$other', repo: 'tuwunel', number: 2 }])
    );
    expect(chips(two).map((chip) => chip.textContent)).toEqual(['mindroom-chat#1']);
  });

  it('opens the thread and the pull request in the side panel, and keeps the click from the card', async () => {
    const onParentClick = vi.fn();
    const view = await show(roomWith([{ number: 1 }, { number: 2 }]), { onParentClick });
    await act(async () => chips(view)[1]!.click());
    expect(page.navigateRoomThread).toHaveBeenCalledWith(ROOM_ID, THREAD);
    expect(page.panel?.open).toHaveBeenCalledWith({
      owner: 'mindroom-ai',
      repo: 'mindroom-chat',
      number: 2,
    });
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it('lets a click reach the card outside a room page', async () => {
    page.panel = undefined;
    const onParentClick = vi.fn();
    const view = await show(roomWith([{ number: 1 }]), { onParentClick });
    await act(async () => chips(view)[0]!.click());
    expect(onParentClick).toHaveBeenCalledTimes(1);
    expect(page.navigateRoomThread).not.toHaveBeenCalled();
  });

  it('has no button, link or tab stop', async () => {
    const view = await show(roomWith([{ number: 1 }, { number: 2 }, { number: 3 }]));
    expect(chips(view)).toHaveLength(2);
    expect(view.getByTestId('card').querySelector('button, a, [tabindex]')).toBeNull();
  });
});
