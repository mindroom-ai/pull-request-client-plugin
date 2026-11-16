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
  vi.unstubAllGlobals();
});

describe('ThreadDetails', () => {
  it("is the plugin's thread details, for threads with a link or a worktree", () =>
    expect(plugin.threadDetails).toEqual([{ shows: threadHasDetails, Component: ThreadDetails }]));

  it('shows a loaded pull request: repository and number with its state and checks, title, branches, size, author and age', async () => {
    saveToken();
    serve({ 412: pull() }, [run('success')]);
    const { view } = await show(roomWith([{ number: 412 }]));
    const root = view.container.firstElementChild;
    expect(root?.getAttribute('class')).toBe('mrpr-root mrpr-details');
    expect(view.getByText(`${REPOSITORY} #412`)).toBeTruthy();
    await view.findByRole('img', { name: 'Open' });
    await view.findByRole('img', { name: 'All checks have passed' });
    const title = view.getByText('Store sessions in Redis');
    expect(title.classList.contains('mrpr-details-title')).toBe(true);
    expect(view.getByText('redis-sessions → main')).toBeTruthy();
    expect(view.getByText('+120')).toBeTruthy();
    expect(view.getByText('-30')).toBeTruthy();
    expect(view.getByText('5 files')).toBeTruthy();
    expect(view.getByText('@acme-builder')).toBeTruthy();
    expect(view.getByText('updated 2 hours ago')).toBeTruthy();
    expect(view.container.querySelector('button, a, [tabindex]')).toBeNull();
  });

  it('shows only the repository and number while GitHub has not answered, and when it refuses', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    const waiting = await show(roomWith([{ number: 412 }]));
    await vi.waitFor(() => expect(requests('/pulls/412').length).toBe(1));
    expect(waiting.view.getByText(`${REPOSITORY} #412`)).toBeTruthy();
    expect(waiting.view.queryByRole('img')).toBeNull();
    expect(waiting.view.container.querySelector('.mrpr-tone-draft')).not.toBeNull();
    expect(waiting.view.container.querySelector('.mrpr-details-title')).toBeNull();
    waiting.view.unmount();

    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => respond({ message: 'Not Found' }, 404));
    const { view, client } = await show(roomWith([{ number: 412 }]));
    await answered(client, '/pulls/412');
    expect(view.getByText(`${REPOSITORY} #412`)).toBeTruthy();
    expect(view.queryByRole('img', { name: 'Open' })).toBeNull();
    expect(view.container.querySelector('.mrpr-details-title')).toBeNull();
    expect(view.queryByText(/→/)).toBeNull();
  });

  it("names a fork's head with its owner, and a deleted fork's head without one", async () => {
    serve({
      412: pull({
        head: { sha: SHA, ref: 'fix-typo', repo: { full_name: 'contributor/mindroom-chat' } },
      }),
      413: pull({ head: { sha: SHA, ref: 'fix-typo', repo: null } }),
    });
    const fork = await show(roomWith([{ number: 412 }]));
    expect(await fork.view.findByText('contributor:fix-typo → main')).toBeTruthy();
    fork.view.unmount();
    const deleted = await show(roomWith([{ number: 413 }]));
    expect(await deleted.view.findByText('fix-typo → main')).toBeTruthy();
  });

  it('middle-truncates long branch names', async () => {
    const ref = 'feature/a-very-long-branch-name-for-details';
    serve({ 412: pull({ head: { sha: SHA, ref, repo: { full_name: REPOSITORY } } }) });
    const { view } = await show(roomWith([{ number: 412 }]));
    expect(await view.findByText(`${middleTruncate(ref, 24)} → main`)).toBeTruthy();
    expect(middleTruncate(ref, 24)).not.toBe(ref);
  });

  it("middle-truncates a fork's head together with its owner", async () => {
    const owner = 'a-very-long-contributor-name';
    serve({
      412: pull({
        head: { sha: SHA, ref: 'fix-typo', repo: { full_name: `${owner}/mindroom-chat` } },
      }),
    });
    const { view } = await show(roomWith([{ number: 412 }]));
    const head = middleTruncate(`${owner}:fix-typo`, 24);
    expect(await view.findByText(`${head} → main`)).toBeTruthy();
    expect(head).not.toBe(`${owner}:fix-typo`);
  });

  it('shows the worktree with its branch and its path, and the path alone without a branch', async () => {
    const withBranch = await show(
      roomWith([], [{ path: 'worktrees/redis-sessions', branch: 'redis-sessions' }])
    );
    const worktree = withBranch.view.container.querySelector('.mrpr-details-worktree');
    expect(worktree?.textContent).toBe('redis-sessionsworktrees/redis-sessions');
    expect(blocks(withBranch.view)).toHaveLength(0);
    withBranch.view.unmount();

    const pathOnly = await show(roomWith([], [{ path: '/srv/worktrees/scratch', branch: '' }]));
    const alone = pathOnly.view.container.querySelector('.mrpr-details-worktree');
    expect(alone?.textContent).toBe('/srv/worktrees/scratch');
    expect(alone?.querySelectorAll('svg')).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(shown[0]?.textContent).toContain(`${REPOSITORY} #412`);
    expect(shown[1]?.textContent).toContain(`${REPOSITORY} #7`);
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
    expect(view.getByRole('img', { name: 'All checks have passed' })).toBeTruthy();
    expect(view.getByText('Store sessions in Redis')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.isFetching()).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(asked);
  });
});
