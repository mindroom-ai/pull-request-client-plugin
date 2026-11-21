// @vitest-environment jsdom
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Room } from 'matrix-js-sdk';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from './index';
import PullRequestPanel from './PullRequestPanel';
import { pullRequestKey, refreshPullRequest, STALE_TIME } from './queries';
import { FakeIntersectionObserver, observers, report } from './testing/intersectionObserver';
import { linkedRoom, type TestLink, type TestWorktree } from './testing/linkedRoom';
import { githubServer } from './testing/mindroomServer';
import { ThreadCardPullRequests } from './ThreadCardPullRequests';
import { ThreadDetails } from './ThreadDetails';

const ROOM_ID = '!room:example.org';
// The thread `linkedRoom` links to unless told otherwise.
const THREAD = '$t1';

const page = vi.hoisted(() => ({
  panel: undefined as { isOpen: boolean; open: ReturnType<typeof vi.fn> } | undefined,
  navigateRoomThread: vi.fn(),
  /** How many times a card asked for the side panel. */
  panelReads: 0,
}));
// The room has no MindRoom server unless a test gives one: the stand-in client knows no room.
const roomServer = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@mindroom/client-sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mindroom/client-sdk/server')>()),
  useMindroomServerStatus: () => ({ server: roomServer.current, pending: false }),
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
  {
    onParentClick = vi.fn(),
    phone = false,
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  }: { onParentClick?: () => void; phone?: boolean; client?: QueryClient } = {}
) => {
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

const sampleRef = (number: number) => ({ owner: 'mindroom-ai', repo: 'sample-repo', number });

const held = () => {
  let release = () => {};
  const reply = new Promise<void>((resolve) => (release = resolve));
  return { reply, release };
};

const showCardWave = async () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  const links = Array.from({ length: 12 }, (_, i) => ({
    thread: `$sample${i + 1}`,
    repo: 'sample-repo',
    number: i + 1,
  }));
  const room = roomWith(links);
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  const wave = ({
    omit,
    panel,
    details,
  }: { omit?: number; panel?: number; details?: string } = {}) => (
    <QueryClientProvider client={client}>
      {links
        .filter(({ number }) => number !== omit)
        .map(({ thread }) => (
          <ThreadCardPullRequests key={thread} room={room} threadId={thread} />
        ))}
      {panel && <PullRequestPanel roomId={ROOM_ID} request={sampleRef(panel)} />}
      {details && <ThreadDetails room={room} threadId={details} />}
    </QueryClientProvider>
  );
  const view = await renderPluginComponent(wave(), { id: 'pull-requests', plugin });
  return {
    client,
    view,
    rerender: (options: Parameters<typeof wave>[0]) => view.rerender(wave(options)),
  };
};

const summaryNumbers = (urls: readonly string[]) =>
  urls.flatMap((url) => {
    const match = /\/pulls\/(\d+)$/.exec(url);
    return match ? [Number(match[1])] : [];
  });

