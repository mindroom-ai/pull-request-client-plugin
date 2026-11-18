// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Room } from 'matrix-js-sdk';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from './index';
import { setShownPullRequest } from './shownPullRequest';
import { trapOptions } from './testing/focusTrapStandIn';
import { linkedRoom, type TestLink, type TestWorktree } from './testing/linkedRoom';
import { ThreadPullRequestsButton } from './ThreadPullRequestsButton';

vi.mock('focus-trap-react', async () => ({
  default: (await import('./testing/focusTrapStandIn')).FocusTrapStandIn,
}));

const ROOM_ID = '!room:example.org';

const page = vi.hoisted(() => ({
  panel: undefined as { isOpen: boolean; open: ReturnType<typeof vi.fn> } | undefined,
}));
// The room has no MindRoom server unless a test gives one: the stand-in client knows no room.
vi.mock('@mindroom/client-sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mindroom/client-sdk/server')>()),
  useMindroomServerStatus: () => ({ server: undefined, pending: false }),
}));
vi.mock('@mindroom/client-sdk/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@mindroom/client-sdk/core')>();
  return { ...core, useRoomSidePanel: () => page.panel };
});

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const pullRequestRequests = () =>
  fetchMock.mock.calls.filter(([url]) => /\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url));

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const button = (room: Room, threadId = '$t1') => (
  <QueryClientProvider client={client}>
    <div data-testid="slot">
      <ThreadPullRequestsButton room={room} threadId={threadId} />
    </div>
  </QueryClientProvider>
);
const show = async (links: TestLink[], worktrees: TestWorktree[] = [], threadId = '$t1') => {
  const room = linkedRoom(ROOM_ID, links, worktrees);
  const view = await renderPluginComponent(button(room, threadId), { id: 'pull-requests', plugin });
  return { view, room };
};
type View = Awaited<ReturnType<typeof show>>['view'];

const WORKTREE = { path: 'worktrees/redis-sessions', branch: 'redis-sessions' };

