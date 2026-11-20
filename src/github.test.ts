import { parsePatchFiles } from '@pierre/diffs';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MindroomServerError, type MindroomServer } from '@mindroom/client-sdk/server';
import {
  GitHubError,
  type GitHubViaServer,
  GitHubWriteError,
  fetchBehindBy,
  fetchChecks,
  fetchCommitFiles,
  fetchDiffBlob,
  fetchCommits,
  fetchConversationComments,
  fetchHeadBranch,
  fetchPullRequest,
  fetchPullRequestFiles,
  fetchReviewComments,
  fetchRepository,
  fetchReviews,
  filePatch,
  parsePullRequestUrl,
  pullRequestUrl,
  runPullRequestAction,
  type PullRequest,
  type PullRequestAction,
  type PullRequestFile,
} from './github';
import { githubServer } from './testing/mindroomServer';

/** What the stand-in MindRoom server answers a GitHub request for `path` with, as a refusal. */
const getRefused = (server: MindroomServer, path: string) =>
  server
    .request('/api/github/request', {
      method: 'POST',
      body: JSON.stringify({ method: 'GET', path }),
    })
    .then(
      () => undefined,
      (error: unknown) => error
    );

const ref = { owner: 'a', repo: 'b', number: 1 };

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

const apiPull = {
  title: 'T',
  state: 'open',
  draft: false,
  body: null,
  user: { login: 'u', avatar_url: 'https://a/u.png', html_url: 'https://github.com/u' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  merged_at: null,
  base: { ref: 'main' },
  head: { ref: 'topic' },
  additions: 3,
  deletions: 1,
  changed_files: 2,
  html_url: 'https://github.com/a/b/pull/1',
};

describe('parsePullRequestUrl', () => {
  it.each([
    'https://github.com/mindroom-ai/mindroom-chat/pull/200',
    'https://github.com/mindroom-ai/mindroom-chat/pull/200/',
    'https://github.com/mindroom-ai/mindroom-chat/pull/200/files',
    'https://github.com/mindroom-ai/mindroom-chat/pull/200#discussion_r1',
    'https://github.com/mindroom-ai/mindroom-chat/pull/200?w=1',
    'https://www.github.com/a/b.c/pull/1',
  ])('accepts %s', (url) => {
    expect(parsePullRequestUrl(new URL(url))).toBeDefined();
  });

  it('reads the parts', () => {
    expect(parsePullRequestUrl(new URL('https://www.github.com/a/b.c/pull/12/files'))).toEqual({
      owner: 'a',
      repo: 'b.c',
      number: 12,
    });
  });

  it.each([
    'http://github.com/a/b/pull/1',
    'https://github.com/a/b/pulls',
    'https://github.com/a/b/pull/abc',
    'https://github.com/a/b/pull/0',
    'https://github.com/a/b/pull/01',
    'https://gitlab.com/a/b/pull/1',
    'https://github.com/a/pull/1',
  ])('rejects %s', (url) => {
    expect(parsePullRequestUrl(new URL(url))).toBeUndefined();
  });

  it('builds the URL back', () => {
    expect(pullRequestUrl({ owner: 'o', repo: 'r', number: 5 })).toBe(
      'https://github.com/o/r/pull/5'
    );
  });
});

describe('fetchPullRequest', () => {
  it('sends the token only when set', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(apiPull)));
    vi.stubGlobal('fetch', fetchMock);
    await fetchPullRequest(ref, 't');
    await fetchPullRequest(ref, undefined);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const withToken = new Headers(calls[0]![1].headers);
    const without = new Headers(calls[1]![1].headers);
    expect(calls[0]![0].startsWith('https://api.github.com/repos/a/b/pulls/1')).toBe(true);
    expect(withToken.get('authorization')).toBe('Bearer t');
    expect(without.get('authorization')).toBeNull();
    for (const headers of [withToken, without]) {
      // The full media type adds `body_html`, where the description's images have addresses.
      expect(headers.get('accept')).toBe('application/vnd.github.full+json');
      expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    }
  });

  it('asks GitHub again for every read with a token, not the browser cache', async () => {
    // GitHub answers with max-age=60: a read served from the cache would show a pull request
    // merged a moment ago as still open. An authorized revalidation answered 304 is not rate
    // limited.
    const fetchMock = vi.fn(() => Promise.resolve(json(apiPull)));
    vi.stubGlobal('fetch', fetchMock);
    await fetchPullRequest(ref, 't');
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![1].cache).toBe('no-cache');
  });

  it('lets the browser cache serve a read without a token', async () => {
    // Without a token a 304 still counts against the 60 an hour, and no write can have happened.
    const fetchMock = vi.fn(() => Promise.resolve(json(apiPull)));
    vi.stubGlobal('fetch', fetchMock);
    await fetchPullRequest(ref, undefined);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![1].cache).toBe('default');
  });

  it('maps an open pull request', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json(apiPull)));
    expect(await fetchPullRequest(ref, undefined)).toEqual({
      title: 'T',
      state: 'open',
      draft: false,
      body: '',
      images: { byUrl: {}, byAttachment: {} },
      author: {
        login: 'u',
        name: null,
        avatarUrl: 'https://a/u.png',
        url: 'https://github.com/u',
        isBot: false,
      },
      labels: [],
      requestedReviewers: [],
      requestedTeams: [],
      nodeId: '',
      mergeable: null,
      mergeableState: null,
      autoMerge: null,
      headSha: '',
      headRepo: null,
      headRepoId: '',
      baseRepo: 'a/b',
      mergedAt: null,
      closedAt: null,
      commentCount: 0,
      reviewCommentCount: 0,
      commitCount: 0,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      baseRef: 'main',
      headRef: 'topic',
      additions: 3,
      deletions: 1,
      changedFiles: 2,
      url: 'https://github.com/a/b/pull/1',
    });
  });

  it('maps a merged pull request', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(json({ ...apiPull, state: 'closed', merged_at: '2026-01-03T00:00:00Z' }))
    );
    expect((await fetchPullRequest(ref, undefined)).state).toBe('merged');
  });

  it('maps a closed pull request without an author', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(json({ ...apiPull, state: 'closed', user: null }))
    );
    const pull = await fetchPullRequest(ref, undefined);
    expect(pull.state).toBe('closed');
    expect(pull.author).toBeNull();
  });
});

