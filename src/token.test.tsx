// @vitest-environment jsdom
import type { ReactNode } from 'react';
import {
  CancelledError,
  focusManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { createClient } from 'matrix-js-sdk';
import { act } from 'react-dom/test-utils';
import { MindroomServerError, type MindroomServer } from '@mindroom/client-sdk/server';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubViaServer } from './github';
import plugin from './index';
import { usePullRequest } from './queries';
import { githubServer } from './testing/mindroomServer';
import {
  GitHubServerContext,
  RemoveServerToken,
  RoomGitHub,
  TokenForm,
  useGitHubAccess,
  type GitHubAccess,
} from './token';

// Where `usePluginStorage` keeps the GitHub token of the test's account.
const TOKEN_KEY = 'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/githubToken';
const ORIGIN = 'https://mindroom.example.org';

// Polls outside React's act environment, so that what the answered requests change renders.
const waitUntil = async (check: () => void) => {
  const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  scope.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(check);
  } finally {
    scope.IS_REACT_ACT_ENVIRONMENT = true;
  }
};

/** A MindRoom server whose `/api/github/status` answers `status()`. */
const serverWith = (status: () => Promise<unknown>) => {
  const request = vi.fn((path: string) =>
    path === '/api/github/status' ? status() : Promise.reject(new Error(`unexpected ${path}`))
  );
  return { origin: ORIGIN, request } as unknown as MindroomServer & { request: typeof request };
};

const accesses: Record<string, GitHubAccess> = {};
function Probe({ name }: { name: string }) {
  accesses[name] = useGitHubAccess();
  return null;
}
const REF = { owner: 'o', repo: 'r', number: 7 };
const apiPull = { title: 'T', state: 'open', html_url: 'https://github.com/o/r/pull/7' };
/** Reads one pull request, as a chip does. */
function Reader() {
  accesses.reader = useGitHubAccess();
  return <>{usePullRequest(REF).data?.title}</>;
}
/** Reads the same pull request, its title in the element `name`. */
function NamedReader({ name }: { name: string }) {
  accesses[name] = useGitHubAccess();
  return <span data-testid={name}>{usePullRequest(REF).data?.title}</span>;
}

let client: QueryClient;
const tree = (server: MindroomServer | undefined, children: ReactNode, pending = false) => (
  <QueryClientProvider client={client}>
    <GitHubServerContext.Provider value={{ server, pending }}>
      {children}
    </GitHubServerContext.Provider>
  </QueryClientProvider>
);
const show = (server: MindroomServer | undefined, children: ReactNode = <Probe name="a" />) =>
  renderPluginComponent(tree(server, children), { id: 'pull-requests', plugin });

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  localStorage.removeItem(TOKEN_KEY);
});

afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
});

