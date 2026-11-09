import { parsePatchFiles } from '@pierre/diffs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GitHubError,
  fetchPullRequest,
  fetchPullRequestFiles,
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
      author: { login: 'u', avatarUrl: 'https://a/u.png', url: 'https://github.com/u' },
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
      'diff --git a/o.ts b/n.ts\nsimilarity index 100%\nrename from o.ts\nrename to n.ts\n--- a/o.ts\n+++ b/n.ts\n@@ -1 +1 @@\n-a\n+b\n'
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

  it('parses the assembled patches', () => {
    const patch = [
      file({ status: 'added', path: 'new.ts', patch: '@@ -0,0 +1 @@\n+a' }),
      file({ status: 'removed', path: 'gone.ts', patch: '@@ -1 +0,0 @@\n-a' }),
      file({ status: 'renamed', path: 'n.ts', previousPath: 'o.ts' }),
    ]
      .map((f) => filePatch(f))
      .join('');
    const files = parsePatchFiles(patch).flatMap((p) => p.files);
    // The brief's fixed header says similarity 100%, so the parser types a rename as pure, but it
    // still reads the hunks of the changes.
    expect(files.map((f) => [f.name, f.prevName, f.type, f.hunks.length])).toEqual([
      ['new.ts', undefined, 'new', 1],
      ['gone.ts', undefined, 'deleted', 1],
      ['n.ts', 'o.ts', 'rename-pure', 1],
    ]);
  });
});