describe('fetchPullRequestFiles', () => {
  it('pages until a short page', async () => {
    const file = (i: number) => ({
      filename: `f${i}`,
      status: 'modified',
      additions: 1,
      deletions: 0,
    });
    const sizes = [100, 100, 3];
    const fetchMock = vi.fn((url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return Promise.resolve(
        json(Array.from({ length: sizes[page - 1] ?? 0 }, (_, i) => file(page * 1000 + i)))
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const files = await fetchPullRequestFiles(ref, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(files).toHaveLength(203);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/pulls/1/files?per_page=100&page=1');
  });

  it('maps a file', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        json([
          {
            filename: 'n.ts',
            previous_filename: 'o.ts',
            status: 'renamed',
            additions: 2,
            deletions: 1,
            patch: '@@ -1 +1 @@\n-a\n+b',
            sha: 'b10b5a',
          },
        ])
      )
    );
    expect(await fetchPullRequestFiles(ref, undefined)).toEqual([
      {
        path: 'n.ts',
        previousPath: 'o.ts',
        status: 'renamed',
        additions: 2,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-a\n+b',
        sha: 'b10b5a',
        url: 'https://github.com/a/b/pull/1/files',
      },
    ]);
  });
});

describe('the error kinds', () => {
  async function failure(token: string | undefined, response: Response | Error) {
    vi.stubGlobal('fetch', () =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
    );
    const error = await fetchPullRequest(ref, token).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    return error as GitHubError;
  }

  // Each limit here reset long ago, so the next request still goes to GitHub.
  const reset = { 'x-ratelimit-reset': '0' };

  it('maps statuses', async () => {
    expect((await failure(undefined, new Response('', { status: 404 }))).kind).toBe('notFound');
    expect((await failure(undefined, new Response('', { status: 401 }))).kind).toBe('notFound');
    expect((await failure('secret', new Response('', { status: 401 }))).kind).toBe('badToken');
    const limited = { status: 403, headers: { 'x-ratelimit-remaining': '0', ...reset } };
    expect((await failure(undefined, new Response('', limited))).kind).toBe('rateLimited');
    const tooMany = { status: 429, headers: reset };
    expect((await failure(undefined, new Response('', tooMany))).kind).toBe('rateLimited');
    expect((await failure(undefined, new Response('', { status: 403 }))).kind).toBe('failed');
    const server = await failure(undefined, new Response('', { status: 500 }));
    expect(server.kind).toBe('failed');
    expect(server.status).toBe(500);
  });

  it('maps a network failure to status 0', async () => {
    const error = await failure('secret', new TypeError('Failed to fetch secret'));
    expect(error.kind).toBe('failed');
    expect(error.status).toBe(0);
  });

  it('never puts the token in a message', async () => {
    for (const status of [401, 403, 404, 429, 500]) {
      const error = await failure('secret', new Response('secret', { status, headers: reset }));
      expect(error.message).not.toContain('secret');
    }
    expect((await failure('secret', new TypeError('secret'))).message).not.toContain('secret');
  });
});

describe('the rate limit', () => {
  const NOW = Date.parse('2026-01-01T00:00:00Z');
  const LIMITED = new GitHubError('rateLimited', 403);
  const limited = (headers: Record<string, string> = {}) =>
    new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', ...headers } });
  // GitHub's reset time, in seconds since the epoch: ten minutes from now.
  const resetIn10 = { 'x-ratelimit-reset': String(NOW / 1000 + 600) };

  // A clock of its own, in the past, so a limit a test leaves has reset for the tests after it.
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks GitHub nothing more until the limit resets', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(limited(resetIn10)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchPullRequest(ref, undefined)).rejects.toEqual(LIMITED);
    fetchMock.mockImplementation(() => Promise.resolve(json(apiPull)));
    vi.setSystemTime(NOW + 599_000);
    const refused = await fetchPullRequest(ref, undefined).catch((error: unknown) => error);
    expect(refused).toEqual(LIMITED);
    expect((refused as GitHubError).kind).toBe('rateLimited');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 600_000);
    expect((await fetchPullRequest(ref, undefined)).title).toBe('T');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits a minute when GitHub names no reset time', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('', { status: 429 })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchPullRequest(ref, undefined)).rejects.toEqual(
      new GitHubError('rateLimited', 429)
    );
    vi.setSystemTime(NOW + 59_000);
    await expect(fetchPullRequest(ref, undefined)).rejects.toEqual(
      new GitHubError('rateLimited', 429)
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(() => Promise.resolve(json(apiPull)));
    vi.setSystemTime(NOW + 60_000);
    expect((await fetchPullRequest(ref, undefined)).title).toBe('T');
  });

  it('does not hold a request with a token to a limit reached without one', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(limited(resetIn10)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchPullRequest(ref, undefined)).rejects.toEqual(LIMITED);
    fetchMock.mockImplementation(() => Promise.resolve(json(apiPull)));
    expect((await fetchPullRequest(ref, 'token')).title).toBe('T');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(fetchPullRequest(ref, undefined)).rejects.toEqual(LIMITED);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks again with another token', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(limited(resetIn10)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchPullRequest(ref, 'old')).rejects.toEqual(LIMITED);
    await expect(fetchPullRequest(ref, 'old')).rejects.toEqual(LIMITED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(() => Promise.resolve(json(apiPull)));
    expect((await fetchPullRequest(ref, 'new')).title).toBe('T');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

const file = (over: Partial<PullRequestFile>): PullRequestFile => ({
  path: 'a.ts',
  previousPath: null,
  status: 'modified',
  additions: 1,
  deletions: 1,
  patch: '@@ -1 +1 @@\n-a\n+b',
  sha: null,
  url: 'https://github.com/a/b/pull/1/files',
  ...over,
});

describe('filePatch', () => {
  it('assembles an added file', () => {
    expect(filePatch(file({ status: 'added', patch: '@@ -0,0 +1 @@\n+a' }))).toBe(
      'diff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+a\n'
    );
  });

  it('assembles a removed file', () => {
    expect(filePatch(file({ status: 'removed', patch: '@@ -1 +0,0 @@\n-a' }))).toBe(
      'diff --git a/a.ts b/a.ts\ndeleted file mode 100644\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n'
    );
  });

  it('assembles a renamed file with changes', () => {
    expect(filePatch(file({ status: 'renamed', path: 'n.ts', previousPath: 'o.ts' }))).toBe(
      'diff --git a/o.ts b/n.ts\nsimilarity index 99%\nrename from o.ts\nrename to n.ts\n--- a/o.ts\n+++ b/n.ts\n@@ -1 +1 @@\n-a\n+b\n'
    );
  });

  it('assembles a modified file', () => {
    expect(filePatch(file({}))).toBe(
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n'
    );
  });

  it('keeps a patchless file', () => {
    expect(filePatch(file({ patch: null }))).toBeNull();
  });

  it('writes a header-only rename for a pure rename', () => {
    const pure = file({
      status: 'renamed',
      path: 'n.ts',
      previousPath: 'o.ts',
      patch: null,
      additions: 0,
      deletions: 0,
    });
    expect(filePatch(pure)).toBe(
      'diff --git a/o.ts b/n.ts\nsimilarity index 100%\nrename from o.ts\nrename to n.ts\n'
    );
    const files = parsePatchFiles(filePatch(pure) ?? '').flatMap((p) => p.files);
    expect(files.map((f) => [f.name, f.prevName, f.type, f.hunks.length])).toEqual([
      ['n.ts', 'o.ts', 'rename-pure', 0],
    ]);
  });

  it('keeps a patchless rename with changes as null', () => {
    expect(
      filePatch(file({ status: 'renamed', previousPath: 'o.ts', patch: null, additions: 1 }))
    ).toBeNull();
  });

  it('parses the assembled patches', () => {
    const patch = [
      file({ status: 'added', path: 'new.ts', patch: '@@ -0,0 +1 @@\n+a' }),
      file({ status: 'removed', path: 'gone.ts', patch: '@@ -1 +0,0 @@\n-a' }),
      file({ status: 'renamed', path: 'n.ts', previousPath: 'o.ts' }),
    ]
      .map((f) => filePatch(f))
      .join('');
    const files = parsePatchFiles(patch).flatMap((p) => p.files);
    expect(files.map((f) => [f.name, f.prevName, f.type, f.hunks.length])).toEqual([
      ['new.ts', undefined, 'new', 1],
      ['gone.ts', undefined, 'deleted', 1],
      ['n.ts', 'o.ts', 'rename-changed', 1],
    ]);
  });
});

const stubRoutes = (routes: Record<string, unknown>) => {
  const fetchMock = vi.fn((url: string) => {
    const hit = Object.keys(routes).find((key) => url.includes(key));
    if (hit === undefined) return Promise.resolve(new Response('', { status: 404 }));
    const body = routes[hit];
    return Promise.resolve(body instanceof Response ? body : json(body));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

describe('the new pull request fields', () => {
  it('maps the new pull request fields', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        json({
          ...apiPull,
          labels: [{ name: 'bug', color: 'd73a4a' }, { color: 'x' }],
          requested_reviewers: [{ login: 'r', avatar_url: 'https://a/r.png' }],
          requested_teams: [{ name: 'core' }],
          node_id: 'PR_kw1',
          mergeable: false,
          mergeable_state: 'behind',
          auto_merge: { merge_method: 'squash' },
          head: { ref: 'topic', sha: 'abc', repo: { full_name: 'fork/b', node_id: 'R_fork' } },
          base: { ref: 'main', repo: { full_name: 'a/b' } },
          merged_at: null,
          closed_at: '2026-01-04T00:00:00Z',
          comments: 2,
          review_comments: 3,
          commits: 4,
        })
      )
    );
    const pull = await fetchPullRequest(ref, undefined);
    expect(pull).toMatchObject({
      labels: [{ name: 'bug', color: 'd73a4a' }],
      requestedReviewers: [{ login: 'r', name: null, avatarUrl: 'https://a/r.png' }],
      requestedTeams: ['core'],
      nodeId: 'PR_kw1',
      mergeable: false,
      mergeableState: 'behind',
      autoMerge: { method: 'squash' },
      headSha: 'abc',
      headRepo: 'fork/b',
      headRepoId: 'R_fork',
      baseRepo: 'a/b',
      mergedAt: null,
      closedAt: '2026-01-04T00:00:00Z',
      commentCount: 2,
      reviewCommentCount: 3,
      commitCount: 4,
    });
  });

  it('has no head repository for a deleted fork', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(json({ ...apiPull, head: { ref: 't', sha: 's', repo: null } }))
    );
    expect((await fetchPullRequest(ref, undefined)).headRepo).toBeNull();
  });

  it('marks bots', async () => {
    const author = async (user: object) => {
      vi.stubGlobal('fetch', () => Promise.resolve(json({ ...apiPull, user })));
      return (await fetchPullRequest(ref, undefined)).author?.isBot;
    };
    expect(await author({ login: 'x', type: 'Bot' })).toBe(true);
    expect(await author({ login: 'dependabot[bot]', type: 'User' })).toBe(true);
    expect(await author({ login: 'x', type: 'User' })).toBe(false);
  });
});

