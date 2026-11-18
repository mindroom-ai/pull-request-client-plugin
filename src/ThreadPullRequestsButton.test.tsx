// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Room } from 'matrix-js-sdk';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from './index';
import { setShownPullRequest } from './shownPullRequest';
import type { PullRequest } from './github';
import { pullRequestKey } from './queries';
import { trapOptions } from './testing/focusTrapStandIn';
import { githubServer } from './testing/mindroomServer';
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
const roomServer = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@mindroom/client-sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mindroom/client-sdk/server')>()),
  useMindroomServerStatus: () => ({ server: roomServer.current, pending: false }),
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

const pull = (state: string, over: Record<string, unknown> = {}) => ({
  title: 'Store sessions in Redis',
  state: state === 'merged' ? 'closed' : state,
  draft: false,
  merged_at: state === 'merged' ? '2026-11-18T10:00:00Z' : null,
  head: { sha: 'abc123', ref: 'redis-sessions', repo: { full_name: 'mindroom-ai/mindroom-chat' } },
  base: { ref: 'main', repo: { full_name: 'mindroom-ai/mindroom-chat' } },
  user: { login: 'acme-builder' },
  updated_at: '2026-11-18T10:00:00Z',
  ...over,
});
// GitHub with the pull requests of `mindroom-chat` by number; one held answers when `release` runs.
const held = vi.hoisted(() => ({ release: () => {} }));
const serve = (pulls: Record<number, unknown>, hold?: number) =>
  fetchMock.mockImplementation(async (url) => {
    const number = Number(/\/pulls\/(\d+)$/.exec(url)?.[1]);
    const body = pulls[number];
    if (number === hold)
      return new Promise((resolve) => {
        held.release = () => resolve(respond(body));
      });
    return body === undefined ? respond({ message: 'Not Found' }, 404) : respond(body);
  });
// Where `usePluginStorage` keeps the GitHub token of the test's account.
const TOKEN_KEY = 'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/githubToken';
const withToken = () => localStorage.setItem(TOKEN_KEY, 'ghp_test');
/** What another surface read anonymously of pull request `number`, as it keeps it. */
const readAnonymously = (number: number, state: PullRequest['state']) =>
  client.setQueryData(
    [...pullRequestKey({ owner: 'mindroom-ai', repo: 'mindroom-chat', number }), false],
    { state, draft: false } as PullRequest
  );