describe('useGitHubAccess', () => {
  it('is anonymous without a server or a token, and asks nothing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await show(undefined);
    const { a } = accesses;
    expect(a).toMatchObject({ via: undefined, key: false, pending: false, login: undefined });
    expect(a?.current().auth).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("goes through the server once it says the person's GitHub is connected", async () => {
    const server = serverWith(() => Promise.resolve({ connected: true, login: 'octo' }));
    await show(
      server,
      <>
        <Probe name="a" />
        <Probe name="b" />
      </>
    );
    expect(accesses.a).toMatchObject({ via: undefined, pending: true });
    await waitUntil(() => expect(accesses.a?.via).toBe('server'));
    expect(accesses.a).toMatchObject({
      key: `server:${ORIGIN}:octo`,
      login: 'octo',
      pending: false,
    });
    expect(accesses.b?.via).toBe('server');
    // One status for the server, however many parts ask.
    expect(server.request).toHaveBeenCalledTimes(1);
    const auth = accesses.a?.current().auth as GitHubViaServer;
    expect(auth.server).toBe(server);
    // The rate limit's budget is the account's, never a token.
    expect(auth.account).toBe('@plugin-tester:example.org octo');
  });

  it('reads anew, under its own keys, once the connected login changes', async () => {
    let login = 'alice';
    const server = serverWith(() => Promise.resolve({ connected: true, login }));
    await show(server);
    await waitUntil(() => expect(accesses.a?.key).toBe(`server:${ORIGIN}:alice`));
    // Alice's permissions, fresh for ten minutes.
    const alices = ['pull-requests', 'repo', 'o', 'r', `server:${ORIGIN}:alice`];
    client.setQueryData(alices, { canWrite: true });
    login = 'bob';
    await act(() => accesses.a?.recheck());
    await waitUntil(() => expect(accesses.a?.key).toBe(`server:${ORIGIN}:bob`));
    expect(accesses.a?.login).toBe('bob');
    expect(client.getQueryState(alices)?.isInvalidated).toBe(true);
  });

  it('reads anew when the connection comes back, also without a login', async () => {
    let status: unknown = { connected: true };
    const server = serverWith(() => Promise.resolve(status));
    await show(server);
    await waitUntil(() => expect(accesses.a?.key).toBe(`server:${ORIGIN}:unknown`));
    const read = ['pull-requests', 'pr', 'o', 'r', 7, `server:${ORIGIN}:unknown`];
    client.setQueryData(read, { title: 'T' });
    status = { connected: false };
    await act(() => accesses.a?.recheck());
    await waitUntil(() => expect(accesses.a?.via).toBeUndefined());
    expect(client.getQueryState(read)?.isInvalidated).toBe(true);
    client.setQueryData(read, { title: 'T' });
    status = { connected: true };
    await act(() => accesses.a?.recheck());
    await waitUntil(() => expect(accesses.a?.via).toBe('server'));
    expect(client.getQueryState(read)?.isInvalidated).toBe(true);
  });

  it('is pending while the room does not know its server yet, and reads nothing', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(apiPull))));
    vi.stubGlobal('fetch', fetchMock);
    const server = serverWith(() => Promise.resolve({ connected: true, login: 'octo' }));
    server.request.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/api/github/status'
          ? { connected: true, login: 'octo' }
          : { status: 200, body: apiPull, headers: {} }
      )
    );
    const view = await renderPluginComponent(tree(undefined, <Reader />, true), {
      id: 'pull-requests',
      plugin,
    });
    expect(accesses.reader?.pending).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    view.rerender(tree(server, <Reader />));
    await waitUntil(() => expect(view.getByText('T')).toBeTruthy());
    // Not one read went to GitHub without the account first.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the token stored in the browser first, without asking the server', async () => {
    localStorage.setItem(TOKEN_KEY, 'ghp_test');
    const server = serverWith(() => Promise.resolve({ connected: true, login: 'octo' }));
    await show(server);
    expect(accesses.a).toMatchObject({ via: 'token', key: true, pending: false });
    expect(accesses.a?.current().auth).toBe('ghp_test');
    expect(server.request).not.toHaveBeenCalled();
  });

  it.each([
    ['not connected', () => Promise.resolve({ connected: false })],
    [
      'unavailable',
      () => Promise.reject(new MindroomServerError('Unavailable', 503, { error: 'x' })),
    ],
  ])('is anonymous while the server says %s', async (_, status) => {
    const server = serverWith(status);
    await show(server);
    await waitUntil(() => expect(accesses.a?.pending).toBe(false));
    expect(accesses.a).toMatchObject({ via: undefined, key: false });
    expect(accesses.a?.current().auth).toBeUndefined();
  });

  it('drops to anonymous once the server says the connection went away', async () => {
    const server = serverWith(() => Promise.resolve({ connected: true, login: 'octo' }));
    await show(server);
    await waitUntil(() => expect(accesses.a?.via).toBe('server'));
    const auth = accesses.a?.current().auth as GitHubViaServer;
    act(() => auth.disconnected());
    await waitUntil(() => expect(accesses.a?.via).toBeUndefined());
    expect(accesses.a?.key).toBe(false);
    expect(accesses.a?.current().auth).toBeUndefined();
  });

  it('asks the status again on focus half a minute after the connection went away', async () => {
    const server = serverWith(() => Promise.resolve({ connected: true, login: 'octo' }));
    await show(server);
    await waitUntil(() => expect(accesses.a?.via).toBe('server'));
    act(() => (accesses.a?.current().auth as GitHubViaServer).disconnected());
    await waitUntil(() => expect(accesses.a?.via).toBeUndefined());
    expect(server.request).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10_000 });
    try {
      // Not at once: a server whose status and requests disagree cannot keep the parts switching.
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      expect(server.request).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 30_000);
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      await waitUntil(() => expect(accesses.a?.via).toBe('server'));
      expect(server.request).toHaveBeenCalledTimes(2);
    } finally {
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });
});