describe('fetchChecks', () => {
  const run = (status: string, conclusion: string | null, extra = {}) => ({
    name: `${status}/${conclusion}`,
    status,
    conclusion,
    html_url: 'https://github.com/a/b/runs/1',
    output: { title: 'Title' },
    started_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    ...extra,
  });

  it.each([
    ['queued', null, 'pending'],
    ['in_progress', null, 'pending'],
    ['waiting', null, 'pending'],
    ['requested', null, 'pending'],
    ['pending', null, 'pending'],
    ['completed', 'action_required', 'action-required'],
    ['completed', 'success', 'success'],
    ['completed', 'failure', 'failure'],
    ['completed', 'timed_out', 'failure'],
    ['completed', 'startup_failure', 'failure'],
    ['completed', 'cancelled', 'cancelled'],
    ['completed', 'skipped', 'skipped'],
    ['completed', 'neutral', 'neutral'],
    ['completed', 'stale', 'neutral'],
  ])('maps check runs: %s %s is %s', async (status, conclusion, expected) => {
    stubRoutes({ '/check-runs': { check_runs: [run(status, conclusion)] }, '/status': {} });
    expect((await fetchChecks(ref, 'sha', undefined)).items).toEqual([
      {
        name: `${status}/${conclusion}`,
        status: expected,
        description: 'Title',
        url: 'https://github.com/a/b/runs/1',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
  });

  it.each([
    ['pending', 'pending'],
    ['success', 'success'],
    ['failure', 'failure'],
    ['error', 'failure'],
  ])('maps commit statuses: %s is %s', async (state, expected) => {
    stubRoutes({
      '/check-runs': {},
      '/status': {
        statuses: [
          {
            context: 'ci/x',
            state,
            description: 'D',
            target_url: 'https://ci/x',
            updated_at: '2026-01-02T00:00:00Z',
          },
        ],
      },
    });
    expect((await fetchChecks(ref, 'sha', undefined)).items).toEqual([
      {
        name: 'ci/x',
        status: expected,
        description: 'D',
        url: 'https://ci/x',
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ]);
  });

  it('keeps the newer of a run and a status with one name', async () => {
    const status = (updated_at: string) => ({
      statuses: [{ context: 'ci', state: 'failure', updated_at }],
    });
    const runs = {
      check_runs: [
        run('completed', 'success', { name: 'ci', completed_at: '2026-01-02T00:00:00Z' }),
      ],
    };
    stubRoutes({ '/check-runs': runs, '/status': status('2026-01-03T00:00:00Z') });
    const statuses = async () =>
      (await fetchChecks(ref, 'sha', undefined)).items.map((c) => c.status);
    expect(await statuses()).toEqual(['failure']);
    stubRoutes({ '/check-runs': runs, '/status': status('2026-01-01T00:00:00Z') });
    expect(await statuses()).toEqual(['success']);
  });

  it('keeps only http and https links', async () => {
    stubRoutes({
      '/check-runs': {
        check_runs: [
          run('completed', 'success', {
            name: 'a',
            html_url: 'javascript:alert(1)',
            details_url: 'javascript:alert(1)',
          }),
          run('completed', 'success', {
            name: 'b',
            html_url: null,
            details_url: 'http://ci.example/b',
          }),
          run('completed', 'success', { name: 'c', html_url: ' JavaScript:alert(1)' }),
        ],
      },
      '/status': {
        statuses: [
          { context: 'd', state: 'success', target_url: 'javascript:alert(1)' },
          { context: 'e', state: 'success', target_url: 'data:text/html,x' },
          { context: 'f', state: 'success', target_url: '/relative' },
          { context: 'g', state: 'success', target_url: 'https://ci.example/g' },
        ],
      },
    });
    const { items } = await fetchChecks(ref, 'sha', undefined);
    expect(items.map((check) => [check.name, check.url])).toEqual([
      ['a', null],
      ['b', 'http://ci.example/b'],
      ['c', null],
      ['d', null],
      ['e', null],
      ['f', null],
      ['g', 'https://ci.example/g'],
    ]);
  });

  it('checks 404 is no checks', async () => {
    stubRoutes({});
    expect(await fetchChecks(ref, 'sha', undefined)).toEqual({ items: [], truncated: false });
  });

  it('shows the statuses when the check runs fail', async () => {
    stubRoutes({
      '/check-runs': new Response('{}', { status: 403 }),
      '/status': { statuses: [{ context: 'ci/x', state: 'failure', target_url: null }] },
    });
    const { items } = await fetchChecks(ref, 'sha', undefined);
    expect(items.map((check) => [check.name, check.status])).toEqual([['ci/x', 'failure']]);
  });

  it('shows the check runs when the statuses fail', async () => {
    stubRoutes({
      '/check-runs': { check_runs: [run('completed', 'success', { name: 'build' })] },
      '/status': new Response('', { status: 500 }),
    });
    const { items } = await fetchChecks(ref, 'sha', undefined);
    expect(items.map((check) => check.name)).toEqual(['build']);
  });

  it('counts a 404 of one as none beside the failure of the other', async () => {
    stubRoutes({ '/check-runs': new Response('', { status: 500 }) });
    expect(await fetchChecks(ref, 'sha', undefined)).toEqual({ items: [], truncated: false });
  });

  it('fails when both fail', async () => {
    stubRoutes({
      '/check-runs': new Response('', { status: 500 }),
      '/status': new Response('', { status: 502 }),
    });
    await expect(fetchChecks(ref, 'sha', undefined)).rejects.toEqual(
      new GitHubError('failed', 500)
    );
  });

  it('marks the checks cut when GitHub has more check runs than it sent', async () => {
    const hundred = Array.from({ length: 100 }, (_, index) =>
      run('completed', 'success', { name: `job ${index}` })
    );
    stubRoutes({ '/check-runs': { total_count: 150, check_runs: hundred }, '/status': {} });
    const cut = await fetchChecks(ref, 'sha', undefined);
    expect(cut.items).toHaveLength(100);
    expect(cut.truncated).toBe(true);
    stubRoutes({ '/check-runs': { total_count: 100, check_runs: hundred }, '/status': {} });
    expect((await fetchChecks(ref, 'sha', undefined)).truncated).toBe(false);
  });

  it('marks the checks cut when GitHub has more statuses than it sent', async () => {
    const statuses = Array.from({ length: 100 }, (_, index) => ({
      context: `ci/${index}`,
      state: 'success',
    }));
    stubRoutes({ '/check-runs': {}, '/status': { total_count: 120, statuses } });
    expect((await fetchChecks(ref, 'sha', undefined)).truncated).toBe(true);
  });
});

describe('fetchBehindBy', () => {
  it('compares by head sha', async () => {
    const fetchMock = stubRoutes({ '/compare/': { behind_by: 5, files: [] } });
    expect(await fetchBehindBy(ref, 'main', 'abc123', undefined)).toBe(5);
    expect(String(fetchMock.mock.calls[0]![0]).endsWith('/compare/main...abc123')).toBe(true);
  });
});

describe('commit paths', () => {
  it('compares with a base branch whose name has a slash through MindRoom', async () => {
    const github = vi.fn((url: string) =>
      Promise.resolve(json(url.includes('/compare/release/1.0...abc123') ? { behind_by: 2 } : {}))
    );
    const { server } = githubServer(github);
    const via = { server, account: 'a', disconnected: vi.fn(), unreadable: vi.fn() };
    expect(await fetchBehindBy(ref, 'release/1.0', 'abc123', via)).toBe(2);
    // The stand-in refuses what MindRoom refuses, such as an encoded slash.
    await expect(
      getRefused(server, '/repos/a/b/compare/release%2F1.0...abc123')
    ).resolves.toMatchObject({ status: 400, body: { error: 'github_path_not_allowed' } });
  });

  it('encodes the head sha and a commit sha like the base branch', async () => {
    const fetchMock = stubRoutes({ '/compare/': { behind_by: 0 }, '/commits/': { files: [] } });
    await fetchChecks(ref, 'a/b?c', undefined);
    await fetchBehindBy(ref, 'x/y', 'a/b?c', undefined);
    await fetchCommitFiles(ref, 'a/b?c', undefined);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.github.com/repos/a/b/commits/a%2Fb%3Fc/check-runs?per_page=100',
      'https://api.github.com/repos/a/b/commits/a%2Fb%3Fc/status?per_page=100',
      // A branch's own slashes stay, as MindRoom refuses a segment that decodes to one.
      'https://api.github.com/repos/a/b/compare/x/y...a%2Fb%3Fc',
      'https://api.github.com/repos/a/b/commits/a%2Fb%3Fc',
    ]);
  });
});

describe('the lists', () => {
  const UUID = '11111111-2222-3333-4444-555555555555';
  const SIGNED = `https://private-user-images.githubusercontent.com/1/2-${UUID}.png?jwt=x&v=1`;
  const HTML = `<p><img src="${SIGNED.replace('&', '&amp;')}" alt="a"></p>`;
  const accepts = (fetchMock: ReturnType<typeof stubRoutes>) =>
    (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(([url, init]) => [
      new URL(url).pathname,
      new Headers(init.headers).get('accept'),
    ]);

  it("asks for the bodies' HTML, and maps its images, on every list with a body", async () => {
    const item = { id: 1, state: 'COMMENTED', user: { login: 'c' }, body: 'b', body_html: HTML };
    const fetchMock = stubRoutes({
      '/pulls/1/reviews': [item],
      '/pulls/1/comments': [item],
      '/issues/1/comments': [item],
      '/pulls/1/commits': [],
      '/pulls/1': { ...apiPull, body_html: HTML },
    });
    const lists = [
      (await fetchReviews(ref, undefined)).items[0]!,
      (await fetchReviewComments(ref, undefined)).items[0]!,
      (await fetchConversationComments(ref, undefined)).items[0]!,
      await fetchPullRequest(ref, undefined),
    ];
    await fetchCommits(ref, undefined);
    for (const answer of lists) {
      expect(answer.images).toEqual({ byUrl: {}, byAttachment: { [UUID]: SIGNED } });
    }
    expect(accepts(fetchMock)).toEqual([
      ['/repos/a/b/pulls/1/reviews', 'application/vnd.github.full+json'],
      ['/repos/a/b/pulls/1/comments', 'application/vnd.github.full+json'],
      ['/repos/a/b/issues/1/comments', 'application/vnd.github.full+json'],
      ['/repos/a/b/pulls/1', 'application/vnd.github.full+json'],
      // A list without bodies keeps the plain media type.
      ['/repos/a/b/pulls/1/commits', 'application/vnd.github+json'],
    ]);
  });

  it('drops pending reviews', async () => {
    const review = (id: number, state: string) => ({
      id,
      state,
      user: { login: 'r' },
      body: 'b',
      commit_id: 'c',
      submitted_at: '2026-01-01T00:00:00Z',
      html_url: 'https://github.com/a/b/pull/1#r',
    });
    stubRoutes({
      '/pulls/1/reviews': [review(1, 'PENDING'), review(2, 'APPROVED'), review(3, 'DISMISSED')],
    });
    const { items, truncated } = await fetchReviews(ref, undefined);
    expect(items.map((r) => [r.id, r.state])).toEqual([
      [2, 'APPROVED'],
      [3, 'DISMISSED'],
    ]);
    expect(truncated).toBe(false);
    expect(items[0]).toMatchObject({ author: { login: 'r' }, body: 'b', commitId: 'c' });
  });

  it('maps reactions in order without zeros', async () => {
    stubRoutes({
      '/issues/1/comments': [
        {
          id: 7,
          user: { login: 'c' },
          body: 'hi',
          created_at: '2026-01-01T00:00:00Z',
          html_url: 'u',
          reactions: { eyes: 1, '+1': 2, heart: 0, rocket: 3, total_count: 6, url: 'x' },
        },
      ],
    });
    const { items } = await fetchConversationComments(ref, undefined);
    expect(items[0]!.reactions).toEqual([
      { content: '+1', count: 2 },
      { content: 'rocket', count: 3 },
      { content: 'eyes', count: 1 },
    ]);
  });

  it('marks outdated review comments', async () => {
    const base = { user: { login: 'c' }, path: 'a.ts', side: 'RIGHT', commit_id: 'c' };
    stubRoutes({
      '/pulls/1/comments': [
        { ...base, id: 1, line: 4, original_line: 4, position: 2, pull_request_review_id: 9 },
        { ...base, id: 2, line: null, original_line: 3, position: null, in_reply_to_id: 1 },
      ],
    });
    const { items } = await fetchReviewComments(ref, undefined);
    expect(items.map((c) => [c.id, c.outdated, c.line, c.originalLine, c.inReplyToId])).toEqual([
      [1, false, 4, 4, null],
      [2, true, null, 3, 1],
    ]);
    expect(items[0]).toMatchObject({ reviewId: 9, path: 'a.ts', side: 'RIGHT', commitId: 'c' });
  });

  it('maps commits', async () => {
    stubRoutes({
      '/pulls/1/commits': [
        {
          sha: 's1',
          html_url: 'https://github.com/a/b/commit/s1',
          commit: {
            message: 'Head line\n\nBody',
            author: { name: 'Ann', date: '2026-01-01T00:00:00Z' },
            committer: { date: '2026-01-02T00:00:00Z' },
          },
          author: { login: 'ann' },
        },
      ],
    });
    const { items } = await fetchCommits(ref, undefined);
    expect(items).toEqual([
      {
        sha: 's1',
        headline: 'Head line',
        author: expect.objectContaining({ login: 'ann' }),
        authorName: 'Ann',
        committedAt: '2026-01-02T00:00:00Z',
        url: 'https://github.com/a/b/commit/s1',
      },
    ]);
  });

  it('pages lists and stops at ten pages with truncated', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(json(Array.from({ length: 100 }, (_, i) => ({ id: i, state: 'APPROVED' }))))
    );
    vi.stubGlobal('fetch', fetchMock);
    const { items, truncated } = await fetchReviews(ref, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(items).toHaveLength(1000);
    expect(truncated).toBe(true);
  });

  it('is not truncated when the tenth page is short', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        json(
          Array.from(
            { length: Number(new URL(url).searchParams.get('page')) < 10 ? 100 : 5 },
            () => ({
              id: 1,
              state: 'APPROVED',
            })
          )
        )
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchReviews(ref, undefined)).truncated).toBe(false);
  });
});

