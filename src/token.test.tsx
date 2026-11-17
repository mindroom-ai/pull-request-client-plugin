// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createClient } from 'matrix-js-sdk';
import { act } from 'react-dom/test-utils';
import { MindroomServerError, type MindroomServer } from '@mindroom/client-sdk/server';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubViaServer } from './github';
import plugin from './index';
import { usePullRequest } from './queries';
import { GitHubServerContext, RoomGitHub, useGitHubAccess, type GitHubAccess } from './token';

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
    expect(a?.current()).toBeUndefined();
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
    const auth = accesses.a?.current() as GitHubViaServer;
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
    expect(accesses.a?.current()).toBe('ghp_test');
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
    expect(accesses.a?.current()).toBeUndefined();
  });

  it('drops to anonymous once the server says the connection went away', async () => {
    const server = serverWith(() => Promise.resolve({ connected: true, login: 'octo' }));
    await show(server);
    await waitUntil(() => expect(accesses.a?.via).toBe('server'));
    const auth = accesses.a?.current() as GitHubViaServer;
    act(() => auth.disconnected());
    await waitUntil(() => expect(accesses.a?.via).toBeUndefined());
    expect(accesses.a?.key).toBe(false);
    expect(accesses.a?.current()).toBeUndefined();
  });

  it('asks the status again on focus half a minute after the connection went away', async () => {
    const server = serverWith(() => Promise.resolve({ connected: true, login: 'octo' }));
    await show(server);
    await waitUntil(() => expect(accesses.a?.via).toBe('server'));
    act(() => (accesses.a?.current() as GitHubViaServer).disconnected());
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
