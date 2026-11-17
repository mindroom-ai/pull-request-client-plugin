// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Room } from 'matrix-js-sdk';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from './index';
import { middleTruncate } from './middleTruncate';
import { linkedRoom, type TestLink, type TestWorktree } from './testing/linkedRoom';
import { ThreadCardPullRequests } from './ThreadCardPullRequests';
import { ThreadDetails } from './ThreadDetails';
import { threadHasDetails } from './threadPullRequests';

// A card's chip opens its thread on a click, which needs the room's page; no test here clicks.
// The room has no MindRoom server unless a test gives one: the stand-in client knows no room.
const roomServer = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@mindroom/client-sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mindroom/client-sdk/server')>()),
  useMindroomServerStatus: () => ({ server: roomServer.current, pending: false }),
}));

vi.mock('@mindroom/client-sdk/room', async (importOriginal) => {
  const room = await importOriginal<typeof import('@mindroom/client-sdk/room')>();
  return {
    ...room,
    useRoomNavigate: () => ({ navigateRoom: vi.fn(), navigateRoomThread: vi.fn() }),
  };
});

const ROOM_ID = '!room:example.org';
const SHA = 'abc123';
const REPOSITORY = 'mindroom-ai/mindroom-chat';
// As on a chip, the details name the repository without its owner.
const NUMBER = (number: number) => `mindroom-chat #${number}`;

const pull = (over: Record<string, unknown> = {}) => ({
  title: 'Store sessions in Redis',
  state: 'open',
  draft: false,
  merged_at: null,
  head: { sha: SHA, ref: 'redis-sessions', repo: { full_name: REPOSITORY } },
  base: { ref: 'main', repo: { full_name: REPOSITORY } },
  user: { login: 'acme-builder' },
  additions: 120,
  deletions: 30,
  changed_files: 5,
  updated_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  ...over,
});

const run = (conclusion: string) => ({
  name: `build ${conclusion}`,
  status: 'completed',
  conclusion,
});

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const requests = (part: string) => fetchMock.mock.calls.filter(([url]) => url.includes(part));

// Where `usePluginStorage` keeps the GitHub token of the test's account.
const TOKEN_KEY = 'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/githubToken';
const saveToken = () => localStorage.setItem(TOKEN_KEY, 'ghp_test');

/** GitHub with the pull requests of `mindroom-chat` by number, whose head commits have `runs`. */
const serve = (pulls: Record<number, unknown>, runs: unknown[] = []) =>
  fetchMock.mockImplementation(async (url) => {
    const number = /\/repos\/mindroom-ai\/mindroom-chat\/pulls\/(\d+)$/.exec(url)?.[1];
    const pr = number === undefined ? undefined : pulls[Number(number)];
    if (pr !== undefined) return respond(pr);
    if (url.includes(`/commits/${SHA}/check-runs?`)) return respond({ check_runs: runs });
    if (url.includes(`/commits/${SHA}/status?`)) return respond({ statuses: [] });
    return respond({ message: 'Not Found' }, 404);
  });

const roomWith = (links: TestLink[], worktrees: TestWorktree[] = []) =>
  linkedRoom(ROOM_ID, links, worktrees);

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });

const show = async (room: Room, client = newClient()) => {
  const view = await renderPluginComponent(
    <QueryClientProvider client={client}>
      <ThreadDetails room={room} threadId="$t1" />
    </QueryClientProvider>,
    { id: 'pull-requests', plugin }
  );
  return { view, client };
};