describe('fetchDiffBlob', () => {
  const sha = 'b'.repeat(40);
  const blobPath = `/repos/a/b/git/blobs/${sha}`;
  const rawMedia = 'application/vnd.github.raw+json';
  const proxy = (answer: () => unknown) => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => answer());
    return {
      server: {
        origin: 'https://meadow.example.org',
        request: request as MindroomServer['request'],
      },
      account: 'gardener',
      disconnected: vi.fn(),
      unreadable: vi.fn(),
      request,
    };
  };

  it('downloads one bounded raw blob through MindRoom and preserves its text', async () => {
    const text = '\uFEFFé\n';
    const via = proxy(() => ({ status: 200, body: text }));
    await expect(fetchDiffBlob(ref, sha, via)).resolves.toBe(text);
    expect(via.request).toHaveBeenCalledOnce();
    const [path, init] = via.request.mock.calls[0]!;
    expect(path).toBe('/api/github/request');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      method: 'GET',
      path: blobPath,
      accept: rawMedia,
      max_bytes: 128 * 1024,
    });
  });

  it.each([
    [502, 'github_response_too_large'],
    [502, 'github_response_not_text'],
    [422, 'github_request_invalid'],
  ])('leaves the patch alone on MindRoom %d %s', async (status, error) => {
    const via = proxy(() => {
      throw new MindroomServerError('Proxy refusal', status, { error });
    });
    await expect(fetchDiffBlob(ref, sha, via)).resolves.toBeNull();
    expect(via.request).toHaveBeenCalledOnce();
  });

  it.each(['bud\0\n', 'version https://git-lfs.github.com/spec/v1\n'])(
    'rejects unsupported proxy text %j',
    async (body) => {
      await expect(
        fetchDiffBlob(
          ref,
          sha,
          proxy(() => ({ status: 200, body }))
        )
      ).resolves.toBeNull();
    }
  );

  it('leaves the patch alone when the proxy relays GitHub 404', async () => {
    await expect(
      fetchDiffBlob(
        ref,
        sha,
        proxy(() => ({ status: 404, body: null }))
      )
    ).resolves.toBeNull();
  });

  it('rejects other proxy failures rather than caching no blob', async () => {
    const broken = proxy(() => {
      throw new MindroomServerError('Proxy failure', 502, { error: 'github_unreachable' });
    });
    const offline = proxy(() => {
      throw new TypeError('Failed to fetch');
    });
    const upstream = proxy(() => ({ status: 503, body: null }));
    for (const [via, status] of [
      [broken, 0],
      [offline, 0],
      [upstream, 503],
    ] as const) {
      await expect(fetchDiffBlob(ref, sha, via)).rejects.toMatchObject({ kind: 'failed', status });
    }
  });

  it('throws on a GitHub rate limit relayed by MindRoom and suppresses the next download', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 0, 1), toFake: ['Date'] });
    try {
      const via = proxy(() => ({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
      await expect(fetchDiffBlob(ref, sha, via)).rejects.toMatchObject({ kind: 'rateLimited' });
      await expect(fetchDiffBlob(ref, sha, via)).rejects.toMatchObject({ kind: 'rateLimited' });
      expect(via.request).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads small raw UTF-8 directly with the token', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('é\n'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchDiffBlob(ref, sha, 'blob-fixture')).toBe('é\n');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Accept: rawMedia });
  });

  it.each([true, false])('cancels an oversized stream (length header: %s)', async (withLength) => {
    const max = 128 * 1024;
    let reads = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads += 1;
          const size = reads === 1 ? max : 1;
          if (reads === 3) controller.close();
          else controller.enqueue(new Uint8Array(size).fill(0x61));
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    const headers = withLength ? { 'content-length': String(max + 1) } : undefined;
    const fetchMock = stubRoutes({ '/git/blobs/': new Response(body, { headers }) });
    expect(await fetchDiffBlob(ref, sha, 'blob-fixture')).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(reads).toBe(withLength ? 0 : 2);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['404 (including submodule commit IDs)', new Response(null, { status: 404 })],
    ['binary data with a NUL', new Response(Uint8Array.of(0, 97))],
    ['invalid UTF-8', new Response(Uint8Array.of(0xff))],
    ['an LFS pointer', new Response('version https://git-lfs.github.com/spec/v1\n')],
  ])('falls back permanently on %s', async (_case, body) => {
    stubRoutes({ '/git/blobs/': body });
    expect(await fetchDiffBlob(ref, sha, 'blob-fixture')).toBeNull();
  });

  it.each([403, 502])('rejects HTTP %d instead of caching no content', async (status) => {
    stubRoutes({ '/git/blobs/': new Response(null, { status }) });
    await expect(fetchDiffBlob(ref, sha, 'blob-fixture')).rejects.toMatchObject({ status });
  });

  it('rejects a network failure instead of caching no content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(fetchDiffBlob(ref, sha, 'blob-fixture')).rejects.toMatchObject({ status: 0 });
  });

  it.each([
    ['with Retry-After', new Response(null, { status: 403, headers: { 'retry-after': '60' } })],
    [
      'without Retry-After',
      json({ message: 'You have exceeded a secondary rate limit.' }, { status: 403 }),
    ],
  ])('rejects the same SHA during cooldown %s and reads it after reset', async (label, answer) => {
    const token = `limited-blob-fixture-${label}`;
    vi.useFakeTimers({ now: Date.UTC(2026, 0, 1), toFake: ['Date'] });
    try {
      const fetchMock = stubRoutes({ '/git/blobs/': answer });
      await expect(fetchDiffBlob(ref, sha, token)).rejects.toMatchObject({ kind: 'rateLimited' });
      await expect(fetchDiffBlob(ref, sha, token)).rejects.toMatchObject({ kind: 'rateLimited' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 60_000);
      fetchMock.mockImplementation(async () => new Response('bud\n'));
      await expect(fetchDiffBlob(ref, sha, token)).resolves.toBe('bud\n');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fetchCommitFiles', () => {
  it("maps one commit's files", async () => {
    const fetchMock = stubRoutes({
      '/commits/abc': {
        files: [
          { filename: 'a.ts', status: 'added', additions: 1, deletions: 0, patch: '@@', sha: 'c0' },
          // A file without a blob SHA.
          { filename: 'lib', status: 'modified', additions: 0, deletions: 0 },
        ],
      },
    });
    expect(await fetchCommitFiles(ref, 'abc', 'tok')).toEqual([
      {
        path: 'a.ts',
        previousPath: null,
        status: 'added',
        additions: 1,
        deletions: 0,
        patch: '@@',
        sha: 'c0',
        url: 'https://github.com/a/b/commit/abc',
      },
      {
        path: 'lib',
        previousPath: null,
        status: 'modified',
        additions: 0,
        deletions: 0,
        patch: null,
        sha: null,
        url: 'https://github.com/a/b/commit/abc',
      },
    ]);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://api.github.com/repos/a/b/commits/abc'
    );
  });
});

const writeRef = { owner: 'o', repo: 'r', number: 7 };

const writePull: PullRequest = {
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
  headRepo: 'fork/r',
  headRepoId: 'R_fork',
  baseRepo: 'o/r',
  mergedAt: null,
  closedAt: null,
  commentCount: 0,
  reviewCommentCount: 0,
  commitCount: 1,
  createdAt: '',
  updatedAt: '',
  baseRef: 'main',
  headRef: 'feat/a b#1',
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  url: 'https://github.com/o/r/pull/7',
};

type Sent = { method: string; url: string; body: unknown; authorization: string | null };

/** What `fetch` was asked, for each call, with the body parsed back. */
function sentRequests(fetchMock: ReturnType<typeof vi.fn>): Sent[] {
  return fetchMock.mock.calls.map(([url, init]) => {
    const { method, body, headers } = init as RequestInit;
    return {
      method: String(method),
      url: String(url),
      body: typeof body === 'string' ? JSON.parse(body) : body,
      authorization: new Headers(headers).get('Authorization'),
    };
  });
}

async function send(action: PullRequestAction): Promise<Sent> {
  const fetchMock = vi.fn(() => Promise.resolve(json({ data: {} })));
  vi.stubGlobal('fetch', fetchMock);
  await runPullRequestAction(writeRef, writePull, action, 'squash', 'tok');
  const sent = sentRequests(fetchMock);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.authorization).toBe('Bearer tok');
  return sent[0]!;
}

describe('runPullRequestAction', () => {
  it('merges with the method and the loaded head sha', async () => {
    expect(await send('merge')).toMatchObject({
      method: 'PUT',
      url: 'https://api.github.com/repos/o/r/pulls/7/merge',
      body: { merge_method: 'squash', sha: 'head7' },
    });
  });

  it.each([
    ['close', 'closed'],
    ['reopen', 'open'],
  ] as const)('%ss by state', async (action, state) => {
    expect(await send(action)).toMatchObject({
      method: 'PATCH',
      url: 'https://api.github.com/repos/o/r/pulls/7',
      body: { state },
    });
  });

  /**
   * Deletes the branch while it points at `oid` in its repository (null: it is gone) and the
   * pull request, closed when the panel read it, has `state` on GitHub.
   */
  async function deleteBranch(oid: string | null, state = 'CLOSED') {
    const node = { ref: oid === null ? null : { target: { oid } } };
    const read = { node, repository: { pullRequest: { state } } };
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(
        json({ data: String(init.body).includes('updateRefs') ? { updateRefs: {} } : read })
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const outcome = await runPullRequestAction(
      writeRef,
      writePull,
      'delete-branch',
      'squash',
      'tok'
    ).catch((error: unknown) => error);
    return { outcome, sent: sentRequests(fetchMock) };
  }

  it('deletes the branch in the head repository only where the pull request left it', async () => {
    const { outcome, sent } = await deleteBranch('head7');
    expect(outcome).toBe('done');
    // Never REST's unconditional DELETE of the ref: GitHub checks the commit as it deletes.
    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'POST https://api.github.com/graphql',
      'POST https://api.github.com/graphql',
    ]);
    expect(sent[0]!.body).toMatchObject({
      variables: { repositoryId: 'R_fork', ref: 'refs/heads/feat/a b#1' },
    });
    expect((sent[1]!.body as { query: string }).query).toContain('updateRefs');
    expect(sent[1]!.body).toMatchObject({
      variables: {
        input: {
          repositoryId: 'R_fork',
          refUpdates: [
            {
              name: 'refs/heads/feat/a b#1',
              beforeOid: 'head7',
              afterOid: '0000000000000000000000000000000000000000',
            },
          ],
        },
      },
    });
    expect(sent.every(({ authorization }) => authorization === 'Bearer tok')).toBe(true);
  });

  it('counts a branch already gone as deleted, and deletes nothing', async () => {
    const { outcome, sent } = await deleteBranch(null);
    expect(outcome).toBe('done');
    expect(sent).toHaveLength(1);
    expect((sent[0]!.body as { query: string }).query).not.toContain('updateRefs');
  });

  // As T3 Code: deleting the branch of an open pull request closes it.
  it.each(['head7', null])(
    'does not delete the branch (at %s) of a pull request that was opened again',
    async (oid) => {
      const { outcome, sent } = await deleteBranch(oid, 'OPEN');
      expect(outcome).toMatchObject({ kind: 'pullRequestOpen' });
      expect(sent).toHaveLength(1);
      expect((sent[0]!.body as { query: string }).query).not.toContain('updateRefs');
    }
  );

  it('does not delete a branch that got commits since the pull request', async () => {
    const { outcome, sent } = await deleteBranch('newer');
    expect(outcome).toMatchObject({ kind: 'branchMoved' });
    expect(sent).toHaveLength(1);
    expect((sent[0]!.body as { query: string }).query).not.toContain('updateRefs');
  });

  it.each([
    ['ready', 'markPullRequestReadyForReview'],
    ['draft', 'convertPullRequestToDraft'],
    ['disable-auto-merge', 'disablePullRequestAutoMerge'],
  ] as const)('%s runs %s on the node id', async (action, mutation) => {
    const sent = await send(action);
    expect(sent).toMatchObject({
      method: 'POST',
      url: 'https://api.github.com/graphql',
      body: { variables: { pullRequestId: 'PR_kw7' } },
    });
    expect((sent.body as { query: string }).query).toContain(mutation);
  });

  it('enables auto-merge with the method and the expected head', async () => {
    const sent = await send('enable-auto-merge');
    expect(sent).toMatchObject({
      method: 'POST',
      url: 'https://api.github.com/graphql',
      body: {
        variables: { pullRequestId: 'PR_kw7', mergeMethod: 'SQUASH', expectedHeadOid: 'head7' },
      },
    });
    expect((sent.body as { query: string }).query).toContain('enablePullRequestAutoMerge');
  });

  // One path for both, as T3 Code: REST's update-branch only answers 202 Accepted.
  it.each([
    ['update-branch', 'MERGE'],
    ['update-branch-rebase', 'REBASE'],
  ] as const)(
    '%s updates the branch by %s with the expected head',
    async (action, updateMethod) => {
      const sent = await send(action);
      expect(sent).toMatchObject({
        method: 'POST',
        url: 'https://api.github.com/graphql',
        body: {
          variables: { pullRequestId: 'PR_kw7', expectedHeadOid: 'head7', updateMethod },
        },
      });
      const { query } = sent.body as { query: string };
      expect(query).toContain('updatePullRequestBranch');
      // The answer tells whether the branch has its new commit yet.
      expect(query.replace(/\s+/g, ' ')).toContain('pullRequest { headRefOid }');
    }
  );

  it.each([
    ['a new head is done', { pullRequest: { headRefOid: 'head8' } }, 'done'],
    ['the head it had is only requested', { pullRequest: { headRefOid: 'head7' } }, 'requested'],
    ['no pull request is only requested', { pullRequest: null }, 'requested'],
    ['nothing is only requested', null, 'requested'],
  ] as const)(
    'an update of the branch GitHub answers with %s',
    async (_name, updatePullRequestBranch, outcome) => {
      vi.stubGlobal('fetch', () => Promise.resolve(json({ data: { updatePullRequestBranch } })));
      expect(
        await runPullRequestAction(writeRef, writePull, 'update-branch', 'squash', 'tok')
      ).toBe(outcome);
    }
  );

  it.each(['merge', 'close', 'reopen', 'ready', 'draft', 'enable-auto-merge'] as const)(
    '%s that GitHub took is done',
    async (action) => {
      vi.stubGlobal('fetch', () => Promise.resolve(json({ data: {} })));
      expect(await runPullRequestAction(writeRef, writePull, action, 'squash', 'tok')).toBe('done');
    }
  );

  it('does not touch the read rate limit', async () => {
    // A write refused for its limit does not hold back the reads after it.
    const limited = { status: 403, headers: { 'x-ratelimit-remaining': '0' } };
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', limited)));
    await expect(
      runPullRequestAction(writeRef, writePull, 'close', 'squash', 'tok')
    ).rejects.toBeInstanceOf(GitHubWriteError);
    vi.stubGlobal('fetch', () => Promise.resolve(json(apiPull)));
    await expect(fetchPullRequest(writeRef, 'tok')).resolves.toMatchObject({ title: 'T' });
  });
});

