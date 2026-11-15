// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Room } from 'matrix-js-sdk';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from './index';
import { linkedRoom, type TestLink } from './testing/linkedRoom';
import { ThreadCardPullRequests } from './ThreadCardPullRequests';

const ROOM_ID = '!room:example.org';
// The thread `linkedRoom` links to unless told otherwise.
const THREAD = '$t1';

const page = vi.hoisted(() => ({
  panel: undefined as { isOpen: boolean; open: ReturnType<typeof vi.fn> } | undefined,
  navigateRoomThread: vi.fn(),
}));
vi.mock('@mindroom/client-sdk/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@mindroom/client-sdk/core')>();
  return { ...core, useRoomSidePanel: () => page.panel };
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

const roomWith = (links: TestLink[]) => linkedRoom(ROOM_ID, links);

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
  it('renders nothing for a thread without links', async () => {
    const view = await show(roomWith([{ thread: '$other', number: 1 }]));
    expect(view.getByTestId('card').childElementCount).toBe(0);
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
