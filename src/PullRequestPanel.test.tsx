// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from './index';
import PullRequestPanel from './PullRequestPanel';

// The Code tab's diff libraries need a browser; the tab stands in as its file paths, what it was
// given of the threads, the commits and the chosen commit, how many review comments loaded of a
// list cut short, which mount of the tab it is, and a button that chooses All commits.
vi.mock('./CodeTab', async () => {
  const { useState } = await import('react');
  type List = { status: string; items?: { id?: number; sha?: string }[] };
  const listed = (list: List, key: 'id' | 'sha') =>
    list.items ? list.items.map((item) => item[key]).join(',') : list.status;
  let mounts = 0;
  return {
    CodeTab: function CodeTab(props: {
      files: { path: string }[];
      threads: List;
      commits: List;
      commit?: string;
      onCommitChange: (sha: string | undefined) => void;
      truncatedReviewComments?: number;
    }) {
      const [mount] = useState(() => (mounts += 1));
      return (
        <div>
          <ul aria-label="Changed files">
            {props.files.map((file) => (
              <li key={file.path}>{file.path}</li>
            ))}
          </ul>
          <p data-testid="code-threads">{listed(props.threads, 'id')}</p>
          <p data-testid="code-commits">{listed(props.commits, 'sha')}</p>
          <p data-testid="code-commit">{props.commit ?? 'all'}</p>
          <p data-testid="code-truncated">{props.truncatedReviewComments ?? 'whole'}</p>
          <p data-testid="code-mount">{mount}</p>
          <button type="button" onClick={() => props.onCommitChange(undefined)}>
            Choose All commits
          </button>
        </div>
      );
    },
  };
});

// The app's Markdown renderer loads on demand and cannot load here; this one renders bold text.
vi.mock('@mindroom/client-sdk/ui', async (importOriginal) => {
  const ui = await importOriginal<typeof import('@mindroom/client-sdk/ui')>();
  return {
    ...ui,
    useMarkdownHtml: (markdown: string) =>
      markdown.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'),
  };
});

const REQUEST = { owner: 'mindroom-ai', repo: 'mindroom-chat', number: 200 };

const pull = (over: Record<string, unknown> = {}) => ({
  title: 'Add pull request cards',
  state: 'open',
  draft: false,
  merged_at: null,
  body: 'Shows a **bold** claim.',
  user: { login: 'basnijholt', avatar_url: null, html_url: 'x' },
  created_at: '2026-11-01T00:00:00Z',
  updated_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  base: { ref: 'main' },
  head: { ref: 'feature' },
  additions: 10,
  deletions: 2,
  changed_files: 3,
  ...over,
});

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const click = (element: HTMLElement) => act(async () => element.click());

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const filesRequests = () => fetchMock.mock.calls.filter(([url]) => url.includes('/files'));

const show = async (...args: [] | [unknown]) => {
  const request = args.length === 0 ? REQUEST : args[0];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderPluginComponent(
    <QueryClientProvider client={client}>
      <PullRequestPanel roomId="!room:example.org" request={request} />
    </QueryClientProvider>,
    { id: 'pull-requests', plugin }
  );
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url) =>
    url.includes('/files')
      ? respond([{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }])
      : respond(pull())
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const EMPTY = 'Click a pull request link in a message to show it here.';