describe('fetchHeadBranch', () => {
  const closed = { pullRequest: { state: 'CLOSED' } };
  const read = (data: unknown) => {
    const fetchMock = vi.fn(() => Promise.resolve(json({ data })));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it("reads where the branch points in the head repository, and the pull request's state now", async () => {
    const fetchMock = read({ node: { ref: { target: { oid: 'abc' } } }, repository: closed });
    expect(await fetchHeadBranch(writeRef, writePull, 'tok')).toEqual({
      sha: 'abc',
      pullRequestOpen: false,
    });
    expect(sentRequests(fetchMock)).toMatchObject([
      {
        method: 'POST',
        url: 'https://api.github.com/graphql',
        body: {
          variables: {
            repositoryId: 'R_fork',
            ref: 'refs/heads/feat/a b#1',
            owner: 'o',
            repo: 'r',
            number: 7,
          },
        },
        authorization: 'Bearer tok',
      },
    ]);
  });

  it('has no commit for a branch that is gone', async () => {
    read({ node: { ref: null }, repository: closed });
    expect((await fetchHeadBranch(writeRef, writePull, 'tok')).sha).toBeNull();
  });

  it.each([
    ['OPEN', true],
    ['CLOSED', false],
    ['MERGED', false],
  ])('with the pull request %s it is open: %s', async (state, open) => {
    read({ node: { ref: null }, repository: { pullRequest: { state } } });
    expect((await fetchHeadBranch(writeRef, writePull, 'tok')).pullRequestOpen).toBe(open);
  });

  it.each([
    ['no repository', { node: null, repository: closed }],
    ['a node that is no repository', { node: {}, repository: closed }],
    ['a branch without a commit', { node: { ref: { target: null } }, repository: closed }],
    ['no pull request', { node: { ref: null }, repository: { pullRequest: null } }],
    ['no state of the pull request', { node: { ref: null }, repository: null }],
  ])('fails on %s, which says nothing about the branch', async (_name, data) => {
    read(data);
    await expect(fetchHeadBranch(writeRef, writePull, 'tok')).rejects.toMatchObject({
      kind: 'failed',
    });
  });
});

const apiRepository = {
  viewerPermission: 'WRITE',
  mergeCommitAllowed: false,
  squashMergeAllowed: true,
  rebaseMergeAllowed: true,
  autoMergeAllowed: true,
  defaultBranchRef: { name: 'main' },
};

describe('fetchRepository', () => {
  it("maps the repository's settings", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json({ data: { repository: apiRepository } })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchRepository('o', 'r', 'tok')).toEqual({
      canWrite: true,
      mergeMethods: ['squash', 'rebase'],
      autoMergeAllowed: true,
      defaultBranch: 'main',
    });
    const [sent] = sentRequests(fetchMock);
    expect(sent).toMatchObject({
      method: 'POST',
      url: 'https://api.github.com/graphql',
      body: { variables: { owner: 'o', repo: 'r' } },
      authorization: 'Bearer tok',
    });
  });

  it('keeps the merge methods in order', async () => {
    const all = { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true };
    vi.stubGlobal('fetch', () =>
      Promise.resolve(json({ data: { repository: { ...apiRepository, ...all } } }))
    );
    expect((await fetchRepository('o', 'r', 'tok')).mergeMethods).toEqual([
      'merge',
      'squash',
      'rebase',
    ]);
  });

  it.each([
    ['ADMIN', true],
    ['MAINTAIN', true],
    ['WRITE', true],
    ['TRIAGE', false],
    ['READ', false],
  ])('with %s can write: %s', async (viewerPermission, canWrite) => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(json({ data: { repository: { ...apiRepository, viewerPermission } } }))
    );
    expect((await fetchRepository('o', 'r', 'tok')).canWrite).toBe(canWrite);
  });
});