describe('a change of the connection', () => {
  const PULL = ['pull-requests', 'pr', 'o', 'r', 7] as const;
  /** Every title the cache stores under the pull request's key for `access`, as it stores it. */
  const titlesUnder = (access: boolean | string) => {
    const titles: string[] = [];
    const key = JSON.stringify([...PULL, access]);
    client.getQueryCache().subscribe(({ query }) => {
      const title = (query.state.data as { title?: string } | undefined)?.title;
      if (JSON.stringify(query.queryKey) === key && title !== undefined) titles.push(title);
    });
    return titles;
  };
  /** Reads the pull request in a room with `server`, or none. */
  const room = (name: string, server: MindroomServer | undefined) => (
    <GitHubServerContext.Provider value={{ server, pending: false }}>
      <NamedReader name={name} />
    </GitHubServerContext.Provider>
  );
  const rooms = (children: ReactNode) =>
    renderPluginComponent(<QueryClientProvider client={client}>{children}</QueryClientProvider>, {
      id: 'pull-requests',
      plugin,
    });
  /**
   * A server that reads the pull request as `login()`, the title saying whose read it was, after
   * `delay` ms.
   */
  const serverAs = (login: () => string | undefined, delay = 5) => {
    const server = serverWith(() => Promise.resolve({ connected: true }));
    server.request.mockImplementation(async (path: string) => {
      const now = login();
      if (path === '/api/github/status') return { connected: now !== undefined, login: now };
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return { status: 200, body: { ...apiPull, title: `read as ${now}` }, headers: {} };
    });
    return server;
  };

  it('never stores what the server read under the anonymous key a room without one shows', async () => {
    // Anonymously, the private pull request is not there.
    const notFound = () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(notFound()))
    );
    let login: string | undefined;
    const server = serverAs(() => login);
    const anonymous = titlesUnder(false);
    const view = await rooms(
      <>
        {room('plain', undefined)}
        {room('served', server)}
      </>
    );
    await waitUntil(() => expect(client.getQueryState([...PULL, false])?.status).toBe('error'));
    login = 'octo';
    await act(() => accesses.served?.recheck());
    await waitUntil(() => expect(view.getByTestId('served').textContent).toBe('read as octo'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view.getByTestId('plain').textContent).toBe('');
    expect(anonymous).toEqual([]);
    // The room without a server, shown alone, has still only what it may read.
    view.rerender(
      <QueryClientProvider client={client}>{room('plain', undefined)}</QueryClientProvider>
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view.getByTestId('plain').textContent).toBe('');
    expect(anonymous).toEqual([]);
  });

  it("never stores one login's reads under another's key", async () => {
    let login = 'alice';
    // Answered before the parts render the new login's keys.
    const server = serverAs(() => login, 0);
    const alices = titlesUnder(`server:${ORIGIN}:alice`);
    const bobs = titlesUnder(`server:${ORIGIN}:bob`);
    const view = await rooms(room('served', server));
    await waitUntil(() => expect(view.getByTestId('served').textContent).toBe('read as alice'));
    login = 'bob';
    await act(() => accesses.served?.recheck());
    await waitUntil(() => expect(view.getByTestId('served').textContent).toBe('read as bob'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(alices.filter((title) => title !== 'read as alice')).toEqual([]);
    expect(bobs.filter((title) => title !== 'read as bob')).toEqual([]);
  });

  it('gives a read only the access its key names', async () => {
    const server = serverAs(() => 'alice');
    await rooms(room('served', server));
    await waitUntil(() => expect(accesses.served?.key).toBe(`server:${ORIGIN}:alice`));
    const access = accesses.served as GitHubAccess;
    expect(access.authFor(false)).toBeUndefined();
    expect((access.authFor(`server:${ORIGIN}:alice`) as GitHubViaServer).server).toBe(server);
    // Another login's key, or the token's while none is stored, is not read at all.
    expect(() => access.authFor(`server:${ORIGIN}:bob`)).toThrow(CancelledError);
    expect(() => access.authFor(true)).toThrow(CancelledError);
  });
});

describe('recheck', () => {
  it('says nothing changed when a status that had failed now says not connected', async () => {
    let status: () => Promise<unknown> = () =>
      Promise.reject(new MindroomServerError('Unavailable', 503, { error: 'x' }));
    const server = serverWith(() => status());
    await show(server);
    await waitUntil(() => expect(accesses.a?.pending).toBe(false));
    status = () => Promise.resolve({ connected: false });
    let changed: boolean | undefined;
    await act(async () => {
      changed = await accesses.a?.recheck();
    });
    // So Try again reads again itself: nothing else does.
    expect(changed).toBe(false);
  });

  it('says it changed when a status that had failed now says connected', async () => {
    let status: () => Promise<unknown> = () =>
      Promise.reject(new MindroomServerError('Unavailable', 503, { error: 'x' }));
    const server = serverWith(() => status());
    await show(server);
    await waitUntil(() => expect(accesses.a?.pending).toBe(false));
    status = () => Promise.resolve({ connected: true, login: 'octo' });
    let changed: boolean | undefined;
    await act(async () => {
      changed = await accesses.a?.recheck();
    });
    expect(changed).toBe(true);
  });
});

describe('RoomGitHub', () => {
  it('gives no server in a room without a MindRoom agent, so no status is asked', async () => {
    // The homeserver, asked whether it binds sign-in tokens, says it does not.
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(new Response(JSON.stringify({ versions: [] })))
    );
    vi.stubGlobal('fetch', fetchMock);
    const matrix = createClient({
      baseUrl: 'https://example.org',
      userId: '@plugin-tester:example.org',
    });
    await renderPluginComponent(
      <QueryClientProvider client={client}>
        <RoomGitHub roomId="!room:example.org">
          <Probe name="a" />
        </RoomGitHub>
      </QueryClientProvider>,
      { id: 'pull-requests', plugin, client: matrix }
    );
    await waitUntil(() => expect(accesses.a).toMatchObject({ via: undefined, pending: false }));
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/api/github'))).toBe(false);
  });
});

