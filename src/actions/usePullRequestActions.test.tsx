// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequest, PullRequestRef } from '../github';
import plugin from '../index';
import { usePullRequest } from '../queries';
import { resetPullRequestActions, usePullRequestActions } from './usePullRequestActions';

const STORAGE = 'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/';
const GRAPHQL = 'https://api.github.com/graphql';
const PULL_URL = 'https://api.github.com/repos/o/r/pulls/7';

const refA: PullRequestRef = { owner: 'o', repo: 'r', number: 7 };
const refB: PullRequestRef = { owner: 'o', repo: 'r', number: 8 };

const pull: PullRequest = {
  title: 'T',
  state: 'open',
  draft: false,
  body: '',
  images: { byUrl: {}, byAttachment: {} },
  author: null,
  labels: [],
  requestedReviewers: [],
  requestedTeams: [],
  nodeId: 'PR_kw7',
  mergeable: true,
  mergeableState: 'clean',
  autoMerge: null,
  headSha: 'head7',
  headRepo: 'o/r',
  headRepoId: 'R_or',
  baseRepo: 'o/r',
  mergedAt: null,
  closedAt: null,
  commentCount: 0,
  reviewCommentCount: 0,
  commitCount: 1,
  createdAt: '',
  updatedAt: '',
  baseRef: 'main',
  headRef: 'feature',
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  url: 'https://github.com/o/r/pull/7',
};

// The pull request as GitHub's REST API sends it, for the panel's own query of it.
const apiPull = (extra: Record<string, unknown> = {}) => ({
  title: 'T',
  state: 'open',
  node_id: 'PR_kw7',
  mergeable: true,
  mergeable_state: 'clean',
  head: { sha: 'head7', ref: 'feature', repo: { full_name: 'o/r', node_id: 'R_or' } },
  base: { ref: 'main', repo: { full_name: 'o/r' } },
  html_url: 'https://github.com/o/r/pull/7',
  ...extra,
});

