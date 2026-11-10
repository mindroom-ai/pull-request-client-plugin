import { parsePatchFiles } from '@pierre/diffs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GitHubError,
  fetchBehindBy,
  fetchChecks,
  fetchCommitFiles,
  fetchCommits,
  fetchConversationComments,
  fetchPullRequest,
  fetchPullRequestFiles,
  fetchReviewComments,
  fetchReviews,
  filePatch,
  parsePullRequestUrl,
  pullRequestUrl,
  type PullRequestFile,
} from './github';

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
      expect(headers.get('accept')).toBe('application/vnd.github+json');
      expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    }
  });

  it('maps an open pull request', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json(apiPull)));
    expect(await fetchPullRequest(ref, undefined)).toEqual({
      title: 'T',
      state: 'open',
      draft: false,
      body: '',
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
      mergeableState: null,
      autoMerge: null,
      headSha: '',
      headRepo: null,
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

  it('maps statuses', async () => {
    expect((await failure(undefined, new Response('', { status: 404 }))).kind).toBe('notFound');
    expect((await failure(undefined, new Response('', { status: 401 }))).kind).toBe('notFound');
    expect((await failure('secret', new Response('', { status: 401 }))).kind).toBe('badToken');
    const limited = { status: 403, headers: { 'x-ratelimit-remaining': '0' } };
    expect((await failure(undefined, new Response('', limited))).kind).toBe('rateLimited');
    expect((await failure(undefined, new Response('', { status: 429 }))).kind).toBe('rateLimited');
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
      const error = await failure('secret', new Response('secret', { status }));
      expect(error.message).not.toContain('secret');
    }
    expect((await failure('secret', new TypeError('secret'))).message).not.toContain('secret');
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
          mergeable_state: 'behind',
          auto_merge: { merge_method: 'squash' },
          head: { ref: 'topic', sha: 'abc', repo: { full_name: 'fork/b' } },
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
      mergeableState: 'behind',
      autoMerge: { method: 'squash' },
      headSha: 'abc',
      headRepo: 'fork/b',
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
    expect(await fetchChecks(ref, 'sha', undefined)).toEqual([
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
    expect(await fetchChecks(ref, 'sha', undefined)).toEqual([
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
    expect((await fetchChecks(ref, 'sha', undefined)).map((c) => c.status)).toEqual(['failure']);
    stubRoutes({ '/check-runs': runs, '/status': status('2026-01-01T00:00:00Z') });
    expect((await fetchChecks(ref, 'sha', undefined)).map((c) => c.status)).toEqual(['success']);
  });

  it('checks 404 is no checks', async () => {
    stubRoutes({});
    expect(await fetchChecks(ref, 'sha', undefined)).toEqual([]);
  });

  it('still fails on other errors', async () => {
    stubRoutes({ '/check-runs': new Response('', { status: 500 }), '/status': {} });
    await expect(fetchChecks(ref, 'sha', undefined)).rejects.toBeInstanceOf(GitHubError);
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
  it('encodes the head sha and a commit sha like the base branch', async () => {
    const fetchMock = stubRoutes({ '/compare/': { behind_by: 0 }, '/commits/': { files: [] } });
    await fetchChecks(ref, 'a/b?c', undefined);
    await fetchBehindBy(ref, 'x/y', 'a/b?c', undefined);
    await fetchCommitFiles(ref, 'a/b?c', undefined);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.github.com/repos/a/b/commits/a%2Fb%3Fc/check-runs?per_page=100',
      'https://api.github.com/repos/a/b/commits/a%2Fb%3Fc/status',
      'https://api.github.com/repos/a/b/compare/x%2Fy...a%2Fb%3Fc',
      'https://api.github.com/repos/a/b/commits/a%2Fb%3Fc',
    ]);
  });
});

describe('the lists', () => {
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
