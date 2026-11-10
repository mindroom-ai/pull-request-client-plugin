// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from './index';
import PullRequestPanel from './PullRequestPanel';

// The Code tab's diff libraries need a browser; the tab stands in as its file paths.
vi.mock('./CodeTab', () => ({
  CodeTab: ({ files }: { files: { path: string }[] }) => (
    <ul aria-label="Changed files">
      {files.map((file) => (
        <li key={file.path}>{file.path}</li>
      ))}
    </ul>
  ),
}));

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
      parts: { files?: unknown[]; behind?: number; reviews?: unknown[]; checks?: Response } = {}
    ) =>
      fetchMock.mockImplementation(async (url) => {
        if (url.includes('/check-runs')) return parts.checks ?? respond({ check_runs: [] });
        if (url.endsWith('/status')) return respond({ statuses: [] });
        if (url.includes('/compare/')) return respond({ behind_by: parts.behind ?? 0 });
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
      await click(await view.findByRole('button', { name: 'Warnings for main' }));
      expect(await view.findByText('feature is 3 commits behind main')).toBeTruthy();
      expect(view.getByText('This branch has conflicts that must be resolved')).toBeTruthy();
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
      await act(async () => view.getByRole('button', { name: /^Lines changed/ }).focus());
      await view.findByText('Total');
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
      expect(view.queryByRole('button', { name: /first$/ })).toBeNull();
    });

    it('does not read reviews before Timeline shows', async () => {
      serve(withHead());
      const view = await show();
      await view.findByText('Add pull request cards');
      expect(fetchMock.mock.calls.some(([url]) => url.includes('/reviews'))).toBe(false);
    });

    it('leaves the header whole when the checks do not load', async () => {
      serve(withHead(), {
        checks: new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      });
      const view = await show();
      expect(await view.findByText('Checks unavailable')).toBeTruthy();
      expect(view.getByText('Add pull request cards')).toBeTruthy();
      expect(view.getByRole('button', { name: 'Retry' })).toBeTruthy();
    });
  });
});