/** Waits until GitHub answered the request for `part` and the details rendered the answer. */
const answered = async (client: QueryClient, part: string) => {
  await vi.waitFor(() => expect(requests(part).length).toBeGreaterThan(0));
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const blocks = (view: Awaited<ReturnType<typeof show>>['view']) => [
  ...view.container.querySelectorAll('.mrpr-details-pull-request'),
];

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ThreadDetails', () => {
  it("is the plugin's thread details, for threads with a link or a worktree", () =>
    expect(plugin.threadDetails).toEqual([{ shows: threadHasDetails, Component: ThreadDetails }]));

  it('shows a loaded pull request: repository and number with its state and checks, title, size and age', async () => {
    saveToken();
    serve({ 412: pull() }, [run('success')]);
    const { view } = await show(roomWith([{ number: 412 }]));
    const root = view.container.firstElementChild;
    expect(root?.getAttribute('class')).toBe('mrpr-root mrpr-details');
    expect(view.getByText(NUMBER(412))).toBeTruthy();
    const state = await view.findByText('Open');
    expect(state.getAttribute('class')).toBe('mrpr-details-word mrpr-details-state');
    expect(state.parentElement?.getAttribute('class')).toBe('mrpr-tone-open');
    // The checks in a few words, their long words as the tooltip; the icon says nothing more.
    const checks = (await view.findByText('checks passed')).parentElement;
    expect(checks?.getAttribute('title')).toBe('All checks have passed');
    expect(checks?.classList.contains('mrpr-tone-success')).toBe(true);
    expect(checks?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(view.queryByRole('img')).toBeNull();
    const title = view.getByText('Store sessions in Redis');
    expect(title.classList.contains('mrpr-details-title')).toBe(true);
    expect(view.getByText('+120')).toBeTruthy();
    expect(view.getByText('-30')).toBeTruthy();
    expect(view.getByText('5 files')).toBeTruthy();
    expect(view.getByText('2 hours ago')).toBeTruthy();
    // Neither the owner, the branches nor the author.
    expect(root?.textContent).not.toMatch(/mindroom-ai|→|redis-sessions|acme-builder|updated/);
    expect(view.queryByText('this worktree')).toBeNull();
    expect(view.container.querySelector('button, a, [tabindex]')).toBeNull();
  });

  it('shows only the repository and number while GitHub has not answered, and when it refuses', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    const waiting = await show(roomWith([{ number: 412 }]));
    await vi.waitFor(() => expect(requests('/pulls/412').length).toBe(1));
    expect(waiting.view.getByText(NUMBER(412))).toBeTruthy();
    expect(waiting.view.queryByRole('img')).toBeNull();
    expect(waiting.view.container.querySelector('.mrpr-tone-draft')).not.toBeNull();
    expect(waiting.view.container.querySelector('.mrpr-details-title')).toBeNull();
    waiting.view.unmount();

    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => respond({ message: 'Not Found' }, 404));
    const { view, client } = await show(roomWith([{ number: 412 }]));
    await answered(client, '/pulls/412');
    expect(view.container.firstElementChild?.textContent).toBe(NUMBER(412));
    expect(view.container.querySelector('.mrpr-details-title')).toBeNull();
  });

  it('shows the worktree with its label, its branch and its path, and the path alone without a branch', async () => {
    const withBranch = await show(
      roomWith([], [{ path: 'worktrees/redis-sessions', branch: 'redis-sessions' }])
    );
    const worktree = withBranch.view.container.querySelector('.mrpr-details-worktree');
    expect(worktree?.textContent).toBe('Worktreeredis-sessionsworktrees/redis-sessions');
    expect(blocks(withBranch.view)).toHaveLength(0);
    withBranch.view.unmount();

    const pathOnly = await show(roomWith([], [{ path: '/srv/worktrees/scratch', branch: '' }]));
    const alone = pathOnly.view.container.querySelector('.mrpr-details-worktree');
    expect(alone?.textContent).toBe('Worktree/srv/worktrees/scratch');
    expect(alone?.querySelectorAll('svg')).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks the pull request on the worktree's branch, which the worktree then leaves out", async () => {
    serve({ 412: pull(), 7: pull({ head: { sha: SHA, ref: 'other', repo: null } }) });
    const { view } = await show(
      roomWith(
        [{ number: 412 }, { number: 7 }],
        [{ path: 'worktrees/redis-sessions', branch: 'redis-sessions' }]
      )
    );
    const mark = await view.findByText('this worktree');
    expect(mark.closest('.mrpr-details-pull-request')).toBe(blocks(view)[0]);
    expect(blocks(view)[1]?.textContent).not.toContain('this worktree');
    const worktree = view.container.querySelector('.mrpr-details-worktree');
    expect(worktree?.textContent).toBe('Worktreeworktrees/redis-sessions');
  });

  it("keeps the worktree's branch when no pull request is on it", async () => {
    serve({ 412: pull() });
    const { view, client } = await show(
      roomWith([{ number: 412 }], [{ path: 'worktrees/x', branch: 'redis-sessions-v2' }])
    );
    await answered(client, '/pulls/412');
    expect(view.getByText('Store sessions in Redis')).toBeTruthy();
    expect(view.queryByText('this worktree')).toBeNull();
    const worktree = view.container.querySelector('.mrpr-details-worktree');
    expect(worktree?.textContent).toBe('Worktreeredis-sessions-v2worktrees/x');
  });

  it("shortens a worktree's long path in its middle, with the whole path as its tooltip", async () => {
    const path = '/home/basnijholt/repos/worktrees/mindroom-tool-row-started-at';
    const { view } = await show(roomWith([], [{ path, branch: '' }]));
    const shown = view.getByText(middleTruncate(path, 40));
    expect(middleTruncate(path, 40)).not.toBe(path);
    expect(shown.textContent?.endsWith('tool-row-started-at')).toBe(true);
    expect(shown.getAttribute('title')).toBe(path);
  });

  it('shows every pull request of the thread, also past the two its card shows', async () => {
    serve({
      412: pull({ title: 'First' }),
      7: pull({ title: 'Second' }),
      99: pull({ title: 'Third' }),
    });
    const { view } = await show(
      roomWith([{ number: 412 }, { number: 7 }, { number: 99 }], [{ path: 'worktrees/x' }])
    );
    await view.findByText('Third');
    const shown = blocks(view);
    expect(shown.map((block) => block.querySelector('.mrpr-details-title')?.textContent)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
    expect(shown[0]?.textContent).toContain(NUMBER(412));
    expect(shown[1]?.textContent).toContain(NUMBER(7));
    // The worktree comes after the pull requests.
    const last = view.container.firstElementChild?.lastElementChild;
    expect(last?.classList.contains('mrpr-details-worktree')).toBe(true);
  });

  it('asks GitHub nothing more for a pull request whose chip has loaded', async () => {
    saveToken();
    serve({ 412: pull() }, [run('success')]);
    const room = roomWith([{ number: 412 }]);
    const client = newClient();
    const card = await renderPluginComponent(
      <QueryClientProvider client={client}>
        <ThreadCardPullRequests room={room} threadId="$t1" />
      </QueryClientProvider>,
      { id: 'pull-requests', plugin }
    );
    await card.findByRole('img', { name: /: Open/ });
    await answered(client, '/check-runs');
    const asked = fetchMock.mock.calls.length;
    const { view } = await show(room, client);
    expect(view.getByText('checks passed')).toBeTruthy();
    expect(view.getByText('Store sessions in Redis')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.isFetching()).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(asked);
  });

  it("asks GitHub nothing more on a hover after its chip's answer went stale", async () => {
    saveToken();
    serve({ 412: pull() }, [run('success')]);
    const room = roomWith([{ number: 412 }]);
    const client = newClient();
    const card = await renderPluginComponent(
      <QueryClientProvider client={client}>
        <ThreadCardPullRequests room={room} threadId="$t1" />
      </QueryClientProvider>,
      { id: 'pull-requests', plugin }
    );
    await card.findByRole('img', { name: /: Open/ });
    await answered(client, '/check-runs');
    const asked = fetchMock.mock.calls.length;
    // Past the two minutes the chip's answers stay fresh; only the clock is fake.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 121_000);
    for (let hover = 0; hover < 2; hover += 1) {
      const { view } = await show(room, client);
      expect(view.getByText('checks passed')).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(client.isFetching()).toBe(0);
      view.unmount();
    }
    expect(fetchMock.mock.calls.length).toBe(asked);
  });

  it('asks nothing more on a hover after its chip was refused', async () => {
    const refusals: [string, () => void, number][] = [
      // A private pull request without a token, or a deleted one: GitHub says 404 and is not asked again.
      ['notFound', () => serve({}), 1],
      // A failed request is tried three times in all (`retry`), the test client without a delay.
      [
        'failed',
        () => fetchMock.mockImplementation(async () => respond({ message: 'Oops' }, 502)),
        3,
      ],
      ['network', () => fetchMock.mockRejectedValue(new TypeError('Failed to fetch')), 3],
    ];
    for (const [kind, refuse, tries] of refusals) {
      fetchMock.mockReset();
      refuse();
      const room = roomWith([{ number: 412 }]);
      const client = newClient();
      const card = await renderPluginComponent(
        <QueryClientProvider client={client}>
          <ThreadCardPullRequests room={room} threadId="$t1" />
        </QueryClientProvider>,
        { id: 'pull-requests', plugin }
      );
      await answered(client, '/pulls/412');
      expect([kind, fetchMock.mock.calls.length]).toEqual([kind, tries]);
      for (let hover = 0; hover < 3; hover += 1) {
        const { view } = await show(room, client);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await vi.waitFor(() => expect(client.isFetching()).toBe(0));
        view.unmount();
      }
      expect([kind, fetchMock.mock.calls.length]).toEqual([kind, tries]);
      card.unmount();
    }
  });
});