describe('the token saved in MindRoom', () => {
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  /**
   * GitHub knows `ghp_good` as `octo`, the App's login too, and `ghp_other` as `other`; it
   * fails for `ghp_down` and refuses any other token. The pull request's title says how it was read.
   */
  const github = async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization');
    if (url === 'https://api.github.com/user') {
      if (auth === 'Bearer ghp_good') return respond({ login: 'octo' });
      if (auth === 'Bearer ghp_other') return respond({ login: 'other' });
      if (auth === 'Bearer ghp_down') return respond({ message: 'Server Error' }, 500);
      return respond({ message: 'Bad credentials' }, 401);
    }
    return respond({ ...apiPull, title: auth ? 'with the token' : 'with the App' });
  };
  const type = (field: HTMLElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const click = (element: HTMLElement) => act(async () => element.click());
  const HOST = 'mindroom.example.org';
  /** Chooses to save the token in MindRoom, which the form never does by itself. */
  const chooseMindroom = (view: Awaited<ReturnType<typeof show>>) =>
    click(view.getByLabelText(`Save in MindRoom at ${HOST}`));
  /** The form and a reader of the pull request, in a room with `server`, or none. */
  const form = (server: MindroomServer | undefined) =>
    show(
      server,
      <>
        <TokenForm reason="override" />
        <NamedReader name="reader" />
      </>
    );
  const save = async (view: Awaited<ReturnType<typeof show>>, token: string) => {
    await type(view.getByLabelText('GitHub token'), token);
    await click(view.getByRole('button', { name: 'Save' }));
  };
  /** Whether `token` is kept anywhere it must never be: the cache or the browser's storage. */
  const kept = (token: string) =>
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map(({ queryKey, state }) => [queryKey, state.data])
    ).includes(token) || localStorage.getItem(TOKEN_KEY) !== null;
  /** Whether `token` is anywhere it must never be once saved: the page, the cache, the storage. */
  const leaked = (token: string) => document.body.innerHTML.includes(token) || kept(token);
  const field = (view: Awaited<ReturnType<typeof show>>) =>
    view.getByLabelText('GitHub token') as HTMLInputElement;
  /** Makes `mindroom` answer a request for the token with `answer`, its other routes as before. */
  const answerToken = (
    mindroom: ReturnType<typeof githubServer>,
    answer: (init?: RequestInit) => Promise<unknown>
  ) => {
    const routes = mindroom.server.request.getMockImplementation()!;
    mindroom.server.request.mockImplementation((path: string, init?: RequestInit) =>
      path === '/api/github/token' ? answer(init) : routes(path, init)
    );
  };

  it('names the way MindRoom reaches GitHub, an older server that does not say it being the App', async () => {
    await show(serverWith(() => Promise.resolve({ connected: true, login: 'octo' })));
    await waitUntil(() => expect(accesses.a?.connection).toBe('app'));
    expect(accesses.a).toMatchObject({ via: 'server', appConnected: false });
  });

  it('keeps the token in this browser unless MindRoom is chosen, and names where MindRoom is', async () => {
    const mindroom = githubServer(github);
    const view = await form(mindroom.server);
    await waitUntil(() => expect(accesses.reader?.connection).toBe('app'));
    expect((view.getByLabelText('Only this browser') as HTMLInputElement).checked).toBe(true);
    expect((view.getByLabelText(`Save in MindRoom at ${HOST}`) as HTMLInputElement).checked).toBe(
      false
    );
    await save(view, 'ghp_mine');
    await waitUntil(() => expect(accesses.reader?.via).toBe('token'));
    expect(localStorage.getItem(TOKEN_KEY)).toBe('ghp_mine');
    expect(mindroom.tokenRequests()).toEqual([]);
  });

  it("goes back to this browser alone once the room's MindRoom server is another", async () => {
    const mindroom = githubServer(github);
    const other = githubServer(github, undefined, 'https://other.example.net');
    const view = await form(mindroom.server);
    await waitUntil(() => expect(accesses.reader?.connection).toBe('app'));
    await chooseMindroom(view);
    view.rerender(
      tree(
        other.server,
        <>
          <TokenForm reason="override" />
          <NamedReader name="reader" />
        </>
      )
    );
    expect((view.getByLabelText('Only this browser') as HTMLInputElement).checked).toBe(true);
    expect(view.queryByLabelText(`Save in MindRoom at ${HOST}`)).toBeNull();
    expect(
      (view.getByLabelText('Save in MindRoom at other.example.net') as HTMLInputElement).checked
    ).toBe(false);
    await save(view, 'ghp_mine');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('ghp_mine');
    expect(mindroom.tokenRequests()).toEqual([]);
    expect(other.tokenRequests()).toEqual([]);
  });

  it('saves in MindRoom when chosen, keeps the key of the same login, and reads again with it', async () => {
    const mindroom = githubServer(github);
    const view = await form(mindroom.server);
    await waitUntil(() => expect(view.getByTestId('reader').textContent).toBe('with the App'));
    expect(accesses.reader).toMatchObject({ connection: 'app', key: `server:${ORIGIN}:octo` });
    await chooseMindroom(view);
    await save(view, ' ghp_good ');
    expect(mindroom.storedToken()).toBe('ghp_good');
    await waitUntil(() => expect(view.getByTestId('reader').textContent).toBe('with the token'));
    expect(accesses.reader).toMatchObject({
      via: 'server',
      connection: 'token',
      appConnected: true,
      key: `server:${ORIGIN}:octo`,
    });
    expect((view.getByLabelText('GitHub token') as HTMLInputElement).value).toBe('');
    expect(leaked('ghp_good')).toBe(false);
  });

  it.each([
    ['GitHub refused it', 'ghp_refused', 'GitHub refused this token.'],
    ['it is no token (422)', 'ghp bad', 'This is not a GitHub token.'],
    ['GitHub could not be reached (502)', 'ghp_down', 'MindRoom could not save the token. Try again.'],
  ])('says so when %s, keeps it in the field to try again, and nowhere else', async (_, token, said) => {
    const mindroom = githubServer(github);
    const view = await form(mindroom.server);
    await waitUntil(() => expect(accesses.reader?.connection).toBe('app'));
    await chooseMindroom(view);
    await save(view, token);
    await waitUntil(() => expect(view.getByRole('alert').textContent).toBe(said));
    expect(mindroom.storedToken()).toBeUndefined();
    expect(accesses.reader?.connection).toBe('app');
    expect(field(view).value).toBe(token);
    expect(kept(token)).toBe(false);
  });

  it.each([404, 405])(
    'says a MindRoom server that answers %s cannot save tokens yet',
    async (status) => {
      const mindroom = githubServer(github);
      answerToken(mindroom, () =>
        Promise.reject(new MindroomServerError('Not Found', status, { detail: 'Not Found' }))
      );
      const view = await form(mindroom.server);
      await waitUntil(() => expect(accesses.reader?.connection).toBe('app'));
      await chooseMindroom(view);
      await save(view, 'ghp_good');
      await waitUntil(() =>
        expect(view.getByRole('alert').textContent).toBe(
          'This MindRoom server cannot save tokens yet. Use Only this browser.'
        )
      );
      expect(field(view).value).toBe('ghp_good');
      expect(accesses.reader?.connection).toBe('app');
    }
  );

  it.each([
    ['no status', {}],
    ['the App', { connected: true, via: 'app', login: 'octo' }],
    ['no connection', { connected: false }],
  ])(
    'counts a save as failed when MindRoom answers %s, and keeps the browser token',
    async (_, answer) => {
      localStorage.setItem(TOKEN_KEY, 'ghp_old');
      vi.stubGlobal('fetch', vi.fn(github));
      const mindroom = githubServer(github);
      answerToken(mindroom, () => Promise.resolve(answer));
      const view = await form(mindroom.server);
      await waitUntil(() => expect(accesses.reader?.via).toBe('token'));
      await chooseMindroom(view);
      await save(view, 'ghp_good');
      await waitUntil(() =>
        expect(view.getByRole('alert').textContent).toBe(
          'MindRoom could not save the token. Try again.'
        )
      );
      expect(localStorage.getItem(TOKEN_KEY)).toBe('ghp_old');
      expect(accesses.reader?.via).toBe('token');
      expect(field(view).value).toBe('ghp_good');
    }
  );

  it('keeps the token in the browser alone when asked to again, and asks MindRoom nothing of it', async () => {
    const mindroom = githubServer(github);
    const view = await form(mindroom.server);
    await chooseMindroom(view);
    await click(view.getByLabelText('Only this browser'));
    await save(view, 'ghp_mine');
    await waitUntil(() => expect(accesses.reader?.via).toBe('token'));
    expect(localStorage.getItem(TOKEN_KEY)).toBe('ghp_mine');
    expect(mindroom.tokenRequests()).toEqual([]);
  });

  it('offers no choice in a room without a MindRoom server, and keeps the token in the browser', async () => {
    vi.stubGlobal('fetch', vi.fn(github));
    const view = await form(undefined);
    expect(view.queryByLabelText(/Save in MindRoom/)).toBeNull();
    await save(view, 'ghp_mine');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('ghp_mine');
  });

  it('forgets the token of this browser once one is saved in MindRoom, which it would hide', async () => {
    localStorage.setItem(TOKEN_KEY, 'ghp_old');
    vi.stubGlobal('fetch', vi.fn(github));
    const mindroom = githubServer(github);
    const view = await form(mindroom.server);
    await waitUntil(() => expect(accesses.reader?.via).toBe('token'));
    await chooseMindroom(view);
    await save(view, 'ghp_other');
    await waitUntil(() => expect(accesses.reader?.key).toBe(`server:${ORIGIN}:other`));
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    await waitUntil(() => expect(mindroom.githubRequests()).toHaveLength(1));
    await waitUntil(() => expect(view.getByTestId('reader').textContent).toBe('with the token'));
  });

  it('saves and removes it without following a redirect, which would take the token elsewhere', async () => {
    const mindroom = githubServer(github);
    const view = await show(
      mindroom.server,
      <>
        <TokenForm reason="override" />
        <RemoveServerToken />
        <NamedReader name="reader" />
      </>
    );
    await waitUntil(() => expect(accesses.reader?.connection).toBe('app'));
    await chooseMindroom(view);
    await save(view, 'ghp_good');
    await waitUntil(() => expect(accesses.reader?.connection).toBe('token'));
    await click(view.getByRole('button', { name: 'Remove token from MindRoom' }));
    await waitUntil(() => expect(accesses.reader?.connection).toBe('app'));
    const sent = mindroom.server.request.mock.calls
      .filter(([path]) => path === '/api/github/token')
      .map(([, init]) => [init?.method, init?.redirect]);
    expect(sent).toEqual([
      ['PUT', 'error'],
      ['DELETE', 'error'],
    ]);
  });

  it('removes it from MindRoom, going back to the App, as the status it answers says', async () => {
    const mindroom = githubServer(github);
    await mindroom.server.request('/api/github/token', {
      method: 'PUT',
      body: JSON.stringify({ token: 'ghp_good' }),
    });
    const view = await show(
      mindroom.server,
      <>
        <RemoveServerToken />
        <NamedReader name="reader" />
      </>
    );
    await waitUntil(() => expect(view.getByTestId('reader').textContent).toBe('with the token'));
    const remove = view.getByRole('button', { name: 'Remove token from MindRoom' });
    expect(remove.title).toBe('MindRoom then uses your GitHub App connection.');
    await click(remove);
    await waitUntil(() => expect(view.getByTestId('reader').textContent).toBe('with the App'));
    expect(accesses.reader).toMatchObject({ connection: 'app', key: `server:${ORIGIN}:octo` });
    expect(mindroom.tokenRequests()).toEqual(['PUT', 'DELETE']);
    expect(mindroom.statusRequests()).toBe(1);
    expect(view.queryByRole('button', { name: 'Remove token from MindRoom' })).toBeNull();
  });
});