const icon = (view: View) => trigger(view).querySelector('svg')!;
const tone = (view: View) =>
  [...icon(view).classList].find((name) => name.startsWith('mrpr-tone-'));

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
  roomServer.current = undefined;
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

  it('asks GitHub once for each pull request while closed, for no checks, and not again on a second mount', async () => {
    localStorage.setItem(TOKEN_KEY, 'ghp_test');
    serve({ 1: pull('open') });
    const first = await show([{ number: 1 }, { number: 2 }], [WORKTREE]);
    await vi.waitFor(() => expect(tone(first.view)).toBe('mrpr-tone-open'));
    expect(pullRequestRequests()).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    first.view.unmount();
    // The answer and the refusal (number 2) alike are kept: neither is asked again.
    const { view } = await show([{ number: 1 }, { number: 2 }], [WORKTREE]);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(tone(view)).toBe('mrpr-tone-open');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ 1: pull('open'), 2: pull('merged') }, 'open', 'Pull requests (2): Open'],
    [{ 1: pull('merged'), 2: pull('merged') }, 'merged', 'Pull requests (2): Merged'],
    [{ 1: pull('merged'), 2: pull('closed') }, 'closed', 'Pull requests (2): Closed'],
    [
      { 1: pull('open', { draft: true }), 2: pull('open', { draft: true }) },
      'draft',
      'Pull requests (2): Draft',
    ],
    // A pull request GitHub refused counts for nothing.
    [{ 1: pull('merged') }, 'merged', 'Pull requests (2): Merged'],
  ])('takes the tone and icon of its pull requests together: %#', async (pulls, state, label) => {
    withToken();
    serve(pulls);
    const { view } = await show([{ number: 1 }, { number: 2 }]);
    await vi.waitFor(() => expect(tone(view)).toBe(`mrpr-tone-${state}`));
    expect(trigger(view).getAttribute('aria-label')).toBe(label);
    expect(icon(view).classList).toContain(
      `lucide-${
        {
          open: 'git-pull-request-arrow',
          draft: 'git-pull-request-draft',
          closed: 'git-pull-request-closed',
          merged: 'git-merge',
        }[state]
      }`
    );
  });

  it('asks GitHub nothing without a token, and takes only the answers other surfaces read', async () => {
    serve({ 1: pull('open'), 2: pull('merged') });
    const first = await show([{ number: 1 }, { number: 2 }]);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(tone(first.view)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    first.view.unmount();
    // A chip read one: still neutral, as the other might be open.
    readAnonymously(2, 'merged');
    const second = await show([{ number: 1 }, { number: 2 }]);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(tone(second.view)).toBeUndefined();
    second.view.unmount();
    readAnonymously(1, 'merged');
    const { view } = await show([{ number: 1 }, { number: 2 }]);
    await vi.waitFor(() => expect(tone(view)).toBe('mrpr-tone-merged'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves out a pull request whose refetch GitHub refused, also one that showed before', async () => {
    localStorage.setItem(TOKEN_KEY, 'ghp_test');
    serve({ 1: pull('open'), 2: pull('merged') });
    const { view } = await show([{ number: 1 }, { number: 2 }]);
    await vi.waitFor(() => expect(tone(view)).toBe('mrpr-tone-open'));
    // Number 1 is gone now: its query keeps the open pull request beside the error.
    serve({ 2: pull('merged') });
    await act(async () => client.invalidateQueries());
    await vi.waitFor(() => expect(tone(view)).toBe('mrpr-tone-merged'));
    expect(trigger(view).getAttribute('aria-label')).toBe('Pull requests (2): Merged');
    serve({});
    await act(async () => client.invalidateQueries());
    await vi.waitFor(() => expect(tone(view)).toBeUndefined());
    expect(trigger(view).getAttribute('aria-label')).toBe('Pull requests (2)');
  });

  it('names one pull request with its state', async () => {
    withToken();
    serve({ 1: pull('merged') });
    const { view } = await show([{ number: 1 }]);
    await vi.waitFor(() => expect(tone(view)).toBe('mrpr-tone-merged'));
    expect(trigger(view).getAttribute('aria-label')).toBe('Pull request: Merged');
  });

  it('stays neutral while every pull request is refused', async () => {
    withToken();
    const { view } = await show([{ number: 1 }, { number: 2 }]);
    await vi.waitFor(() => expect(pullRequestRequests()).toHaveLength(2));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(tone(view)).toBeUndefined();
    expect(trigger(view).getAttribute('aria-label')).toBe('Pull requests (2)');
  });

  it('stays neutral while one still loads, unless those answered already make it open', async () => {
    withToken();
    serve({ 1: pull('merged'), 2: pull('open') }, 2);
    const { view } = await show([{ number: 1 }, { number: 2 }]);
    await vi.waitFor(() => expect(pullRequestRequests()).toHaveLength(2));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    // Not merged first, then open: the tone never changes once it shows.
    expect(tone(view)).toBeUndefined();
    expect(trigger(view).getAttribute('aria-label')).toBe('Pull requests (2)');
    await act(async () => held.release());
    await vi.waitFor(() => expect(tone(view)).toBe('mrpr-tone-open'));
    view.unmount();
    client.clear();
    serve({ 1: pull('open'), 2: pull('merged') }, 2);
    const again = await show([{ number: 1 }, { number: 2 }]);
    await vi.waitFor(() => expect(tone(again.view)).toBe('mrpr-tone-open'));
  });

  it('keeps the branch icon, without a tone, for a thread with only a worktree, and asks nothing', async () => {
    const mindroom = githubServer(fetchMock);
    roomServer.current = mindroom.server;
    const { view } = await show([], [WORKTREE]);
    expect(icon(view).classList).toContain('lucide-git-branch');
    expect(tone(view)).toBeUndefined();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    // Not even whether the room's MindRoom server has GitHub connected.
    expect(mindroom.server.request).not.toHaveBeenCalled();
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

  it('closes on a press over its button, which the menu layer covers, and gives it the focus', async () => {
    const { view } = await show([{ number: 1 }, { number: 2 }]);
    await openMenu(view);
    rows(view)[1]!.focus();
    vi.spyOn(trigger(view), 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 10, y: 10, width: 56, height: 32 })
    );
    // The press lands on the menu's layer, over the button: the trap hears it outside the menu.
    const press = new MouseEvent('mousedown', { clientX: 30, clientY: 20, cancelable: true });
    const outside = trapOptions().clickOutsideDeactivates;
    let closes = false;
    await act(async () => {
      closes = typeof outside === 'function' ? outside(press) : !!outside;
    });
    expect(closes).toBe(true);
    // Nor does the press's own focusing move the focus to the gone layer afterwards.
    expect(press.defaultPrevented).toBe(true);
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