const repository = {
  viewerPermission: 'WRITE',
  mergeCommitAllowed: true,
  squashMergeAllowed: true,
  rebaseMergeAllowed: true,
  autoMergeAllowed: true,
  defaultBranchRef: { name: 'main' },
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

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

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const isRepositoryQuery = (url: string, init?: RequestInit) =>
  url === GRAPHQL && String(init?.body).includes('repository(');
const isRead = (url: string, init?: RequestInit) =>
  isRepositoryQuery(url, init) || init?.method === undefined;
const writes = () =>
  fetchMock.mock.calls
    .filter(([url, init]) => !isRead(url, init))
    .map(([url, init]) => `${init?.method} ${url}`);
// The times the pull request itself was read.
const pullReads = () =>
  fetchMock.mock.calls.filter(([url, init]) => url === PULL_URL && !init?.method);

// The writes a test holds until it answers them; every one is answered after the test, so no
// pull request stays locked for the next.
const held: (() => void)[] = [];
const hold = (answer: () => Response) =>
  new Promise<Response>((resolve) => held.push(() => resolve(answer())));
const answerHeld = async () => {
  await act(async () => {
    held.splice(0).forEach((release) => release());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

let writeAnswer: () => Promise<Response>;
let pullAnswer: () => Promise<Response>;

let actions: ReturnType<typeof usePullRequestActions>;
function Probe({
  pullRequestRef,
  pullRequest,
}: {
  pullRequestRef?: PullRequestRef;
  pullRequest?: PullRequest;
}) {
  actions = usePullRequestActions(pullRequestRef, pullRequest);
  return null;
}

let client: QueryClient;
const ui = (pullRequestRef?: PullRequestRef, pullRequest?: PullRequest) => (
  <QueryClientProvider client={client}>
    <Probe pullRequestRef={pullRequestRef} pullRequest={pullRequest} />
  </QueryClientProvider>
);
const show = (pullRequestRef?: PullRequestRef, pullRequest?: PullRequest) =>
  renderPluginComponent(ui(pullRequestRef, pullRequest), { id: 'pull-requests', plugin });

const loaded = () => waitUntil(() => expect(actions.repo).toBeDefined());

// Lets `ms` of the runner's waiting pass, and what it asks in that time be answered.
const pass = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await new Promise((resolve) => setImmediate(resolve));
  });

// As the panel has it: the pull request is a query, which the read after an action asks again.
let shown: PullRequest | undefined;
function Panel() {
  const query = usePullRequest(refA);
  shown = query.data;
  actions = usePullRequestActions(refA, query.data);
  return null;
}
const showPanel = async () => {
  const view = await renderPluginComponent(
    <QueryClientProvider client={client}>
      <Panel />
    </QueryClientProvider>,
    { id: 'pull-requests', plugin }
  );
  await waitUntil(() => expect(shown).toBeDefined());
  await loaded();
  return view;
};

// Two runners at once, as two panels (or a panel and its next mount) have them.
const both: ReturnType<typeof usePullRequestActions>[] = [];
function Pair({ refs }: { refs: [PullRequestRef, PullRequestRef] }) {
  both[0] = usePullRequestActions(refs[0], pull);
  both[1] = usePullRequestActions(refs[1], pull);
  return null;
}
const showPair = (refs: [PullRequestRef, PullRequestRef]) =>
  renderPluginComponent(
    <QueryClientProvider client={client}>
      <Pair refs={refs} />
    </QueryClientProvider>,
    { id: 'pull-requests', plugin }
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem(`${STORAGE}githubToken`, 'tok');
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  writeAnswer = async () => respond({ merged: true });
  pullAnswer = async () => respond(apiPull());
  shown = undefined;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url, init) => {
    if (isRepositoryQuery(url, init)) return respond({ data: { repository } });
    return url === PULL_URL && !init?.method ? pullAnswer() : writeAnswer();
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  vi.useRealTimers();
  await answerHeld();
  resetPullRequestActions();
  vi.unstubAllGlobals();
});

describe('usePullRequestActions', () => {
  it('sends nothing without a token, and has no repository', async () => {
    localStorage.clear();
    await show(refA, pull);
    act(() => actions.perform('close'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(actions.repo).toBeUndefined();
  });

  it('loads the repository with one GraphQL request', async () => {
    await show(refA, pull);
    await loaded();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(GRAPHQL);
    expect(actions.repo).toEqual({
      canWrite: true,
      mergeMethods: ['merge', 'squash', 'rebase'],
      autoMergeAllowed: true,
      defaultBranch: 'main',
    });
    expect(actions.method).toBe('merge');
  });

  it('does not ask again for a repository GitHub refused', async () => {
    fetchMock.mockImplementation(async () =>
      respond({ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] })
    );
    await show(refA, pull);
    await waitUntil(() =>
      expect(client.getQueryState(['pull-requests', 'repo', 'o', 'r'])?.status).toBe('error')
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(actions.repo).toBeUndefined();
  });

  it('forgets the repository with the token', async () => {
    await show(refA, pull);
    await loaded();
    // As another tab of the account forgets it.
    localStorage.removeItem(`${STORAGE}githubToken`);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage'));
    });
    expect(actions.repo).toBeUndefined();
  });

  it('is inert without a ref or without the pull request', async () => {
    const view = await show(undefined, undefined);
    expect(actions.repo).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    view.rerender(ui(refA, undefined));
    await loaded();
    act(() => actions.perform('close'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes()).toEqual([]);
    expect(actions.pending).toBeNull();
    expect(actions.result).toBeNull();
  });

  it('sends one request for a second action while one runs', async () => {
    writeAnswer = () => hold(() => respond({ merged: true }));
    await show(refA, pull);
    await loaded();
    act(() => {
      actions.perform('merge');
      actions.perform('merge');
    });
    act(() => actions.perform('close'));
    expect(actions.pending).toBe('merge');
    await waitUntil(() =>
      expect(writes()).toEqual(['PUT https://api.github.com/repos/o/r/pulls/7/merge'])
    );
    await answerHeld();
    expect(writes()).toHaveLength(1);
    expect(actions.pending).toBeNull();
  });

  it('refreshes the pull request after a success', async () => {
    await show(refA, pull);
    await loaded();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => actions.perform('merge'));
    await waitUntil(() => expect(actions.result).toEqual({ action: 'merge', outcome: 'done' }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['pull-requests', 'pr', 'o', 'r', 7] });
    expect(actions.pending).toBeNull();
    act(() => actions.dismissResult());
    expect(actions.result).toBeNull();
  });

  it('keeps the pull request locked until it is read again after the write', async () => {
    await showPanel();
    // GitHub merges it, and the read after that is slow.
    const mergedPull = apiPull({ state: 'closed', merged_at: '2026-11-16T00:00:00Z' });
    pullAnswer = () => hold(() => respond(mergedPull));
    act(() => actions.perform('merge'));
    await waitUntil(() => expect(pullReads()).toHaveLength(2));
    // The write is answered, but the panel still shows the open pull request: unlocked now, its
    // Merge would send a second merge of a merged pull request.
    expect(shown?.state).toBe('open');
    expect(actions.pending).toBe('merge');
    expect(actions.result).toBeNull();
    act(() => actions.perform('merge'));
    await answerHeld();
    await waitUntil(() => expect(actions.pending).toBeNull());
    expect(shown?.state).toBe('merged');
    expect(actions.result).toEqual({ action: 'merge', outcome: 'done' });
    expect(writes()).toEqual([`PUT ${PULL_URL}/merge`]);
  });

  it('unlocks when the read after the write fails', async () => {
    await showPanel();
    pullAnswer = async () => respond({ message: 'Not Found' }, 404);
    act(() => actions.perform('close'));
    await waitUntil(() => expect(actions.result).toEqual({ action: 'close', outcome: 'done' }));
    expect(actions.pending).toBeNull();
    expect(pullReads()).toHaveLength(2);
  });

  describe('an update of the branch, which GitHub makes after it answers', () => {
    const head = (sha: string) => ({
      head: { sha, ref: 'feature', repo: { full_name: 'o/r', node_id: 'R_or' } },
    });
    const update = async () => {
      await showPanel();
      writeAnswer = async () => respond({ data: { updatePullRequestBranch: {} } });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    };

    it('runs until GitHub shows the new head, which the panel then has', async () => {
      await update();
      act(() => actions.perform('update-branch'));
      // Read at once, and again two seconds later: GitHub still shows the old head.
      await pass(0);
      expect(pullReads()).toHaveLength(2);
      await pass(2000);
      expect(pullReads()).toHaveLength(3);
      expect(actions.pending).toBe('update-branch');
      expect(actions.result).toBeNull();
      expect(shown?.headSha).toBe('head7');
      pullAnswer = async () => respond(apiPull(head('head8')));
      await pass(2000);
      await pass(0);
      expect(actions.pending).toBeNull();
      expect(actions.result).toEqual({ action: 'update-branch', outcome: 'done' });
      // So a merge after it sends the new head.
      expect(shown?.headSha).toBe('head8');
      await pass(60_000);
      // The read that saw the new head, and the panel's own after it; then no more.
      expect(pullReads()).toHaveLength(5);
    });

    it('says only that the update was requested when no new head shows in half a minute', async () => {
      await update();
      act(() => actions.perform('update-branch-rebase'));
      for (let waited = 0; waited < 28_000; waited += 2000) await pass(2000);
      expect(actions.pending).toBe('update-branch-rebase');
      await pass(2000);
      await pass(0);
      expect(actions.pending).toBeNull();
      expect(actions.result).toEqual({ action: 'update-branch-rebase', outcome: 'requested' });
      // The first load, a read every two seconds for half a minute, and the panel's own after.
      expect(pullReads()).toHaveLength(1 + 16 + 1);
      await pass(60_000);
      expect(pullReads()).toHaveLength(18);
    });

    it('keeps waiting through a read that fails', async () => {
      await update();
      pullAnswer = async () => respond({ message: 'Not Found' }, 404);
      act(() => actions.perform('update-branch'));
      await pass(0);
      expect(actions.pending).toBe('update-branch');
      pullAnswer = async () => respond(apiPull(head('head8')));
      await pass(2000);
      await pass(0);
      expect(actions.result).toEqual({ action: 'update-branch', outcome: 'done' });
    });

    it('does not wait for a head after a refused update', async () => {
      await update();
      writeAnswer = async () => respond({ errors: [{ message: 'Head branch was modified' }] });
      act(() => actions.perform('update-branch'));
      await pass(0);
      expect(actions.result?.outcome).toBe('failed');
      expect(actions.pending).toBeNull();
    });

    it('does not wait for a head after any other action', async () => {
      await update();
      act(() => actions.perform('close'));
      await pass(0);
      expect(actions.result).toEqual({ action: 'close', outcome: 'done' });
      // The first load, and the read after the action.
      expect(pullReads()).toHaveLength(2);
    });
  });

  it('reports a refusal, and refreshes the pull request whose state moved', async () => {
    writeAnswer = async () => respond({ message: 'Pull Request is not mergeable' }, 405);
    await show(refA, pull);
    await loaded();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => actions.perform('merge'));
    await waitUntil(() => expect(actions.result?.outcome).toBe('failed'));
    const result = actions.result;
    expect(result?.outcome === 'failed' && result.error.kind).toBe('refused');
    expect(result?.outcome === 'failed' && result.error.detail).toBe(
      'Pull Request is not mergeable'
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['pull-requests', 'pr', 'o', 'r', 7] });
  });

  it.each([
    [
      'without access',
      async () => respond({ message: 'Resource not accessible' }, 403),
      'noAccess',
    ],
    ['with a server error', async () => respond({ message: 'Server Error' }, 502), 'failed'],
    [
      'without an answer',
      async (): Promise<Response> => {
        throw new TypeError('Failed to fetch');
      },
      'failed',
    ],
  ] as const)(
    'refreshes the pull request after a failure %s, as GitHub may have taken the write',
    async (_name, answer, kind) => {
      writeAnswer = answer;
      await show(refA, pull);
      await loaded();
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      act(() => actions.perform('close'));
      await waitUntil(() => expect(actions.result?.outcome).toBe('failed'));
      const result = actions.result;
      expect(result?.outcome === 'failed' && result.error.kind).toBe(kind);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['pull-requests', 'pr', 'o', 'r', 7] });
    }
  );

  it('locks a pull request by its owner and repository in any case', async () => {
    writeAnswer = () => hold(() => respond({ merged: true }));
    const upper: PullRequestRef = { owner: 'O', repo: 'R', number: 7 };
    await showPair([refA, upper]);
    await waitUntil(() => expect(both[1]!.repo).toBeDefined());
    await waitUntil(() => expect(both[0]!.repo).toBeDefined());
    act(() => both[0]!.perform('merge'));
    act(() => both[1]!.perform('close'));
    expect(both[1]!.pending).toBe('merge');
    await waitUntil(() =>
      expect(writes()).toEqual(['PUT https://api.github.com/repos/o/r/pulls/7/merge'])
    );
    await answerHeld();
    expect(writes()).toHaveLength(1);
    // One outcome too, whichever casing shows it.
    expect(both[1]!.result).toEqual({ action: 'merge', outcome: 'done' });
  });

  it('shows the running action on every runner of the pull request', async () => {
    writeAnswer = () => hold(() => respond({ merged: true }));
    await showPair([refA, refA]);
    await waitUntil(() => expect(both[0]!.repo).toBeDefined());
    act(() => both[0]!.perform('merge'));
    expect(both[0]!.pending).toBe('merge');
    expect(both[1]!.pending).toBe('merge');
    await answerHeld();
    expect(both[1]!.pending).toBeNull();
    expect(both[1]!.result).toEqual({ action: 'merge', outcome: 'done' });
  });

  it('shows the running action again when the panel opens anew mid-action', async () => {
    writeAnswer = () => hold(() => respond({ merged: true }));
    const first = await show(refA, pull);
    await loaded();
    act(() => actions.perform('merge'));
    first.unmount();
    await show(refA, pull);
    expect(actions.pending).toBe('merge');
    act(() => actions.perform('close'));
    await waitUntil(() => expect(writes()).toHaveLength(1));
    await answerHeld();
    expect(writes()).toEqual(['PUT https://api.github.com/repos/o/r/pulls/7/merge']);
    expect(actions.pending).toBeNull();
    expect(actions.result).toEqual({ action: 'merge', outcome: 'done' });
  });

  it('shows a failure on its own pull request when that one is shown again', async () => {
    writeAnswer = () => hold(() => respond({ message: 'Pull Request is not mergeable' }, 405));
    const view = await show(refA, pull);
    await loaded();
    act(() => actions.perform('merge'));
    const pullB = { ...pull, url: 'https://github.com/o/r/pull/8' };
    view.rerender(ui(refB, pullB));
    await answerHeld();
    // Never on the other one.
    expect(actions.result).toBeNull();
    view.rerender(ui(refA, pull));
    const result = actions.result;
    expect(result?.outcome === 'failed' && result.error.detail).toBe(
      'Pull Request is not mergeable'
    );
    act(() => actions.dismissResult());
    expect(actions.result).toBeNull();
  });

  it('keeps the chosen method, and remembers it for the next pull request', async () => {
    const view = await show(refA, pull);
    await loaded();
    act(() => actions.chooseMethod('rebase'));
    expect(actions.method).toBe('rebase');
    expect(localStorage.getItem(`${STORAGE}mergeMethod`)).toBe('rebase');
    view.unmount();
    await show(refB, { ...pull, url: 'https://github.com/o/r/pull/8' });
    await loaded();
    expect(actions.method).toBe('rebase');
  });

  describe('with auto-merge armed', () => {
    const armed = (method: 'merge' | 'squash' | 'rebase') => ({ ...pull, autoMerge: { method } });
    const mergeBody = () => {
      const [, init] = fetchMock.mock.calls.find(([url]) => url === `${PULL_URL}/merge`)!;
      return JSON.parse(String(init?.body));
    };

    it('starts on the armed method, which Merge now then merges with, as the badge says', async () => {
      localStorage.setItem(`${STORAGE}mergeMethod`, 'rebase');
      await show(refA, armed('squash'));
      await loaded();
      expect(actions.method).toBe('squash');
      act(() => actions.perform('merge'));
      await waitUntil(() => expect(actions.result).toEqual({ action: 'merge', outcome: 'done' }));
      expect(mergeBody()).toEqual({ merge_method: 'squash', sha: 'head7' });
      // Not the viewer's own choice, so the next pull request does not start on it.
      expect(localStorage.getItem(`${STORAGE}mergeMethod`)).toBe('rebase');
    });

    it('starts on it when auto-merge is armed while the pull request shows', async () => {
      const view = await show(refA, pull);
      await loaded();
      expect(actions.method).toBe('merge');
      view.rerender(ui(refA, armed('rebase')));
      expect(actions.method).toBe('rebase');
    });

    it('keeps a method chosen after that', async () => {
      const view = await show(refA, armed('squash'));
      await loaded();
      act(() => actions.chooseMethod('rebase'));
      expect(actions.method).toBe('rebase');
      // The same pull request read again does not take the choice back.
      view.rerender(ui(refA, { ...armed('squash'), updatedAt: 'later' }));
      expect(actions.method).toBe('rebase');
    });

    it('does not start another pull request on it', async () => {
      const view = await show(refA, armed('squash'));
      await loaded();
      expect(actions.method).toBe('squash');
      view.rerender(ui(refB, { ...pull, url: 'https://github.com/o/r/pull/8' }));
      expect(actions.method).toBe('merge');
    });

    it('falls back when the repository no longer allows the armed method', async () => {
      const allowed = { ...repository, squashMergeAllowed: false };
      fetchMock.mockImplementation(async () => respond({ data: { repository: allowed } }));
      await show(refA, armed('squash'));
      await loaded();
      expect(actions.method).toBe('merge');
    });
  });

  it('falls back to an allowed method when the remembered one is not', async () => {
    localStorage.setItem(`${STORAGE}mergeMethod`, 'rebase');
    const allowed = { ...repository, mergeCommitAllowed: false, rebaseMergeAllowed: false };
    fetchMock.mockImplementation(async () => respond({ data: { repository: allowed } }));
    await show(refA, pull);
    await loaded();
    expect(actions.method).toBe('squash');
  });

  it('shows another pull request without the action that runs on the one before', async () => {
    writeAnswer = () => hold(() => respond({}));
    const view = await show(refA, pull);
    await loaded();
    act(() => actions.perform('merge'));
    expect(actions.pending).toBe('merge');
    const pullB = { ...pull, url: 'https://github.com/o/r/pull/8' };
    view.rerender(ui(refB, pullB));
    expect(actions.pending).toBeNull();
    expect(actions.result).toBeNull();
    // The other pull request is not locked by the first one's action.
    act(() => actions.perform('close'));
    expect(actions.pending).toBe('close');
    await waitUntil(() => expect(writes()).toHaveLength(2));
    // The first one's answer neither shows on this one nor ends its action.
    await act(async () => {
      held.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(actions.result).toBeNull();
    expect(actions.pending).toBe('close');
    await answerHeld();
    expect(actions.result).toEqual({ action: 'close', outcome: 'done' });
    expect(actions.pending).toBeNull();
  });

  it("keeps this pull request's outcome when the one before's answer comes after it", async () => {
    writeAnswer = () => hold(() => respond({}));
    const view = await show(refA, pull);
    await loaded();
    act(() => actions.perform('merge'));
    view.rerender(ui(refB, { ...pull, url: 'https://github.com/o/r/pull/8' }));
    act(() => actions.perform('close'));
    await waitUntil(() => expect(writes()).toHaveLength(2));
    await act(async () => {
      held.pop()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(actions.result).toEqual({ action: 'close', outcome: 'done' });
    await answerHeld();
    expect(actions.result).toEqual({ action: 'close', outcome: 'done' });
  });
});
