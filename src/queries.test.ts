// @vitest-environment jsdom
import { createElement } from 'react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { act } from './testing/act';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubError, type PullRequest } from './github';
import plugin from './index';
import {
  markPullRequestMerged,
  refreshPullRequest,
  reloadPullRequest,
  usePullRequest,
} from './queries';

const REF = { owner: 'o', repo: 'r', number: 7 };
const PULL = ['pull-requests', 'pr', 'o', 'r', 7] as const;

let client: QueryClient;
const unsubscribes: (() => void)[] = [];
/** A query of the pull request under `access` that is on screen, answering `answer()`. */
const shown = (access: boolean | string, answer: () => Promise<unknown>) => {
  const observer = new QueryObserver(client, {
    queryKey: [...PULL, access],
    queryFn: answer,
    retry: false,
  });
  unsubscribes.push(observer.subscribe(() => {}));
};
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe());
  client.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('refreshPullRequest', () => {
  it('settles on the read with the access the write used, not on another room shown without', async () => {
    client = new QueryClient();
    let reads = 0;
    shown('server:https://m.example.org:octo:0', async () => ({ title: `read ${++reads}` }));
    // A room without the server shows the private pull request as not found.
    shown(false, () => Promise.reject(new GitHubError('notFound', 404)));
    await settled();
    await expect(
      refreshPullRequest(client, REF, 'server:https://m.example.org:octo:0')
    ).resolves.toBe(true);
    expect(reads).toBe(2);
  });

  it('says the read failed when the read with the access the write used fails', async () => {
    client = new QueryClient();
    let fail = false;
    shown(true, () =>
      fail ? Promise.reject(new GitHubError('notFound', 404)) : Promise.resolve({ title: 'T' })
    );
    await settled();
    fail = true;
    await expect(refreshPullRequest(client, REF, true)).resolves.toBe(false);
  });
});

describe('pullRequestQuery reload and merged monotonicity', () => {
  const TOKEN_KEY = 'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/githubToken';
  const pullJson = (extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ title: 'T', state: 'open', node_id: 'PR_kw7', ...extra }));
  const flush = (fn: () => Promise<unknown>) => act(async () => (await fn(), await settled()));

  const mount = async (responder: () => Promise<Response>) => {
    localStorage.setItem(TOKEN_KEY, 'tok');
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchMock = vi.fn(responder);
    vi.stubGlobal('fetch', fetchMock);
    const state: { data: PullRequest | undefined } = { data: undefined };
    const Probe = () => ((state.data = usePullRequest(REF).data), null);
    const view = await renderPluginComponent(
      createElement(QueryClientProvider, { client }, createElement(Probe)),
      { id: 'pull-requests', plugin }
    );
    await vi.waitFor(() => expect(state.data?.state).toBe('open'));
    return { view, state, fetchMock };
  };

  it('uses cache reload for refreshPullRequest and reloadPullRequest', async () => {
    const { view, fetchMock } = await mount(async () => pullJson());
    await flush(() => refreshPullRequest(client, REF, true));
    await flush(() => reloadPullRequest(client, REF));
    expect(
      (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(([, i]) => i.cache)
    ).toEqual(['no-cache', 'reload', 'reload']);
    view.unmount();
  });

  it('keeps a merged PR from regressing on stale open GETs and updates mergedAt on real merged data', async () => {
    let extra: Record<string, unknown> = {};
    const { view, state } = await mount(async () => pullJson(extra));
    await flush(() => markPullRequestMerged(client, REF, true));
    expect(state.data?.state).toBe('merged');
    await flush(() => reloadPullRequest(client, REF));
    expect(state.data).toMatchObject({ state: 'merged', mergedAt: null });
    extra = { state: 'closed', merged_at: '2026-11-16T00:00:00Z' };
    await flush(() => reloadPullRequest(client, REF));
    expect(state.data).toMatchObject({ state: 'merged', mergedAt: '2026-11-16T00:00:00Z' });
    view.unmount();
  });
});