describe('the write error kinds', () => {
  async function failure(response: Response | Error, token = 'tok') {
    vi.stubGlobal('fetch', () =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
    );
    const error = await runPullRequestAction(writeRef, writePull, 'close', 'squash', token).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(GitHubWriteError);
    return error as GitHubWriteError;
  }

  async function graphqlFailure(response: Response, token = 'tok') {
    vi.stubGlobal('fetch', () => Promise.resolve(response));
    const error = await fetchRepository('o', 'r', token).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubWriteError);
    return error as GitHubWriteError;
  }

  it('is no access when the token may not write', async () => {
    const body = { message: 'Resource not accessible by personal access token' };
    expect(await failure(json(body, { status: 403 }))).toMatchObject({
      kind: 'noAccess',
      status: 403,
    });
    expect((await failure(new Response('', { status: 404 }))).kind).toBe('noAccess');
  });

  it('is a bad token on 401', async () => {
    expect(await failure(json({ message: 'Bad credentials' }, { status: 401 }))).toMatchObject({
      kind: 'badToken',
      status: 401,
    });
  });

  it.each([405, 409, 422])("is refused on %s, with GitHub's message", async (status) => {
    const error = await failure(json({ message: 'Pull Request is not mergeable' }, { status }));
    expect(error).toMatchObject({
      kind: 'refused',
      status,
      detail: 'Pull Request is not mergeable',
    });
  });

  it('is failed on any other status', async () => {
    expect(await failure(new Response('', { status: 500 }))).toMatchObject({
      kind: 'failed',
      status: 500,
    });
  });

  it("keeps GitHub's message on a failure it answered", async () => {
    expect(await failure(json({ message: 'Server Error' }, { status: 502 }))).toMatchObject({
      kind: 'failed',
      status: 502,
      detail: 'Server Error',
    });
  });

  it.each([
    ['429', { status: 429 }],
    ['403 with no requests left', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }],
    ['403 with a time to retry after', { status: 403, headers: { 'retry-after': '60' } }],
  ])("is rate limited on %s, with GitHub's message", async (_name, init) => {
    const message = 'You have exceeded a secondary rate limit.';
    expect(await failure(json({ message }, init))).toMatchObject({
      kind: 'rateLimited',
      status: init.status,
      detail: message,
    });
  });

  it("is rate limited on GraphQL's RATE_LIMITED", async () => {
    const errors = [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }];
    expect(await graphqlFailure(json({ errors }))).toMatchObject({
      kind: 'rateLimited',
      detail: 'API rate limit exceeded',
    });
  });

  it('is failed with status 0 when GitHub cannot be reached', async () => {
    expect(await failure(new TypeError('Failed to fetch'))).toMatchObject({
      kind: 'failed',
      status: 0,
    });
  });

  it("is refused on GraphQL's errors, though the answer is 200", async () => {
    const error = await graphqlFailure(json({ errors: [{ message: 'Head branch was modified' }] }));
    expect(error).toMatchObject({
      kind: 'refused',
      status: 200,
      detail: 'Head branch was modified',
    });
  });

  it.each(['FORBIDDEN', 'NOT_FOUND'])("is no access on GraphQL's %s", async (type) => {
    const error = await graphqlFailure(json({ errors: [{ type, message: 'No' }] }));
    expect(error.kind).toBe('noAccess');
  });

  it('maps GraphQL statuses as REST', async () => {
    expect((await graphqlFailure(new Response('', { status: 401 }))).kind).toBe('badToken');
    expect((await graphqlFailure(new Response('', { status: 403 }))).kind).toBe('noAccess');
    expect((await graphqlFailure(new Response('', { status: 404 }))).kind).toBe('noAccess');
  });

  it('is failed when GraphQL sends no repository', async () => {
    expect(await graphqlFailure(json({ data: { repository: null } }))).toMatchObject({
      kind: 'failed',
    });
  });

  it('never puts the token in a message or a detail', async () => {
    const echo = { message: 'Token secret is not allowed' };
    const errors = [
      await failure(json(echo, { status: 401 }), 'secret'),
      await failure(json(echo, { status: 403 }), 'secret'),
      await failure(json(echo, { status: 422 }), 'secret'),
      await failure(json(echo, { status: 500 }), 'secret'),
      await failure(new TypeError('secret'), 'secret'),
      await graphqlFailure(json({ errors: [echo] }), 'secret'),
      await graphqlFailure(json(echo, { status: 403 }), 'secret'),
    ];
    for (const error of errors) {
      expect(error.message).not.toContain('secret');
      expect(error.detail ?? '').not.toContain('secret');
    }
  });
});