const proxiedSummaries = (mindroom: ReturnType<typeof githubServer>) =>
  summaryNumbers(mindroom.githubRequests().map(({ path }) => path));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  observers.length = 0;
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
  roomServer.current = undefined;
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

  it('limits simultaneous proxied reads when many phone cards show at once', async () => {
    // Without an IntersectionObserver, all these chips are eligible to read at once.
    vi.stubGlobal('IntersectionObserver', undefined);
    const links = Array.from({ length: 8 }, (_, i) => ({
      thread: `$sample${i}`,
      repo: 'sample-repo',
      number: i + 1,
    }));
    const hidden = { ...links[0]!, number: links.length + 1 };
    const room = roomWith([...links, hidden]);
    let releaseSummaries = () => {};
    let releaseChecks = () => {};
    const summariesHeld = new Promise<void>((resolve) => (releaseSummaries = resolve));
    const checksHeld = new Promise<void>((resolve) => (releaseChecks = resolve));
    const mindroom = githubServer(async (url) => {
      if (url.includes('/pulls/')) {
        await summariesHeld;
        if (url.endsWith(`/pulls/${hidden.number}`)) return Response.json({ state: 'closed' });
        return Response.json({ title: 'Sample change', state: 'open', head: { sha: 'abc123' } });
      }
      await checksHeld;
      if (url.includes('/check-runs?')) {
        return Response.json({
          check_runs: [{ name: 'Build', status: 'completed', conclusion: 'success' }],
        });
      }
      return Response.json({ statuses: [] });
    });
    roomServer.current = mindroom.server;
    const client = new QueryClient();
    const view = await renderPluginComponent(
      <QueryClientProvider client={client}>
        {links.map(({ thread }) => (
          <ThreadCardPullRequests key={thread} room={room} threadId={thread} />
        ))}
      </QueryClientProvider>,
      { id: 'pull-requests', plugin, screenSize: 'Mobile' }
    );
    try {
      await vi.waitFor(() => expect(mindroom.githubRequests().length).toBeGreaterThanOrEqual(4));
      // Until some replies come back, the other PR reads must not reach the wire.
      expect(mindroom.githubRequests()).toHaveLength(4);
      releaseSummaries();
      const checks = () =>
        mindroom.githubRequests().filter(({ path }) => path.includes('/commits/'));
      await vi.waitFor(() => expect(checks().length).toBeGreaterThanOrEqual(8));
      expect(checks()).toHaveLength(8);
    } finally {
      releaseSummaries();
      releaseChecks();
    }
    await vi.waitFor(() => {
      expect(view.container.querySelectorAll('.mrpr-chip-checks')).toHaveLength(links.length);
      expect(client.isFetching()).toBe(0);
    });
    const requests = mindroom.githubRequests();
    expect(proxiedSummaries(mindroom)).toContain(hidden.number);
    expect(requests).toHaveLength(3 * links.length + 1);
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
    expect(
      mindroom.server.request.mock.calls.filter(
        ([path, init]) => path === '/api/github/request' && init?.method === 'POST'
      )
    ).toHaveLength(requests.length);
  });

  it('cancels a queued summary when only an unseen card still links to it', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const slots = held();
    const mindroom = githubServer(async () => {
      await slots.reply;
      return Response.json({ state: 'closed' });
    });
    roomServer.current = mindroom.server;
    const links = [1, 2, 3, 4, 5, 5].map((number, index) => ({
      ...sampleRef(number),
      thread: `$sample${index + 1}`,
    }));
    const room = roomWith(links);
    const client = new QueryClient();
    client.setQueryData(['pull-requests-github-status', mindroom.server.origin], {
      connected: true,
      login: 'octo',
      via: 'app',
    });
    const wave = (omitFifth = false) => (
      <QueryClientProvider client={client}>
        {links
          .filter((_link, index) => !omitFifth || index !== 4)
          .map(({ thread }) => (
            <ThreadCardPullRequests key={thread} room={room} threadId={thread} />
          ))}
      </QueryClientProvider>
    );
    const view = await renderPluginComponent(wave(), { id: 'pull-requests', plugin });
    try {
      const rows = [...view.container.querySelectorAll('.mrpr-thread-card-chips')].slice(0, 5);
      await act(async () => report(true, (target) => rows.includes(target)));
      const fifth = { queryKey: pullRequestKey(sampleRef(5)) };
      await vi.waitFor(() => expect(client.isFetching(fifth)).toBe(1));
      expect(proxiedSummaries(mindroom)).toEqual([1, 2, 3, 4]);
      view.rerender(wave(true));
      expect(client.isFetching(fifth)).toBe(0);
    } finally {
      slots.release();
    }
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    expect(proxiedSummaries(mindroom)).toEqual([1, 2, 3, 4]);
  });

  const interactiveSurfaces = ['side panel', 'thread actions menu', 'chip hover card'] as const;
  it.each(interactiveSurfaces)('does not queue %s reads', async (surface) => {
    const cards = held();
    const mindroom = githubServer(async (url) => {
      if (url.endsWith('/pulls/12')) {
        return Response.json({ title: 'Sample change', state: 'open', head: { sha: 'abc12' } });
      }
      if (summaryNumbers([url]).length) {
        await cards.reply;
        return Response.json({ state: 'closed' });
      }
      if (url.includes('/commits/abc12/')) return Response.json({});
      return Response.json({}, { status: 404 });
    });
    roomServer.current = mindroom.server;
    const { client, rerender, view } = await showCardWave();
    try {
      await vi.waitFor(() => expect(proxiedSummaries(mindroom)).toEqual([1, 2, 3, 4]));
      if (surface === 'side panel') rerender({ panel: 12 });
      else if (surface === 'thread actions menu') rerender({ details: '$sample12' });
      else {
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query }));
        const chip = view.getByRole('img', { name: 'Pull request mindroom-ai/sample-repo #12' });
        await act(async () => chip.dispatchEvent(new MouseEvent('mouseenter')));
        await view.findByRole('tooltip');
      }
      await vi.waitFor(() => {
        expect(proxiedSummaries(mindroom)).toEqual([1, 2, 3, 4, 12]);
        expect(
          mindroom.githubRequests().filter(({ path }) => path.includes('/commits/abc12/'))
        ).toHaveLength(2);
      });
    } finally {
      cards.release();
    }
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    expect(proxiedSummaries(mindroom).filter((number) => number === 12)).toEqual([12]);
  });

  it.each([false, true])(
    'prioritizes a post-write refresh without a panel (offline: %s)',
    async (offline) => {
      const cards = held();
      const mindroom = githubServer(async (url) => {
        if (!url.endsWith('/pulls/12')) await cards.reply;
        return Response.json({ state: 'closed' });
      });
      roomServer.current = mindroom.server;
      const { client } = await showCardWave();
      const ref = sampleRef(12);
      const access = `server:${mindroom.server.origin}:octo:0`;
      const cacheKey = [...pullRequestKey(ref), access];
      try {
        await vi.waitFor(() => expect(proxiedSummaries(mindroom)).toEqual([1, 2, 3, 4]));
        if (offline) {
          // With a cached answer, post-write invalidation replaces the waiting read with a fresh one.
          client.setQueryData(cacheKey, { state: 'open' });
          onlineManager.setOnline(false);
        }
        const refresh = refreshPullRequest(client, ref, access);
        if (offline) {
          await refresh;
          expect(client.getQueryState(cacheKey)?.fetchStatus).toBe('paused');
          onlineManager.setOnline(true);
        }
        await vi.waitFor(() => {
          expect(proxiedSummaries(mindroom)).toEqual([1, 2, 3, 4, 12]);
          expect(client.getQueryData(cacheKey)).toMatchObject({ state: 'closed' });
        });
        await expect(refresh).resolves.toBe(true);
      } finally {
        onlineManager.setOnline(true);
        cards.release();
      }
      await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    }
  );

  it.each([
    { name: 'skips an unmounted queued chip and keeps draining', omit: 5, status: 200, next: 6 },
    { name: 'frees the slot when a read fails', omit: undefined, status: 500, next: 5 },
  ])('$name', async ({ omit, status, next }) => {
    const first = held();
    const rest = held();
    const mindroom = githubServer(async (url) => {
      const isFirst = url.endsWith('/pulls/1');
      await (isFirst ? first.reply : rest.reply);
      return Response.json({ state: 'closed' }, { status: isFirst ? status : 200 });
    });
    roomServer.current = mindroom.server;
    const { client, rerender } = await showCardWave();
    try {
      await vi.waitFor(() => expect(proxiedSummaries(mindroom)).toEqual([1, 2, 3, 4]));
      if (omit) rerender({ omit });
      first.release();
      await vi.waitFor(() => expect(proxiedSummaries(mindroom)).toEqual([1, 2, 3, 4, next]));
    } finally {
      first.release();
      rest.release();
    }
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    const requested = proxiedSummaries(mindroom);
    if (omit) expect(requested).not.toContain(omit);
    expect(requested).toContain(12);
  });

  it('does not cap chip reads made directly with a browser token', async () => {
    localStorage.setItem(
      'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/githubToken',
      'ghp_test'
    );
    const cards = held();
    fetchMock.mockImplementation(async () => {
      await cards.reply;
      return Response.json({ state: 'closed' });
    });
    const { client } = await showCardWave();
    try {
      await vi.waitFor(() => {
        const urls = fetchMock.mock.calls.map(([url]) => url);
        expect(summaryNumbers(urls)).toHaveLength(12);
        expect(urls.every((url) => url.startsWith('https://api.github.com/'))).toBe(true);
        expect(
          fetchMock.mock.calls.every(
            ([, init]) => new Headers(init?.headers).get('Authorization') === 'Bearer ghp_test'
          )
        ).toBe(true);
      });
    } finally {
      cards.release();
    }
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
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

  it.each([
    { screen: 'a phone', phone: true, states: ['merged', 'open'], shown: ['#2'] },
    { screen: 'desktop', phone: false, states: ['merged', 'closed', 'open'], shown: ['#3', '#2'] },
  ])('shows open pull requests first on $screen', async ({ phone, states, shown }) => {
    const links = states.map((_state, index) => ({ number: index + 1 }));
    const mindroom = githubServer(async (url) => {
      const [number] = summaryNumbers([url]);
      const state = states[number! - 1];
      return Response.json({
        state: state === 'merged' ? 'closed' : state,
        merged_at: state === 'merged' ? '2026-11-18T10:00:00Z' : null,
      });
    });
    roomServer.current = mindroom.server;
    const view = await show(roomWith(links), { phone });
    await vi.waitFor(() => expect(chips(view).map((chip) => chip.textContent)).toEqual(shown));
    expect(view.getByRole('img', { name: '1 more pull request' }).textContent).toBe('+1');
    expect(proxiedSummaries(mindroom).toSorted((a, b) => a - b)).toEqual(
      links.map(({ number }) => number)
    );
  });

  it.each([1, 2])('keeps link order while a summary loads, then shows open #%s', async (open) => {
    const first = held();
    const mindroom = githubServer(async (url) => {
      const [number] = summaryNumbers([url]);
      if (number === 1) await first.reply;
      return Response.json(
        number === open ? { state: 'open' } : { state: 'closed', merged_at: '2026-11-18T10:00:00Z' }
      );
    });
    roomServer.current = mindroom.server;
    const client = new QueryClient();
    const view = await show(roomWith([1, 2].map(sampleRef)), { phone: true, client });
    const second = [...pullRequestKey(sampleRef(2)), `server:${mindroom.server.origin}:octo:0`];
    try {
      await vi.waitFor(() => expect(client.getQueryState(second)?.status).toBe('success'));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(chips(view).map((chip) => chip.textContent)).toEqual(['#1']);
    } finally {
      first.release();
    }
    await view.findByRole('img', { name: `Pull request mindroom-ai/sample-repo #${open}: Open` });
  });

  it('waits for the chip row to be on screen before reading hidden summaries', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const mindroom = githubServer(async () => Response.json({ state: 'closed' }));
    roomServer.current = mindroom.server;
    const client = new QueryClient();
    const view = await show(roomWith([1, 2].map(sampleRef)), { phone: true, client });
    await vi.waitFor(() => expect(mindroom.statusRequests()).toBe(1));
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    expect(proxiedSummaries(mindroom)).toEqual([]);
    const row = view.container.querySelector('.mrpr-thread-card-chips');
    expect(row).not.toBeNull();
    await act(async () => report(true, (target) => target === row));
    await vi.waitFor(() => expect(proxiedSummaries(mindroom)).toEqual([1, 2]));
    await act(async () => report(true));
    await view.findByRole('img', { name: 'Pull request mindroom-ai/sample-repo #1: Closed' });
    expect(proxiedSummaries(mindroom)).toEqual([1, 2]);
  });

  it.each([false, true])(
    'does not retry a refused hidden summary on remount (prior answer: %s)',
    async (priorAnswer) => {
      const mindroom = githubServer(async (url) =>
        url.endsWith('/pulls/2')
          ? Response.json({}, { status: 404 })
          : Response.json({ state: 'open' })
      );
      roomServer.current = mindroom.server;
      const client = new QueryClient();
      const key = [...pullRequestKey(sampleRef(2)), `server:${mindroom.server.origin}:octo:0`];
      if (priorAnswer) {
        client.setQueryData(key, { state: 'closed' }, { updatedAt: Date.now() - STALE_TIME - 1 });
      }
      const room = roomWith([1, 2].map(sampleRef));
      const options = { phone: true, client };
      const view = await show(room, options);
      await vi.waitFor(() => expect(client.getQueryState(key)?.status).toBe('error'));
      view.unmount();
      await show(room, options);
      await vi.waitFor(() => expect(client.isFetching()).toBe(0));
      expect(proxiedSummaries(mindroom).toSorted()).toEqual([1, 2]);
    }
  );

  it('keeps link order and does not read hidden pull requests anonymously with an empty cache', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ state: 'closed', merged_at: '2026-11-18T10:00:00Z' })
    );
    const view = await show(roomWith([{ number: 1 }, { number: 2 }]), { phone: true });
    await view.findByRole('img', { name: 'Pull request mindroom-ai/mindroom-chat #1: Merged' });
    expect(chips(view).map((chip) => chip.textContent)).toEqual(['#1']);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/mindroom-ai/mindroom-chat/pulls/1',
    ]);
  });

  it('orders anonymous chips by cached answers without fetching hidden links', async () => {
    const client = new QueryClient();
    client.setQueryData([...pullRequestKey(sampleRef(2)), false], { state: 'open' });
    const view = await show(roomWith([1, 2].map(sampleRef)), { phone: true, client });
    await view.findByRole('img', { name: 'Pull request mindroom-ai/sample-repo #2: Open' });
    expect(chips(view).map((chip) => chip.textContent)).toEqual(['#2']);
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("says in a chip's hover card that a click opens the side panel, only in a room page", async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query }));
    // The card's text, once a mouse rested on the chip; the card goes when the mouse leaves.
    const hintOf = async (view: Awaited<ReturnType<typeof show>>) => {
      const chip = chips(view)[0]!;
      await act(async () => {
        chip.dispatchEvent(new MouseEvent('mouseenter'));
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      const card = document.querySelector('[role="tooltip"]');
      expect(card).not.toBeNull();
      const hint = card?.querySelector('.mrpr-hover-hint')?.textContent ?? null;
      await act(async () => chip.dispatchEvent(new MouseEvent('mouseleave')));
      view.unmount();
      return hint;
    };
    expect(await hintOf(await show(roomWith([{ number: 1 }])))).toBe(
      'Click to open in the side panel'
    );
    page.panel = undefined;
    expect(await hintOf(await show(roomWith([{ number: 1 }])))).toBeNull();
  });

  it('has no button, link or tab stop', async () => {
    const view = await show(roomWith([{ number: 1 }, { number: 2 }, { number: 3 }]));
    expect(chips(view)).toHaveLength(2);
    expect(view.getByTestId('card').querySelector('button, a, [tabindex]')).toBeNull();
  });
});