describe('PullRequestPanel', () => {
  it('shows the empty state without a request', async () => {
    const view = await show(undefined);
    expect(view.getByText(EMPTY)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a path of dots', { owner: '../x', repo: 'y', number: 1 }],
    ['text', 'text'],
  ])('ignores a request of another shape: %s', async (_name, request) => {
    const view = await show(request);
    expect(view.getByText(EMPTY)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the header', async () => {
    const view = await show();
    expect(await view.findByText('Add pull request cards')).toBeTruthy();
    expect(view.getByText('mindroom-ai/mindroom-chat')).toBeTruthy();
    expect(view.getByText('#200')).toBeTruthy();
    expect(view.getByText('main')).toBeTruthy();
    expect(view.getByText('feature')).toBeTruthy();
    expect(view.getByText('+10')).toBeTruthy();
    expect(view.getByText('-2')).toBeTruthy();
    expect(view.getByText('3 files')).toBeTruthy();
    expect(view.getByText(/updated 2 days ago/)).toBeTruthy();
    expect(view.getByText('Open on GitHub').closest('a')?.getAttribute('href')).toBe(
      'https://github.com/mindroom-ai/mindroom-chat/pull/200'
    );
  });

  it('keeps the avatar and login together, with no separator before the login', async () => {
    const view = await show();
    const login = await view.findByText('basnijholt');
    expect(login.closest('.mrpr-meta')?.textContent).toBe('Bbasnijholt·updated 2 days ago');
    expect(login.parentElement?.nextElementSibling?.className).toContain('mrpr-separator');
  });

  it('puts the tab list in no landmark', async () => {
    const view = await show();
    await view.findByText('Add pull request cards');
    expect(view.getByRole('tablist').closest('nav')).toBeNull();
  });

  it('renders the description', async () => {
    const view = await show();
    const bold = await view.findByText('bold');
    expect(bold.tagName).toBe('STRONG');
  });

  it('says so when there is no description', async () => {
    fetchMock.mockImplementation(async () => respond(pull({ body: null })));
    const view = await show();
    expect(await view.findByText('No description.')).toBeTruthy();
  });

  it('moves between the tabs with the arrow keys', async () => {
    const view = await show();
    await view.findByText('Add pull request cards');
    const summary = view.getByRole('tab', { name: 'Summary' });
    expect(summary.getAttribute('aria-selected')).toBe('true');
    await act(async () => {
      summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(view.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true');
    await act(async () => {
      view
        .getByRole('tab', { name: 'Timeline' })
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(view.getByRole('tab', { name: 'Summary' }).getAttribute('aria-selected')).toBe('true');
  });

  it('loads the files only when the Code tab shows', async () => {
    const view = await show();
    await view.findByText('Add pull request cards');
    expect(filesRequests()).toHaveLength(0);
    await click(view.getByRole('tab', { name: 'Code' }));
    expect(await view.findByText('src/a.ts')).toBeTruthy();
    expect(filesRequests()).toHaveLength(1);
  });

  it('shows the error state when the files do not load', async () => {
    fetchMock.mockImplementation(async (url) =>
      url.includes('/files') ? respond({}, 404) : respond(pull())
    );
    const view = await show();
    await view.findByText('Add pull request cards');
    await click(view.getByRole('tab', { name: 'Code' }));
    expect(await view.findByText(/GitHub did not find this pull request/)).toBeTruthy();
  });

  it('shows Forget token only with a token and removes it', async () => {
    fetchMock.mockResolvedValueOnce(respond({}, 404));
    const view = await show();
    await view.findByLabelText('GitHub token');
    expect(view.queryByRole('button', { name: 'Forget token' })).toBeNull();
    const input = view.getByLabelText('GitHub token');
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(input, 'ghp_secret');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(view.getByRole('button', { name: 'Save' }));
    await view.findByText('Add pull request cards');
    await click(view.getByRole('button', { name: 'Forget token' }));
    await vi.waitFor(() => expect(view.queryByRole('button', { name: 'Forget token' })).toBeNull());
  });

  describe('header', () => {
    const SHA = 'abc123';
    const withHead = (over: Record<string, unknown> = {}) =>
      pull({
        head: { ref: 'feature', sha: SHA, repo: { full_name: 'mindroom-ai/mindroom-chat' } },
        base: { ref: 'main', repo: { full_name: 'mindroom-ai/mindroom-chat' } },
        ...over,
      });
    // Each endpoint the header reads answers with its own body; the rest gets the pull request.
    const serve = (
      pr: Record<string, unknown>,
      parts: {
        files?: unknown[];
        behind?: number;
        reviews?: unknown[];
        commits?: unknown[];
        reviewComments?: unknown[] | Response;
        checks?: Response;
        statuses?: Response;
      } = {}
    ) =>
      fetchMock.mockImplementation(async (url) => {
        if (url.includes('/check-runs')) return parts.checks ?? respond({ check_runs: [] });
        if (url.includes('/status?')) return parts.statuses ?? respond({ statuses: [] });
        if (url.includes('/compare/')) return respond({ behind_by: parts.behind ?? 0 });
        if (url.includes('/commits')) return respond(parts.commits ?? []);
        if (url.includes('/pulls/200/comments')) {
          const answer = parts.reviewComments ?? [];
          return answer instanceof Response ? answer : respond(answer);
        }
        if (url.includes('/reviews')) return respond(parts.reviews ?? []);
        if (url.includes('/files')) return respond(parts.files ?? []);
        return respond(pr);
      });
    const comparisons = () => fetchMock.mock.calls.filter(([url]) => url.includes('/compare/'));

    it('links the repository and number', async () => {
      const view = await show();
      expect(await view.findByRole('link', { name: 'mindroom-ai/mindroom-chat' })).toBeTruthy();
      expect(
        view.getByRole('link', { name: 'mindroom-ai/mindroom-chat' }).getAttribute('href')
      ).toBe('https://github.com/mindroom-ai/mindroom-chat');
      expect(view.getByRole('link', { name: '#200' }).getAttribute('href')).toBe(
        'https://github.com/mindroom-ai/mindroom-chat/pull/200'
      );
    });

    it("opens the author's profile", async () => {
      serve(withHead({ user: { login: 'basnijholt', html_url: 'https://github.com/basnijholt' } }));
      const view = await show();
      const link = await view.findByRole('link', { name: "Open basnijholt's profile" });
      expect(link.getAttribute('href')).toBe('https://github.com/basnijholt');
    });

    it('copies the checkout command', async () => {
      const writeText = vi.fn(async () => undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const view = await show();
      await click(await view.findByRole('button', { name: 'Copy checkout command' }));
      expect(writeText).toHaveBeenCalledWith('gh pr checkout 200 -R mindroom-ai/mindroom-chat');
      expect(view.getByRole('button', { name: 'Copied' })).toBeTruthy();
    });

    it('leaves the checkout button as it was where there is no clipboard', async () => {
      vi.stubGlobal('navigator', {});
      const view = await show();
      await click(await view.findByRole('button', { name: 'Copy checkout command' }));
      expect(view.getByRole('button', { name: 'Copy checkout command' })).toBeTruthy();
      expect(view.queryByRole('button', { name: 'Copied' })).toBeNull();
    });

    it('names the owner of a fork head', async () => {
      serve(withHead({ head: { ref: 'feature', sha: SHA, repo: { full_name: 'octo/chat' } } }));
      const view = await show();
      expect(await view.findByText('octo:feature')).toBeTruthy();
    });

    it('shows the head branch plain when it is in the same repository', async () => {
      serve(withHead());
      const view = await show();
      expect(await view.findByText('feature')).toBeTruthy();
      expect(view.queryByText(/:feature/)).toBeNull();
    });

    it('shows behind and conflicts', async () => {
      serve(withHead({ mergeable_state: 'dirty' }), { behind: 3 });
      const view = await show();
      const button = await view.findByRole('button', { name: 'Warnings for main' });
      expect(button.getAttribute('aria-haspopup')).toBe('dialog');
      await click(button);
      expect(await view.findByText('feature is 3 commits behind main')).toBeTruthy();
      expect(view.getByText('This branch has conflicts that must be resolved')).toBeTruthy();
      expect(view.getByRole('dialog', { name: 'Warnings for main' })).toBeTruthy();
      expect(view.queryByRole('menu')).toBeNull();
    });

    it('closes the base warning with a second click', async () => {
      serve(withHead(), { behind: 1 });
      const view = await show();
      const button = await view.findByRole('button', { name: 'Warnings for main' });
      await click(button);
      expect(await view.findByText('feature is 1 commit behind main')).toBeTruthy();
      await click(button);
      expect(view.queryByText('feature is 1 commit behind main')).toBeNull();
    });

    it('shows no warning for a branch that is current, and asks nothing of a merged pull request', async () => {
      serve(withHead({ merged_at: '2026-11-02T00:00:00Z', state: 'closed' }), { behind: 5 });
      const view = await show();
      await view.findByText('Add pull request cards');
      expect(view.queryByRole('button', { name: 'Warnings for main' })).toBeNull();
      expect(comparisons()).toHaveLength(0);
    });

    it.each([
      ['Draft', { draft: true }],
      ['Merged', { state: 'closed', merged_at: '2026-11-02T00:00:00Z' }],
      ['Closed', { state: 'closed' }],
      ['Auto-merge (squash)', { auto_merge: { merge_method: 'squash' } }],
    ])('badge: %s', async (label, over) => {
      serve(withHead(over));
      const view = await show();
      expect(await view.findByText(label)).toBeTruthy();
    });

    it('has no badge for an open pull request', async () => {
      serve(withHead());
      const view = await show();
      await view.findByText('Add pull request cards');
      for (const label of ['Draft', 'Merged', 'Closed']) expect(view.queryByText(label)).toBeNull();
      expect(view.queryByText(/Auto-merge/)).toBeNull();
    });

    it('splits the line breakdown by kind in a tooltip', async () => {
      serve(withHead({ additions: 20, deletions: 13 }), {
        files: [
          { filename: 'src/a.ts', status: 'modified', additions: 5, deletions: 1 },
          { filename: 'src/a.test.ts', status: 'added', additions: 3, deletions: 0 },
          { filename: 'package-lock.json', status: 'modified', additions: 10, deletions: 10 },
          { filename: 'README.md', status: 'modified', additions: 2, deletions: 2 },
        ],
      });
      const view = await show();
      await view.findByText('Add pull request cards');
      expect(filesRequests()).toHaveLength(0);
      const stat = view.getByRole('button', { name: /^Lines changed/ });
      expect(stat.getAttribute('aria-haspopup')).toBe('dialog');
      expect(stat.getAttribute('aria-expanded')).toBe('false');
      await act(async () => stat.focus());
      await view.findByText('Total');
      expect(stat.getAttribute('aria-expanded')).toBe('true');
      expect(view.getByRole('dialog', { name: 'Lines changed: +20 -13' })).toBeTruthy();
      expect(view.queryByRole('menu')).toBeNull();
      expect(document.querySelector('.mrpr-breakdown')?.textContent).toBe(
        'Code+5-1Tests+3-0Generated+10-10Docs+2-2Total+20-13'
      );
      expect(filesRequests()).toHaveLength(1);
    });

    it('shows the counts and the order toggle on Timeline, with approvals of the head only', async () => {
      const review = (id: number, login: string, state: string, commit: string) => ({
        id,
        state,
        user: { login },
        body: '',
        commit_id: commit,
        submitted_at: `2026-11-0${id}T00:00:00Z`,
        html_url: 'x',
      });
      serve(withHead({ comments: 4, review_comments: 3, commits: 5 }), {
        reviews: [
          review(1, 'ann', 'APPROVED', SHA),
          review(2, 'bob', 'APPROVED', 'old'),
          review(3, 'cy', 'CHANGES_REQUESTED', SHA),
        ],
      });
      const view = await show();
      await view.findByText('Add pull request cards');
      await click(view.getByRole('tab', { name: 'Timeline' }));
      expect(view.getByText('7 comments')).toBeTruthy();
      expect(view.getByText('5 commits')).toBeTruthy();
      expect(await view.findByText('1 approval')).toBeTruthy();
      const toggle = view.getByRole('button', { name: 'Newest first' });
      await click(toggle);
      expect(view.getByRole('button', { name: 'Oldest first' })).toBeTruthy();
      await click(view.getByRole('tab', { name: 'Summary' }));
      // The Summary tab's comments have an order of their own, still the newest first.
      expect(view.queryByRole('button', { name: 'Oldest first' })).toBeNull();
    });

    const commitEntry = (sha: string, message: string, date: string) => ({
      sha,
      html_url: 'x',
      author: null,
      commit: { message, author: { name: 'Ann' }, committer: { date } },
    });
    const COMMITS = [
      commitEntry('abcdef1234', 'Add cards', '2026-11-01T00:05:00Z'),
      commitEntry('bcdef12345', 'Fix cards', '2026-11-01T00:06:00Z'),
    ];
    const reviewComment = (id: number, over: Record<string, unknown> = {}) => ({
      id,
      user: { login: 'ann' },
      body: `Thread ${id}`,
      created_at: `2026-11-01T00:0${id}:00Z`,
      html_url: 'x',
      path: 'src/a.ts',
      line: 1,
      side: 'RIGHT',
      position: 1,
      commit_id: SHA,
      ...over,
    });
    const commitsRequests = () =>
      fetchMock.mock.calls.filter(([url]) => url.includes('/pulls/200/commits'));

    it('opens the Code tab from a commit of the Timeline', async () => {
      serve(withHead(), { commits: COMMITS });
      const view = await show();
      await view.findByText('Add pull request cards');
      await click(view.getByRole('tab', { name: 'Timeline' }));
      await click(await view.findByRole('button', { name: 'View commit abcdef1' }));
      expect(view.getByRole('tab', { name: 'Code' }).getAttribute('aria-selected')).toBe('true');
      expect((await view.findByTestId('code-commit')).textContent).toBe('abcdef1234');
      await click(view.getByRole('button', { name: 'Choose All commits' }));
      expect(view.getByTestId('code-commit').textContent).toBe('all');
    });

    it('gives the Code tab the review threads and the commits, which it loads', async () => {
      serve(withHead(), {
        commits: COMMITS,
        reviewComments: [
          reviewComment(1),
          reviewComment(2, { in_reply_to_id: 1 }),
          reviewComment(3),
        ],
      });
      const view = await show();
      await view.findByText('Add pull request cards');
      expect(commitsRequests()).toHaveLength(0);
      await click(view.getByRole('tab', { name: 'Code' }));
      expect(await view.findByText('abcdef1234,bcdef12345')).toBeTruthy();
      expect((await view.findByTestId('code-threads')).textContent).toBe('1,3');
      expect(view.getByTestId('code-commit').textContent).toBe('all');
      expect(commitsRequests()).toHaveLength(1);
    });

    it('tells the Code tab when the review comments do not load', async () => {
      serve(withHead(), {
        files: [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }],
        reviewComments: respond({}, 404),
      });
      const view = await show();
      await view.findByText('Add pull request cards');
      await click(view.getByRole('tab', { name: 'Code' }));
      expect(await view.findByText('error')).toBeTruthy();
      expect(view.getByText('src/a.ts')).toBeTruthy();
    });

    it('forgets the chosen commit when the panel shows another pull request', async () => {
      serve(withHead(), { commits: COMMITS });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const panel = (number: number) => (
        <QueryClientProvider client={client}>
          <PullRequestPanel roomId="!room:example.org" request={{ ...REQUEST, number }} />
        </QueryClientProvider>
      );
      const view = await renderPluginComponent(panel(200), { id: 'pull-requests', plugin });
      await view.findByText('Add pull request cards');
      await click(view.getByRole('tab', { name: 'Timeline' }));
      await click(await view.findByRole('button', { name: 'View commit abcdef1' }));
      expect((await view.findByTestId('code-commit')).textContent).toBe('abcdef1234');
      view.rerender(panel(201));
      expect((await view.findByTestId('code-commit')).textContent).toBe('all');
    });

    it('starts the Code tab afresh for another pull request', async () => {
      serve(withHead(), { commits: COMMITS });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const panel = (number: number) => (
        <QueryClientProvider client={client}>
          <PullRequestPanel roomId="!room:example.org" request={{ ...REQUEST, number }} />
        </QueryClientProvider>
      );
      // Both pull requests load once, so that showing either again finds its files at once.
      const view = await renderPluginComponent(panel(201), { id: 'pull-requests', plugin });
      await view.findByText('Add pull request cards');
      await click(view.getByRole('tab', { name: 'Code' }));
      await view.findByTestId('code-mount');
      view.rerender(panel(200));
      const mount = Number((await view.findByTestId('code-mount')).textContent);
      view.rerender(panel(201));
      // The tab's own state, such as the open bar or the folded files, is the other pull request's.
      expect(
        await view.findByText(String(mount + 1), { selector: '[data-testid="code-mount"]' })
      ).toBeTruthy();
    });

    it('tells the Code tab when GitHub cut the review comments short', async () => {
      let next = 0;
      serve(withHead());
      const served = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (url, init) =>
        url.includes('/pulls/200/comments')
          ? respond(
              Array.from({ length: 100 }, () =>
                reviewComment((next += 1), { created_at: '2026-11-01T00:00:00Z' })
              )
            )
          : served(url, init)
      );
      const view = await show();
      await view.findByText('Add pull request cards');
      await click(view.getByRole('tab', { name: 'Code' }));
      expect(
        await view.findByText('1000', { selector: '[data-testid="code-truncated"]' })
      ).toBeTruthy();
    });

    it('reads the reviews for the Summary tab, and the files only for the Code tab', async () => {
      serve(withHead());
      const view = await show();
      await view.findByText('Add pull request cards');
      await vi.waitFor(() =>
        expect(fetchMock.mock.calls.some(([url]) => url.includes('/pulls/200/reviews'))).toBe(true)
      );
      expect(filesRequests()).toHaveLength(0);
    });

    it('leaves the header whole when the checks do not load', async () => {
      const limited = () =>
        new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
      serve(withHead(), { checks: limited(), statuses: limited() });
      const view = await show();
      expect(await view.findByText('Checks unavailable')).toBeTruthy();
      expect(view.getByText('Add pull request cards')).toBeTruthy();
      expect(view.getByRole('button', { name: 'Retry' })).toBeTruthy();
    });
  });
});