const trigger = (view: View) => view.getByRole('button', { name: /^Pull request|^Worktree/ });
const openMenu = async (view: View) => {
  await act(async () => trigger(view).click());
  return view.getByRole('menu');
};
const rows = (view: View) => view.getAllByRole('menuitem');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  client.clear();
  page.panel = { isOpen: false, open: vi.fn() };
  setShownPullRequest(ROOM_ID, undefined);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => respond({ message: 'Not Found' }, 404));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ThreadPullRequestsButton', () => {
  it("is the plugin's control in the thread banner, and the room header has none", () => {
    expect(plugin.threadHeaderSlot).toEqual([ThreadPullRequestsButton]);
    expect(plugin.roomHeaderSlot).toBeUndefined();
  });

  it('renders nothing for a thread without links or a worktree', async () => {
    const { view } = await show([{ number: 1 }], [WORKTREE], '$t2');
    expect(view.getByTestId('slot').childElementCount).toBe(0);
  });

  it('names the count of pull requests and shows it beside the icon past one', async () => {
    const one = await show([{ number: 1 }]);
    expect(trigger(one.view).getAttribute('aria-label')).toBe('Pull request');
    expect(trigger(one.view).textContent).toBe('');
    one.view.unmount();
    const { view } = await show([{ number: 1 }, { number: 2 }, { thread: '$t2', number: 3 }]);
    const shown = trigger(view);
    expect(shown.getAttribute('aria-label')).toBe('Pull requests (2)');
    expect(shown.textContent).toBe('2');
    expect(shown.getAttribute('aria-haspopup')).toBe('menu');
    expect(shown.getAttribute('aria-expanded')).toBe('false');
  });

  it('names a thread with only a worktree by it, and lists the worktree alone', async () => {
    const { view } = await show([], [WORKTREE]);
    expect(trigger(view).getAttribute('aria-label')).toBe('Worktree');
    expect(trigger(view).textContent).toBe('');
    await openMenu(view);
    expect(rows(view)).toHaveLength(1);
    expect(rows(view)[0]?.textContent).toContain('worktrees/redis-sessions');
    // Something the menu's focus trap can hold, or the trap throws and the button goes.
    expect(rows(view)[0]?.tabIndex).toBe(0);
  });

  it('asks GitHub nothing while the menu is closed', async () => {
    const { view } = await show([{ number: 1 }, { number: 2 }], [WORKTREE]);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(trigger(view)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists each of the thread's pull requests and its worktree, and asks for those not loaded", async () => {
    const { view } = await show([{ number: 1 }, { number: 2 }], [WORKTREE]);
    const menu = await openMenu(view);
    expect(trigger(view).getAttribute('aria-expanded')).toBe('true');
    expect(menu.getAttribute('aria-label')).toBe('Pull requests (2)');
    expect(rows(view).map((row) => row.querySelector('.mrpr-truncate')?.textContent)).toEqual([
      'mindroom-chat #1',
      'mindroom-chat #2',
      // The worktree: a row the reader hears, which does nothing.
      undefined,
    ]);
    const worktree = rows(view)[2]!;
    expect(worktree.getAttribute('aria-disabled')).toBe('true');
    expect(worktree.textContent).toContain('worktrees/redis-sessions');
    await vi.waitFor(() => expect(pullRequestRequests()).toHaveLength(2));
  });

  it('opens a row in the side panel with the ref the strip chip gave, closes and refocuses the button', async () => {
    const { view } = await show([{ number: 1 }, { number: 2 }]);
    await openMenu(view);
    await act(async () => rows(view)[1]!.click());
    expect(page.panel?.open).toHaveBeenCalledWith({
      owner: 'mindroom-ai',
      repo: 'mindroom-chat',
      number: 2,
    });
    expect(view.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger(view));
  });

  it('closes on Escape and gives the focus back, and on a click outside', async () => {
    const { view } = await show([{ number: 1 }]);
    await openMenu(view);
    await act(async () => {
      trapOptions().escapeDeactivates?.();
    });
    expect(view.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger(view));
    await openMenu(view);
    await act(async () => {
      const outside = trapOptions().clickOutsideDeactivates;
      if (typeof outside === 'function')
        outside({ target: document.body } as unknown as MouseEvent);
    });
    expect(view.queryByRole('menu')).toBeNull();
  });

  it('closes, and stays closed, when its button is pressed while the menu is open', async () => {
    const { view } = await show([{ number: 1 }]);
    await openMenu(view);
    // The press, as the focus trap hears it: on its own button the trap neither closes the menu
    // on the mousedown nor swallows the click, which then closes it.
    const press = { target: trigger(view) } as unknown as MouseEvent;
    const { clickOutsideDeactivates, allowOutsideClick } = trapOptions();
    let closes = false;
    await act(async () => {
      closes =
        typeof clickOutsideDeactivates === 'function'
          ? clickOutsideDeactivates(press)
          : !!clickOutsideDeactivates;
    });
    expect(closes).toBe(false);
    expect(
      typeof allowOutsideClick === 'function' ? allowOutsideClick(press) : allowOutsideClick
    ).toBe(true);
    expect(view.getByRole('menu')).toBeTruthy();
    await act(async () => trigger(view).click());
    expect(view.queryByRole('menu')).toBeNull();
    expect(trigger(view).getAttribute('aria-expanded')).toBe('false');
  });

  it('gives the focus back to its button when a press on it closes the menu from a row', async () => {
    const { view } = await show([{ number: 1 }, { number: 2 }]);
    await openMenu(view);
    rows(view)[1]!.focus();
    // The trap keeps the focus on the row through the press; the click then closes the menu.
    await act(async () => trigger(view).click());
    expect(view.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger(view));
  });

  it('forgets an open menu when the thread loses its last link, and does not reopen with the next', async () => {
    const { view } = await show([{ number: 1 }]);
    await openMenu(view);
    view.rerender(button(linkedRoom(ROOM_ID, [])));
    expect(view.getByTestId('slot').childElementCount).toBe(0);
    view.rerender(button(linkedRoom(ROOM_ID, [{ number: 2 }])));
    expect(trigger(view).getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByRole('menu')).toBeNull();
  });

  it('marks the row of the pull request the open panel shows, in any letter case', async () => {
    page.panel = { isOpen: true, open: vi.fn() };
    setShownPullRequest(ROOM_ID, { owner: 'MindRoom-AI', repo: 'MindRoom-Chat', number: 2 });
    const { view } = await show([{ number: 1 }, { number: 2 }]);
    await openMenu(view);
    expect(rows(view).map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true']);
  });

  it('marks no row while the panel is closed', async () => {
    setShownPullRequest(ROOM_ID, { owner: 'mindroom-ai', repo: 'mindroom-chat', number: 2 });
    const { view } = await show([{ number: 1 }, { number: 2 }]);
    await openMenu(view);
    expect(rows(view).map((row) => row.getAttribute('aria-current'))).toEqual([null, null]);
  });

  it('links each row to GitHub where the page has no panel controls', async () => {
    page.panel = undefined;
    const { view } = await show([{ number: 7 }]);
    await openMenu(view);
    const [row] = rows(view);
    expect(row?.tagName).toBe('A');
    expect(row?.getAttribute('href')).toBe('https://github.com/mindroom-ai/mindroom-chat/pull/7');
    expect(row?.getAttribute('target')).toBe('_blank');
    expect(row?.getAttribute('rel')).toBe('noreferrer');
  });
});