describe('through MindRoom', () => {
  type Sent = { method: string; path: string; body?: unknown; accept?: string };
  /** A stand-in MindRoom server that answers each GitHub request with `answer(sent)`. */
  function viaServer(
    answer: (sent: Sent) => unknown,
    origin = 'https://mindroom.example.org'
  ): GitHubViaServer & {
    sent: Sent[];
    paths: string[];
    disconnected: Mock<() => void>;
    unreadable: Mock<() => void>;
  } {
    const sent: Sent[] = [];
    const paths: string[] = [];
    const request = (path: string, init?: RequestInit) => {
      paths.push(path);
      const payload = JSON.parse(String(init?.body)) as Sent;
      sent.push(payload);
      try {
        return Promise.resolve(answer(payload));
      } catch (error) {
        return Promise.reject(error);
      }
    };
    return {
      server: { origin, request: request as GitHubViaServer['server']['request'] },
      account: 'octo',
      disconnected: vi.fn(),
      unreadable: vi.fn(),
      sent,
      paths,
    };
  }
  const answered = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({
    status,
    body,
    headers,
  });

  it('reads through the server, never from GitHub itself', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const via = viaServer(() => answered(apiPull));
    expect((await fetchPullRequest(ref, via)).title).toBe('T');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(via.paths).toEqual(['/api/github/request']);
    expect(via.sent).toEqual([
      {
        method: 'GET',
        path: '/repos/a/b/pulls/1',
        accept: 'application/vnd.github.full+json',
      },
    ]);
  });

  it("maps GitHub's refusals as for a token", async () => {
    const notFound = viaServer(() => answered({ message: 'Not Found' }, 404));
    await expect(fetchPullRequest(ref, notFound)).rejects.toEqual(new GitHubError('notFound', 404));
    const broken = viaServer(() => answered('oops', 502));
    await expect(fetchPullRequest(ref, broken)).rejects.toEqual(new GitHubError('failed', 502));
  });

  it("holds the server's reads to its own rate limit", async () => {
    vi.useFakeTimers({ now: Date.parse('2026-01-01T00:00:00Z'), toFake: ['Date'] });
    try {
      const reset = String(Date.now() / 1000 + 600);
      const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset };
      const limited = viaServer(() => answered({ message: 'limit' }, 403, headers));
      const LIMITED = new GitHubError('rateLimited', 403);
      await expect(fetchPullRequest(ref, limited)).rejects.toEqual(LIMITED);
      await expect(fetchPullRequest(ref, limited)).rejects.toEqual(LIMITED);
      expect(limited.sent).toHaveLength(1);
      // Another server, a token and no token are other budgets.
      const other = viaServer(() => answered(apiPull), 'https://other.example.org');
      expect((await fetchPullRequest(ref, other)).title).toBe('T');
      vi.stubGlobal('fetch', () => Promise.resolve(json(apiPull)));
      expect((await fetchPullRequest(ref, 'tok')).title).toBe('T');
      expect((await fetchPullRequest(ref, undefined)).title).toBe('T');
      await expect(fetchPullRequest(ref, limited)).rejects.toEqual(LIMITED);
      expect(limited.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds one account's rate limit on a server to that account alone", async () => {
    vi.useFakeTimers({ now: Date.parse('2026-01-01T00:00:00Z'), toFake: ['Date'] });
    try {
      const reset = String(Date.now() / 1000 + 600);
      const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset };
      const alice = viaServer(() => answered({ message: 'limit' }, 403, headers));
      await expect(fetchPullRequest(ref, alice)).rejects.toEqual(
        new GitHubError('rateLimited', 403)
      );
      // Another account at the same origin is another budget.
      const bob = { ...viaServer(() => answered(apiPull)), account: 'bob' };
      expect((await fetchPullRequest(ref, bob)).title).toBe('T');
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes through the server, with the body and GitHub reason', async () => {
    const via = viaServer(() => answered({ message: 'Base branch was modified' }, 405));
    const error = await runPullRequestAction(writeRef, writePull, 'merge', 'squash', via).catch(
      (e: unknown) => e
    );
    expect(error).toEqual(new GitHubWriteError('refused', 405, 'Base branch was modified'));
    expect(via.sent).toEqual([
      {
        method: 'PUT',
        path: '/repos/o/r/pulls/7/merge',
        body: { merge_method: 'squash', sha: writePull.headSha },
        accept: 'application/vnd.github+json',
      },
    ]);
  });

  it('takes a write GitHub answered without a body', async () => {
    const via = viaServer(() => answered(null, 204));
    expect(await runPullRequestAction(writeRef, writePull, 'close', 'squash', via)).toBe('done');
  });

  it('asks GraphQL through the server', async () => {
    const via = viaServer(() => answered({ data: { repository: apiRepository } }));
    expect((await fetchRepository('o', 'r', via)).canWrite).toBe(true);
    expect(via.sent[0]).toMatchObject({ method: 'POST', path: '/graphql' });
    expect((via.sent[0]?.body as { variables: unknown }).variables).toEqual({
      owner: 'o',
      repo: 'r',
    });
  });

  it('says the connection went away when the server answers it is not connected', async () => {
    const gone = () => {
      throw new MindroomServerError('Conflict', 409, { error: 'github_not_connected' });
    };
    const read = viaServer(gone);
    await expect(fetchPullRequest(ref, read)).rejects.toEqual(new GitHubError('failed', 0));
    expect(read.disconnected).toHaveBeenCalledTimes(1);
    const write = viaServer(gone);
    await expect(
      runPullRequestAction(writeRef, writePull, 'close', 'squash', write)
    ).rejects.toEqual(new GitHubWriteError('failed', 0));
    expect(write.disconnected).toHaveBeenCalledTimes(1);
  });

  it('keeps the connection on any other refusal of the server', async () => {
    const via = viaServer(() => {
      throw new MindroomServerError('Unavailable', 503, { error: 'github_connection_unavailable' });
    });
    await expect(fetchPullRequest(ref, via)).rejects.toEqual(new GitHubError('failed', 0));
    expect(via.disconnected).not.toHaveBeenCalled();
    expect(via.unreadable).not.toHaveBeenCalled();
  });

  it('says the server cannot read the token saved there when it answers so, to a read and a write', async () => {
    const damaged = () => {
      throw new MindroomServerError('Unavailable', 503, { error: 'github_token_unreadable' });
    };
    const read = viaServer(damaged);
    await expect(fetchPullRequest(ref, read)).rejects.toEqual(new GitHubError('failed', 0));
    expect(read.unreadable).toHaveBeenCalledTimes(1);
    expect(read.disconnected).not.toHaveBeenCalled();
    const write = viaServer(damaged);
    await expect(
      runPullRequestAction(writeRef, writePull, 'close', 'squash', write)
    ).rejects.toEqual(new GitHubWriteError('failed', 0));
    expect(write.unreadable).toHaveBeenCalledTimes(1);
  });
});
