// @vitest-environment jsdom
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react-dom/test-utils';
import { MindroomServerError } from '@mindroom/client-sdk/server';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestRef } from './github';
import plugin from './index';
import PullRequestPanel from './PullRequestPanel';
import { resetPullRequestActions } from './actions/usePullRequestActions';
import { useShownPullRequest } from './shownPullRequest';
import { githubServer } from './testing/mindroomServer';

// The Code tab's diff libraries need a browser; the tab stands in as its file paths, what it was
// given of the threads, the commits and the chosen commit, how many review comments loaded of a
// list cut short, which mount of the tab it is, and a button that chooses All commits.
// The room has no MindRoom server unless a test gives one: the stand-in client knows no room.
const roomServer = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@mindroom/client-sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mindroom/client-sdk/server')>()),
  useMindroomServerStatus: () => ({ server: roomServer.current, pending: false }),
}));

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
      truncatedCommits?: number;
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
          <p data-testid="code-truncated-commits">{props.truncatedCommits ?? 'whole'}</p>
          <p data-testid="code-mount">{mount}</p>
          <button type="button" onClick={() => props.onCommitChange(undefined)}>
            Choose All commits
          </button>
        </div>
      );
    },
  };
});

// The room's controls of the panel, which the room's page gives; its Close is a spy.
const panelControl = vi.hoisted(() => ({ close: undefined as (() => void) | undefined }));
vi.mock('@mindroom/client-sdk/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@mindroom/client-sdk/core')>();
  return {
    ...core,
    useRoomSidePanel: (pluginId: string, panelId: string) =>
      panelControl.close
        ? {
            isOpen: true,
            open: () => undefined,
            openBesideThread: () => undefined,
            close: panelControl.close,
          }
        : core.useRoomSidePanel(pluginId, panelId),
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

vi.mock('focus-trap-react', async () => ({
  default: (await import('./testing/focusTrapStandIn')).FocusTrapStandIn,
}));

const click = (element: HTMLElement) => act(async () => element.click());

// Polls as testing-library's findBy queries do: outside React's act environment, so that what the
// answered requests change renders as it comes.
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
const filesRequests = () => fetchMock.mock.calls.filter(([url]) => url.includes('/files'));

let client: QueryClient;
const show = async (...args: [] | [unknown]) => {
  const request = args.length === 0 ? REQUEST : args[0];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  resetPullRequestActions();
  vi.unstubAllGlobals();
  roomServer.current = undefined;
});

// The observers the panel made, so a test can report the header in or out of view and the top
// row's new height.
let observers: {
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  targets: Element[];
}[] = [];
let resized: ResizeObserverCallback[] = [];
const stubObservers = () => {
  observers = [];
  resized = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      targets: Element[] = [];
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        observers.push({ callback, options, targets: this.targets });
      }
      observe(target: Element) {
        this.targets.push(target);
      }
      disconnect() {
        this.targets.splice(0);
      }
    }
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resized.push(callback);
      }
      observe() {}
      disconnect() {}
    }
  );
};
const report = (inView: boolean) =>
  act(async () => {
    for (const { callback, targets } of observers) {
      if (targets.length === 0) continue;
      callback(
        targets.map((target) => ({ target, isIntersecting: inView } as IntersectionObserverEntry)),
        {} as IntersectionObserver
      );
    }
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

  it('records the pull request it shows for its room until it unmounts', async () => {
    let shown: PullRequestRef | undefined;
    function ShownProbe() {
      shown = useShownPullRequest('!room:example.org');
      return null;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = (withPanel: boolean) => (
      <QueryClientProvider client={client}>
        {withPanel ? <PullRequestPanel roomId="!room:example.org" request={REQUEST} /> : null}
        <ShownProbe />
      </QueryClientProvider>
    );
    const view = await renderPluginComponent(page(true), { id: 'pull-requests', plugin });
    expect(shown).toEqual(REQUEST);
    view.rerender(page(false));
    expect(shown).toBeUndefined();
  });

  it('leaves the record of the panel that took its place when it unmounts', async () => {
    let shown: PullRequestRef | undefined;
    function ShownProbe() {
      shown = useShownPullRequest('!room:example.org');
      return null;
    }
    const next = { ...REQUEST, number: 201 };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A new panel mounts while the one it replaces still moves out.
    const page = (withOld: boolean) => (
      <QueryClientProvider client={client}>
        {withOld ? (
          <PullRequestPanel key="old" roomId="!room:example.org" request={REQUEST} />
        ) : null}
        <PullRequestPanel key="new" roomId="!room:example.org" request={next} />
        <ShownProbe />
      </QueryClientProvider>
    );
    const view = await renderPluginComponent(page(true), { id: 'pull-requests', plugin });
    expect(shown).toEqual(next);
    view.rerender(page(false));
    expect(shown).toEqual(next);
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
    // The number opens it on GitHub; Open on GitHub itself is in More actions.
    expect(view.getByText('#200').closest('a')?.getAttribute('href')).toBe(
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
    // In More actions, as the token's other entries.
    await click(view.getByRole('button', { name: 'More actions' }));
    await click(view.getByRole('menuitem', { name: 'Forget token' }));
    // The pull request reads again without it.
    await click(await view.findByRole('button', { name: 'More actions' }));
    await vi.waitFor(() =>
      expect(view.queryByRole('menuitem', { name: 'Forget token' })).toBeNull()
    );
    expect(view.getByRole('menuitem', { name: 'Open on GitHub' })).toBeTruthy();
  });

  it('asks GitHub for 7 requests for the header and Summary, then one per tab', async () => {
    const SHA = 'abc123';
    const repo = { full_name: 'mindroom-ai/mindroom-chat' };
    const pathOf = (url: string) =>
      new URL(url).pathname.replace('/repos/mindroom-ai/mindroom-chat', '');
    // Every endpoint the panel reads for one open pull request, each list on one page.
    fetchMock.mockImplementation(async (url) => {
      switch (pathOf(url)) {
        case '/pulls/200':
          return respond(
            pull({
              head: { ref: 'feature', sha: SHA, repo },
              base: { ref: 'main', repo },
              commits: 1,
            })
          );
        case `/commits/${SHA}/check-runs`:
          return respond({ total_count: 0, check_runs: [] });
        case `/commits/${SHA}/status`:
          return respond({ total_count: 0, statuses: [] });
        case `/compare/main...${SHA}`:
          return respond({ behind_by: 0 });
        case '/pulls/200/reviews':
        case '/issues/200/comments':
        case '/pulls/200/comments':
          return respond([]);
        case '/pulls/200/commits':
          return respond([
            {
              sha: 'abcdef1234',
              html_url: 'x',
              author: null,
              commit: {
                message: 'Add cards',
                author: { name: 'Ann' },
                committer: { date: '2026-11-01T00:05:00Z' },
              },
            },
          ]);
        case '/pulls/200/files':
          return respond([
            { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 },
          ]);
        default:
          throw new Error(`unexpected request ${url}`);
      }
    });
    const paths = () => fetchMock.mock.calls.map(([url]) => pathOf(url)).sort();
    const summary = [
      '/pulls/200',
      `/commits/${SHA}/check-runs`,
      `/commits/${SHA}/status`,
      `/compare/main...${SHA}`,
      '/pulls/200/reviews',
      '/issues/200/comments',
      '/pulls/200/comments',
    ];

    const view = await show();
    expect(await view.findByText('No comments yet.')).toBeTruthy();
    expect(await view.findByText('No checks')).toBeTruthy();
    // No reviewers, so no row that says so.
    expect(view.queryByText('Reviewers')).toBeNull();
    expect(paths()).toEqual([...summary].sort());

    await click(view.getByRole('tab', { name: 'Timeline' }));
    expect(await view.findByText('Add cards')).toBeTruthy();
    expect(paths()).toEqual([...summary, '/pulls/200/commits'].sort());

    // The Code tab's review comments and commits are the ones the other tabs loaded.
    await click(view.getByRole('tab', { name: 'Code' }));
    expect(await view.findByText('src/a.ts')).toBeTruthy();
    expect(view.getByTestId('code-commits').textContent).toBe('abcdef1234');
    expect(paths()).toEqual([...summary, '/pulls/200/commits', '/pulls/200/files'].sort());
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
        if (url.includes('/issues/200/comments')) return respond([]);
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

    it('leaves Copy checkout command as it was where there is no clipboard', async () => {
      vi.stubGlobal('navigator', {});
      const view = await show();
      await click(await view.findByRole('button', { name: 'More actions' }));
      await click(view.getByRole('menuitem', { name: 'Copy checkout command' }));
      expect(view.getByRole('menuitem', { name: 'Copy checkout command' })).toBeTruthy();
      expect(view.queryByRole('menuitem', { name: 'Copied' })).toBeNull();
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

    it('tells the Code tab when GitHub listed fewer commits than the pull request has', async () => {
      serve(withHead({ commits: 300 }), { commits: COMMITS });
      const view = await show();
      await view.findByText('Add pull request cards');
      await click(view.getByRole('tab', { name: 'Code' }));
      expect(
        await view.findByText('2', { selector: '[data-testid="code-truncated-commits"]' })
      ).toBeTruthy();
    });

    it('tells the Code tab nothing is cut when every commit came', async () => {
      serve(withHead({ commits: 2 }), { commits: COMMITS });
      const view = await show();
      await view.findByText('Add pull request cards');
      await click(view.getByRole('tab', { name: 'Code' }));
      await view.findByText('abcdef1234,bcdef12345');
      expect(view.getByTestId('code-truncated-commits').textContent).toBe('whole');
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

    it('offers one token form under the rate limit, and each failed part its own Retry', async () => {
      const limited = () =>
        new Response('{}', {
          status: 403,
          // A limit that reset long ago, so that each request still goes to GitHub.
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' },
        });
      let limit = true;
      serve(withHead());
      const served = fetchMock.getMockImplementation()!;
      // The pull request came before the limit; everything after it is refused while it lasts.
      fetchMock.mockImplementation(async (url, init) =>
        limit && !url.endsWith('/pulls/200') ? limited() : served(url, init)
      );
      const retries = () => view.queryAllByRole('button', { name: 'Try again' });
      const view = await show();
      await view.findByText('Add pull request cards');
      // The reviewers, the conversation comments and the review comments each failed.
      await waitUntil(() => expect(retries()).toHaveLength(3));
      expect(view.getAllByText("GitHub's rate limit was reached.")).toHaveLength(3);
      expect(view.getByText('Checks unavailable')).toBeTruthy();
      await waitUntil(() => expect(view.getAllByLabelText('GitHub token')).toHaveLength(1));
      expect(view.getByText('A token raises the limit.')).toBeTruthy();

      const adds = view.getAllByRole('button', { name: 'Add a GitHub token' });
      expect(adds).toHaveLength(3);
      await click(adds[1]!);
      expect(document.activeElement).toBe(view.getByLabelText('GitHub token'));

      limit = false;
      const reviewRequests = () =>
        fetchMock.mock.calls.filter(([url]) => url.includes('/pulls/200/reviews')).length;
      const before = reviewRequests();
      await click(retries()[0]!);
      await waitUntil(() => expect(retries()).toHaveLength(2));
      expect(reviewRequests()).toBe(before + 1);
      // The form stays while any part still needs it.
      expect(view.getAllByLabelText('GitHub token')).toHaveLength(1);
      for (const retry of retries()) await click(retry);
      expect(await view.findByText('No comments yet.')).toBeTruthy();
      expect(view.getByLabelText('GitHub token')).toBeTruthy();
      await click(view.getByRole('button', { name: 'Retry' }));
      // Once shown, the form stays, without its hint, until the person closes it.
      await waitUntil(() => expect(view.queryByText('A token raises the limit.')).toBeNull());
      expect(retries()).toHaveLength(0);
      await click(view.getByRole('button', { name: 'Cancel' }));
      expect(view.queryByLabelText('GitHub token')).toBeNull();
    });

    it('leaves the header whole when the checks do not load', async () => {
      const limited = () =>
        new Response('{}', {
          status: 403,
          // A limit that reset long ago, so that each request still goes to GitHub.
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' },
        });
      serve(withHead(), { checks: limited(), statuses: limited() });
      const view = await show();
      expect(await view.findByText('Checks unavailable')).toBeTruthy();
      expect(view.getByText('Add pull request cards')).toBeTruthy();
      expect(view.getByRole('button', { name: 'Retry' })).toBeTruthy();
    });
  });

  describe('header actions', () => {
    const GRAPHQL = 'https://api.github.com/graphql';

    it('offers no action without a token, only the menu, and asks GitHub no GraphQL', async () => {
      const view = await show();
      await view.findByText('Add pull request cards');
      await click(view.getByRole('button', { name: 'More actions' }));
      expect(view.getAllByRole('menuitem').map((item) => item.getAttribute('aria-live'))).toEqual([
        null,
        'polite',
      ]);
      expect(view.getByRole('menuitem', { name: 'Open on GitHub' })).toBeTruthy();
      expect(view.queryByRole('button', { name: 'Merge' })).toBeNull();
      expect(fetchMock.mock.calls.filter(([url]) => url === GRAPHQL)).toEqual([]);
    });

    it('a merged pull request shows the Merged badge and no Merge button', async () => {
      localStorage.setItem(
        'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/githubToken',
        'tok'
      );
      const repository = {
        viewerPermission: 'WRITE',
        mergeCommitAllowed: true,
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
        autoMergeAllowed: true,
        defaultBranchRef: { name: 'main' },
      };
      fetchMock.mockImplementation(async (url) =>
        url === GRAPHQL
          ? respond({ data: { repository } })
          : url.includes('/files')
          ? respond([])
          : respond(pull({ state: 'closed', merged_at: '2026-11-02T00:00:00Z' }))
      );
      const view = await show();
      expect(await view.findByRole('button', { name: 'More actions' })).toBeTruthy();
      expect(view.getAllByText('Merged')).toHaveLength(1);
      expect(view.queryByRole('button', { name: 'Merge' })).toBeNull();
    });

    // As T3 Code: only a branch GitHub found mergeable, not one it is still computing (null).
    it.each([
      ['WRITE', true, true],
      ['READ', true, false],
      ['WRITE', null, false],
      ['WRITE', false, false],
    ] as const)(
      'the base warning offers the update with %s permission and mergeable %s: %s',
      async (viewerPermission, mergeable, offered) => {
        localStorage.setItem(
          'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/githubToken',
          'tok'
        );
        const repository = {
          viewerPermission,
          mergeCommitAllowed: true,
          squashMergeAllowed: false,
          rebaseMergeAllowed: false,
          autoMergeAllowed: false,
          defaultBranchRef: { name: 'main' },
        };
        const head = {
          ref: 'feature',
          sha: 'abc123',
          repo: { full_name: 'mindroom-ai/mindroom-chat' },
        };
        const base = { ref: 'main', repo: { full_name: 'mindroom-ai/mindroom-chat' } };
        // GitHub updates the branch, after which the pull request has a new head, level with main.
        let updated = false;
        fetchMock.mockImplementation(async (url, init) => {
          if (url === GRAPHQL && String(init?.body).includes('updatePullRequestBranch')) {
            updated = true;
            return respond({
              data: { updatePullRequestBranch: { pullRequest: { headRefOid: 'def456' } } },
            });
          }
          if (url === GRAPHQL) return respond({ data: { repository } });
          if (url.includes('/compare/')) return respond({ behind_by: updated ? 0 : 2 });
          if (url.includes('/check-runs')) return respond({ check_runs: [] });
          if (url.includes('/status?')) return respond({ statuses: [] });
          if (url.includes('/files') || url.includes('/commits') || url.includes('/comments'))
            return respond([]);
          if (url.includes('/reviews')) return respond([]);
          return respond(
            pull({
              node_id: 'PR_kw200',
              head: updated ? { ...head, sha: 'def456' } : head,
              base,
              mergeable,
            })
          );
        });
        const view = await show();
        await waitUntil(() =>
          expect(fetchMock.mock.calls.some(([url]) => url === GRAPHQL)).toBe(true)
        );
        await click(await view.findByRole('button', { name: 'Warnings for main' }));
        expect(await view.findByText('feature is 2 commits behind main')).toBeTruthy();
        if (!offered) {
          // The repository answered, and still no update shows.
          await act(async () => {});
          expect(view.queryByRole('button', { name: 'Update branch' })).toBeNull();
          return;
        }
        await click(await view.findByRole('button', { name: 'Update branch' }));
        expect(await view.findByText('Branch updated')).toBeTruthy();
        const updates = fetchMock.mock.calls.filter(([, init]) =>
          String(init?.body).includes('updatePullRequestBranch')
        );
        expect(updates).toHaveLength(1);
        expect(JSON.parse(String(updates[0][1]?.body)).variables).toEqual({
          pullRequestId: 'PR_kw200',
          expectedHeadOid: 'abc123',
          updateMethod: 'MERGE',
        });
        // The panel has the new head, so the warning is gone.
        await waitUntil(() =>
          expect(view.queryByRole('button', { name: 'Warnings for main' })).toBeNull()
        );
        expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toEqual([]);
      }
    );
  });
});

describe('with the GitHub account connected in MindRoom', () => {
  const GRAPHQL = 'https://api.github.com/graphql';
  const TOKEN_KEY = 'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/githubToken';
  const repository = {
    viewerPermission: 'WRITE',
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true,
    autoMergeAllowed: false,
    defaultBranchRef: { name: 'main' },
  };
  const head = { ref: 'feature', sha: 'abc123', repo: { full_name: 'mindroom-ai/mindroom-chat' } };
  // GitHub, as MindRoom reaches it; the browser's own requests go to `fetchMock`.
  const github = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  type View = Awaited<ReturnType<typeof show>>;
  // Who the requests go as, and what changes that, sit in the header's More actions menu, which
  // the app's test setup draws as plain components: an entry is found by its text.
  const toggleMore = async (view: View) =>
    click(await view.findByRole('button', { name: 'More actions' }));
  /** Opens the menu, finds `status` in it, and closes it again. */
  const signedInAs = async (view: View, status: string) => {
    await toggleMore(view);
    expect(await view.findByText(status)).toBeTruthy();
    await toggleMore(view);
    expect(view.queryByText(status)).toBeNull();
  };
  /** Chooses the menu's entry `name`, focused first, as a keyboard reaches it. */
  const choose = async (view: View, name: string) => {
    await toggleMore(view);
    const entry = (await view.findByText(name)).closest('button');
    if (!entry) throw new Error(`No menu entry ${name}`);
    entry.focus();
    await click(entry);
  };

  beforeEach(() => {
    github.mockReset();
    github.mockImplementation(async (url, init) => {
      if (url === GRAPHQL && String(init?.body).includes('viewerPermission'))
        return respond({ data: { repository } });
      if (url.includes('/merge')) return respond({ merged: true });
      if (url.includes('/compare/')) return respond({ behind_by: 0 });
      if (url.includes('/check-runs')) return respond({ check_runs: [] });
      if (url.includes('/status?')) return respond({ statuses: [] });
      if (url.includes('/files') || url.includes('/commits') || url.includes('/comments'))
        return respond([]);
      if (url.includes('/reviews')) return respond([]);
      return respond(pull({ node_id: 'PR_kw200', head, mergeable: true }));
    });
  });

  it('reads and merges through MindRoom, and says whose account it is', async () => {
    const mindroom = githubServer(github);
    roomServer.current = mindroom.server;
    const view = await show();
    await signedInAs(view, 'Signed in as octo through MindRoom');
    // Nothing of it in the panel itself: once it works, it does not ask for attention.
    expect(view.queryByText(/through MindRoom/)).toBeNull();
    await click(await view.findByRole('button', { name: 'Merge' }));
    await click(await view.findByRole('button', { name: 'Confirm merge?' }));
    await waitUntil(() =>
      expect(mindroom.githubRequests()).toContainEqual({
        method: 'PUT',
        path: '/repos/mindroom-ai/mindroom-chat/pulls/200/merge',
        body: { merge_method: 'merge', sha: 'abc123' },
        accept: 'application/vnd.github+json',
      })
    );
    // Nothing went to GitHub from the browser, and the status was asked once.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mindroom.statusRequests()).toBe(1);
    await toggleMore(view);
    expect(view.queryByRole('menuitem', { name: 'Forget token' })).toBeNull();
  });

  it('keeps who it goes as in More actions also for a viewer who cannot write', async () => {
    const reader = { ...repository, viewerPermission: 'READ' };
    const mindroom = githubServer(async (url, init) =>
      url === GRAPHQL && String(init?.body).includes('viewerPermission')
        ? respond({ data: { repository: reader } })
        : github(url, init)
    );
    roomServer.current = mindroom.server;
    const view = await show();
    await toggleMore(view);
    expect(await view.findByText('Signed in as octo through MindRoom')).toBeTruthy();
    expect(view.getByText('Use a token in this browser')).toBeTruthy();
    expect(view.getByText('Refresh')).toBeTruthy();
    expect(view.queryByText('Close pull request')).toBeNull();
    expect(view.queryByRole('button', { name: 'Merge' })).toBeNull();
  });

  it('says so when MindRoom cannot remove the token chosen from the menu, and keeps it', async () => {
    const mindroom = githubServer(withUser);
    await saveInMindroom(mindroom);
    const real = mindroom.server.request.getMockImplementation()!;
    mindroom.server.request.mockImplementation(async (path, init) => {
      if (path === '/api/github/token' && init?.method === 'DELETE') {
        throw new MindroomServerError('Forbidden', 403, {});
      }
      return real(path, init);
    });
    roomServer.current = mindroom.server;
    const view = await show();
    await choose(view, 'Remove token from MindRoom');
    expect((await view.findByRole('alert')).textContent).toBe(
      'MindRoom could not remove the token.'
    );
    expect(mindroom.storedToken()).toBe('ghp_good');
    expect(view.queryByText('Token removed from MindRoom.')).toBeNull();
    // The entry went with the menu: the focus goes back to the button that opened it.
    const more = view.getByRole('button', { name: 'More actions' });
    await waitUntil(() => expect(document.activeElement).toBe(more));
  });

  it('does not collapse while a failed removal from the menu says so', async () => {
    stubObservers();
    const mindroom = githubServer(withUser);
    await saveInMindroom(mindroom);
    const real = mindroom.server.request.getMockImplementation()!;
    mindroom.server.request.mockImplementation(async (path, init) => {
      if (path === '/api/github/token' && init?.method === 'DELETE') {
        throw new MindroomServerError('Forbidden', 403, {});
      }
      return real(path, init);
    });
    roomServer.current = mindroom.server;
    const view = await show();
    await view.findByRole('button', { name: 'More actions' });
    await report(false);
    expect(view.getByRole('button', { name: /^Show details of pull request/ })).toBeTruthy();
    await choose(view, 'Remove token from MindRoom');
    await view.findByText('MindRoom could not remove the token.');
    // The header comes back with the line, and stays while it shows.
    expect(view.queryByRole('button', { name: /^Show details of pull request/ })).toBeNull();
    await report(false);
    expect(view.queryByRole('button', { name: /^Show details of pull request/ })).toBeNull();
    expect(view.container.querySelector('.mrpr-panel-scrolls')).toBeNull();
  });

  it('says a removal from the menu failed on a line of its own, until a token is saved again', async () => {
    const mindroom = githubServer(withUser);
    await saveInMindroom(mindroom);
    const real = mindroom.server.request.getMockImplementation()!;
    mindroom.server.request.mockImplementation(async (path, init) => {
      if (path === '/api/github/token' && init?.method === 'DELETE') {
        throw new MindroomServerError('Forbidden', 403, {});
      }
      return real(path, init);
    });
    roomServer.current = mindroom.server;
    const view = await show();
    await choose(view, 'Remove token from MindRoom');
    const failed = await view.findByText('MindRoom could not remove the token.');
    // Under the row of the header's controls, as what an action came to.
    expect(failed.closest('[role="alert"]')?.classList.contains('mrpr-action-result')).toBe(true);
    await choose(view, 'Use a token in this browser');
    await type(view.getByLabelText('GitHub token'), 'ghp_good');
    await click(view.getByLabelText('Save in MindRoom at mindroom.example.org'));
    await click(view.getByRole('button', { name: 'Save' }));
    await waitUntil(() => expect(view.queryByLabelText('GitHub token')).toBeNull());
    expect(view.queryByText('MindRoom could not remove the token.')).toBeNull();
  });

  it('leaves the focus where the person moved it while a removal from the menu fails', async () => {
    const mindroom = githubServer(withUser);
    await saveInMindroom(mindroom);
    let fail!: () => void;
    const held = new Promise<void>((resolve) => (fail = resolve));
    const real = mindroom.server.request.getMockImplementation()!;
    mindroom.server.request.mockImplementation(async (path, init) => {
      if (path === '/api/github/token' && init?.method === 'DELETE') {
        await held;
        throw new MindroomServerError('Forbidden', 403, {});
      }
      return real(path, init);
    });
    roomServer.current = mindroom.server;
    const view = await show();
    await choose(view, 'Remove token from MindRoom');
    const elsewhere = document.body.appendChild(document.createElement('button'));
    try {
      elsewhere.focus();
      await act(async () => fail());
      expect(await view.findByRole('alert')).toBeTruthy();
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  describe('while GitHub still checks whether it merges', () => {
    const CHECKING = 'Checking whether it can merge...';
    const pullReads = () => github.mock.calls.filter(([url]) => url.endsWith('/pulls/200')).length;
    // Only `setTimeout` is fake, which the reads again wait with; the queries tell what they read
    // in a microtask instead. This polls until `check` passes, running what is due now, but never
    // moves the clock (`vi.waitFor` would).
    const settle = async (check: () => void) => {
      const end = performance.now() + 2_000;
      for (;;) {
        await act(() => vi.advanceTimersByTimeAsync(0));
        try {
          check();
          return;
        } catch (error) {
          if (performance.now() > end) throw error;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const later = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
    // The pull request as last updated on GitHub, which a test moves on.
    let updated: string;
    /** GitHub answers `mergeable` with each of `answers` in turn, then with the last. */
    const answering = (answers: (boolean | null)[]) => {
      const base = github.getMockImplementation()!;
      updated = '2026-11-10T00:00:00Z';
      github.mockImplementation(async (url, init) => {
        if (!url.endsWith('/pulls/200')) return base(url, init);
        const mergeable = answers.length > 1 ? answers.shift() : answers[0];
        const state = mergeable === null ? 'unknown' : 'clean';
        const over = { node_id: 'PR_kw200', head, mergeable, mergeable_state: state };
        return respond(pull({ ...over, updated_at: updated }));
      });
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      notifyManager.setScheduler(queueMicrotask);
    });
    afterEach(() => {
      notifyManager.setScheduler((callback) => setTimeout(callback, 0));
      vi.useRealTimers();
    });

    it('reads it again after 1 s, then 2 s, and shows Merge once GitHub found it mergeable', async () => {
      answering([null, null, true]);
      roomServer.current = githubServer(github).server;
      const view = await show();
      await settle(() => expect(view.getByRole('button', { name: CHECKING })).toBeTruthy());
      // The control Merge becomes, off meanwhile: focused, it keeps the focus.
      const control = view.getByRole('button', { name: CHECKING });
      expect(control.getAttribute('aria-disabled')).toBe('true');
      expect(control.getAttribute('aria-live')).toBe('polite');
      control.focus();
      expect(view.queryByRole('button', { name: 'Merge' })).toBeNull();
      expect(pullReads()).toBe(1);
      await later(999);
      expect(pullReads()).toBe(1);
      await later(1);
      await settle(() => expect(pullReads()).toBe(2));
      expect(view.getByText(CHECKING)).toBeTruthy();
      await later(1999);
      expect(pullReads()).toBe(2);
      await later(1);
      await settle(() => expect(view.getByRole('button', { name: 'Merge' })).toBeTruthy());
      expect(pullReads()).toBe(3);
      expect(view.queryByText(CHECKING)).toBeNull();
      expect(document.activeElement).toBe(view.getByRole('button', { name: 'Merge' }));
    });

    it('stops after three reads again, and offers Merge as GitHub answers then', async () => {
      answering([null]);
      roomServer.current = githubServer(github).server;
      const view = await show();
      await settle(() => expect(view.getByText(CHECKING)).toBeTruthy());
      for (const [ms, reads] of [
        [1000, 2],
        [2000, 3],
        [4000, 4],
      ] as const) {
        await later(ms);
        await settle(() => expect(pullReads()).toBe(reads));
      }
      await settle(() => expect(view.getByRole('button', { name: 'Merge' })).toBeTruthy());
      expect(view.queryByText(CHECKING)).toBeNull();
      await later(60_000);
      expect(pullReads()).toBe(4);
      // Read again once it changed on GitHub, and still computing, it is read again as before.
      updated = '2026-11-11T00:00:00Z';
      await click(view.getByRole('button', { name: 'More actions' }));
      await click(view.getByRole('menuitem', { name: 'Refresh' }));
      await settle(() => expect(view.getByText(CHECKING)).toBeTruthy());
      expect(pullReads()).toBe(5);
      await later(1000);
      await settle(() => expect(pullReads()).toBe(6));
    });

    it("does not replace an action's read after it, which keeps the action running", async () => {
      const base = github.getMockImplementation()!;
      let reads = 0;
      let release!: (value: Response) => void;
      const held = new Promise<Response>((resolve) => (release = resolve));
      github.mockImplementation(async (url, init) => {
        if (!url.endsWith('/pulls/200')) return base(url, init);
        if (init?.method === 'PATCH') return respond(pull({ state: 'closed' }));
        reads += 1;
        if (reads > 1) return held;
        const unknown = { node_id: 'PR_kw200', head, mergeable: null, mergeable_state: 'unknown' };
        return respond(pull(unknown));
      });
      roomServer.current = githubServer(github).server;
      const view = await show();
      await settle(() => expect(view.getByText(CHECKING)).toBeTruthy());
      const more = view.getByRole('button', { name: 'More actions' });
      await click(more);
      await click(view.getByRole('menuitem', { name: 'Close pull request' }));
      await click(view.getByRole('menuitem', { name: 'Confirm close?' }));
      await settle(() => expect(reads).toBe(2));
      await later(10_000);
      expect(reads).toBe(2);
      expect(more.getAttribute('aria-disabled')).toBe('true');
      await act(async () => release(respond(pull({ state: 'closed' }))));
      await settle(() => expect(more.getAttribute('aria-disabled')).toBeNull());
    });

    it('reads nothing again once the panel is gone', async () => {
      answering([null]);
      roomServer.current = githubServer(github).server;
      const view = await show();
      await settle(() => expect(view.getByText(CHECKING)).toBeTruthy());
      view.unmount();
      await later(10_000);
      expect(pullReads()).toBe(1);
    });
  });

  it("names MindRoom's GitHub App when GitHub refuses a write", async () => {
    const mindroom = githubServer(async (url, init) =>
      init?.method === 'PUT'
        ? respond({ message: 'Resource not accessible by integration' }, 403)
        : github(url, init)
    );
    roomServer.current = mindroom.server;
    const view = await show();
    await click(await view.findByRole('button', { name: 'Merge' }));
    await click(await view.findByRole('button', { name: 'Confirm merge?' }));
    await waitUntil(() =>
      expect(view.getByRole('status').textContent).toContain(
        'GitHub refused it. The GitHub App connected in MindRoom may not have write access to this repository (Pull requests and Contents: Read and write). Resource not accessible by integration'
      )
    );
    // A token of the person's own can do it instead, from the browser.
    await choose(view, 'Use a token in this browser');
    const field = view.getByLabelText('GitHub token');
    expect(document.activeElement).toBe(field);
    fetchMock.mockImplementation(github);
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        field,
        'ghp_mine'
      );
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(view.getByLabelText('Only this browser'));
    await click(view.getByRole('button', { name: 'Save' }));
    await toggleMore(view);
    await waitUntil(() =>
      expect(view.getByRole('menuitem', { name: 'Forget token' })).toBeTruthy()
    );
    expect(view.queryByText(/through MindRoom/)).toBeNull();
    expect(view.queryByText('Use a token in this browser')).toBeNull();
    await waitUntil(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ghp_mine');
  });

  it('closes the form opened to use a token instead without saving one', async () => {
    const mindroom = githubServer(github);
    roomServer.current = mindroom.server;
    const view = await show();
    await choose(view, 'Use a token in this browser');
    expect(view.getByLabelText('GitHub token')).toBeTruthy();
    await click(view.getByRole('button', { name: 'Cancel' }));
    expect(view.queryByLabelText('GitHub token')).toBeNull();
    await toggleMore(view);
    expect(view.getByText('Use a token in this browser')).toBeTruthy();
    expect(view.getByText('Signed in as octo through MindRoom')).toBeTruthy();
  });

  it('says MindRoom must connect GitHub again when GitHub refuses its account', async () => {
    const mindroom = githubServer(async (url, init) =>
      init?.method === 'PUT' ? respond({ message: 'Bad credentials' }, 401) : github(url, init)
    );
    roomServer.current = mindroom.server;
    const view = await show();
    await click(await view.findByRole('button', { name: 'Merge' }));
    await click(await view.findByRole('button', { name: 'Confirm merge?' }));
    await waitUntil(() =>
      expect(view.getByRole('status').textContent).toContain(
        'Could not merge this pull request GitHub refused your account connected in MindRoom. Connect GitHub again in MindRoom.'
      )
    );
  });

  it("says it loads, not the forgotten token's error, while it reads without it", async () => {
    localStorage.setItem(TOKEN_KEY, 'ghp_refused');
    let release!: (value: Response) => void;
    const held = new Promise<Response>((resolve) => (release = resolve));
    fetchMock.mockImplementation(async (url, init) =>
      new Headers(init?.headers).has('authorization')
        ? respond({ message: 'Bad credentials' }, 401)
        : held
    );
    const view = await show();
    expect(await view.findByText('GitHub refused the saved token.')).toBeTruthy();
    await click(view.getByRole('button', { name: 'Forget token' }));
    await waitUntil(() => expect(view.getByText('Loading pull request')).toBeTruthy());
    expect(view.queryByText('GitHub refused the saved token.')).toBeNull();
    expect(view.queryByLabelText('GitHub token')).toBeNull();
    await act(async () => release(respond(pull())));
    expect(await view.findByText('Add pull request cards')).toBeTruthy();
    expect(view.queryByLabelText('GitHub token')).toBeNull();
  });

  it('closes the form once a token saved in the browser over a refused one reads', async () => {
    localStorage.setItem(TOKEN_KEY, 'ghp_old');
    fetchMock.mockImplementation(async (url, init) => {
      await new Promise((r) => setTimeout(r, 20));
      const auth = new Headers(init?.headers).get('authorization');
      if (auth && !auth.includes('ghp_good')) return respond({ message: 'Bad credentials' }, 401);
      return url.endsWith('/pulls/200') ? respond(pull()) : respond([]);
    });
    const view = await show();
    expect(await view.findByText('GitHub refused the saved token.')).toBeTruthy();
    await type(view.getByLabelText('GitHub token'), 'ghp_good');
    await click(view.getByRole('button', { name: 'Save' }));
    expect(await view.findByText('Add pull request cards')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 100));
    expect(view.queryByLabelText('GitHub token')).toBeNull();
  });

  it('reads with the token stored in the browser first, and asks MindRoom nothing', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok');
    const mindroom = githubServer(github);
    roomServer.current = mindroom.server;
    fetchMock.mockImplementation(github);
    const view = await show();
    expect(await view.findByRole('button', { name: 'Merge' })).toBeTruthy();
    expect(mindroom.server.request).not.toHaveBeenCalled();
    expect(view.queryByText(/through MindRoom/)).toBeNull();
    await toggleMore(view);
    expect(view.getByRole('menuitem', { name: 'Forget token' })).toBeTruthy();
  });

  it('reads without either and offers no writes while MindRoom has no GitHub connected', async () => {
    const mindroom = githubServer(github, { connected: false });
    roomServer.current = mindroom.server;
    const view = await show();
    await view.findByText('Add pull request cards');
    expect(mindroom.githubRequests()).toEqual([]);
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => url === GRAPHQL)).toEqual([]);
    expect(view.queryByRole('button', { name: 'Merge' })).toBeNull();
    expect(view.queryByText(/through MindRoom/)).toBeNull();
  });

  it('reads without it once MindRoom says the connection went away', async () => {
    const mindroom = githubServer(github);
    roomServer.current = mindroom.server;
    const view = await show();
    expect(await view.findByRole('button', { name: 'Merge' })).toBeTruthy();
    mindroom.connected(false);
    await click(view.getByRole('button', { name: 'Merge' }));
    await click(await view.findByRole('button', { name: 'Confirm merge?' }));
    // The write failed, and the panel reads the pull request anonymously, with no writes.
    await waitUntil(() => expect(view.queryByRole('button', { name: 'Merge' })).toBeNull());
    await waitUntil(() => expect(fetchMock).toHaveBeenCalled());
    expect(view.queryByText(/through MindRoom/)).toBeNull();
  });

  /** A GitHub that knows `ghp_good` as `pat-login`, and reads the rest as `github` does. */
  const withUser = (url: string, init?: RequestInit) =>
    url === 'https://api.github.com/user'
      ? Promise.resolve(
          new Headers(init?.headers).get('authorization') === 'Bearer ghp_good'
            ? respond({ login: 'pat-login' })
            : respond({ message: 'Bad credentials' }, 401)
        )
      : github(url, init);
  const type = (field: HTMLElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const saveInMindroom = (mindroom: ReturnType<typeof githubServer>) =>
    mindroom.server.request('/api/github/token', {
      method: 'PUT',
      body: JSON.stringify({ token: 'ghp_good' }),
    });

  it('saves a token in MindRoom from the form opened to use one, which then closes', async () => {
    const mindroom = githubServer(withUser);
    roomServer.current = mindroom.server;
    const view = await show();
    await choose(view, 'Use a token in this browser');
    await type(view.getByLabelText('GitHub token'), 'ghp_good');
    await click(view.getByLabelText('Save in MindRoom at mindroom.example.org'));
    view.getByRole('button', { name: 'Save' }).focus();
    await click(view.getByRole('button', { name: 'Save' }));
    await waitUntil(() => expect(view.queryByLabelText('GitHub token')).toBeNull());
    // The focus goes from Save, gone with the form, to the pull request's title.
    await waitUntil(() => expect(document.activeElement?.className).toBe('mrpr-panel-title'));
    await signedInAs(view, 'Signed in as pat-login through MindRoom');
    expect(mindroom.storedToken()).toBe('ghp_good');
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(document.body.innerHTML).not.toContain('ghp_good');
    // The panel reads as the token's account, through MindRoom: the page asks GitHub nothing.
    await waitUntil(() =>
      expect(
        github.mock.calls.some(
          ([url, init]) =>
            url.includes('/pulls/') && new Headers(init?.headers).has('authorization')
        )
      ).toBe(true)
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the form opened to use a token, what it says and the token, when MindRoom refuses to save it', async () => {
    const mindroom = githubServer(withUser);
    roomServer.current = mindroom.server;
    const view = await show();
    await choose(view, 'Use a token in this browser');
    await type(view.getByLabelText('GitHub token'), 'ghp_refused');
    await click(view.getByLabelText('Save in MindRoom at mindroom.example.org'));
    await click(view.getByRole('button', { name: 'Save' }));
    await waitUntil(() =>
      expect(view.getByRole('alert').textContent).toBe('GitHub refused this token.')
    );
    expect((view.getByLabelText('GitHub token') as HTMLInputElement).value).toBe('ghp_refused');
    // The form opened for it says whose connection the token replaces.
    expect(view.getByText(/^Signed in as octo through MindRoom \(GitHub App\)\./)).toBeTruthy();
  });

  it('shows the error, not what the removed token read, once the App cannot read the pull request', async () => {
    // The App is not installed on the repository, which the token could read.
    const mindroom = githubServer(async (url, init) =>
      url !== 'https://api.github.com/user' && !new Headers(init?.headers).has('authorization')
        ? respond({ message: 'Not Found' }, 404)
        : withUser(url, init)
    );
    await saveInMindroom(mindroom);
    roomServer.current = mindroom.server;
    const view = await show();
    await signedInAs(view, 'Signed in as pat-login through MindRoom');
    const title = view.container.querySelector('.mrpr-panel-title')?.textContent;
    expect(title).toBeTruthy();
    await choose(view, 'Remove token from MindRoom');
    expect(
      await view.findByText(
        'GitHub did not find this pull request. The GitHub App connected in MindRoom may not be installed on this repository.'
      )
    ).toBeTruthy();
    expect(view.queryByText(title as string)).toBeNull();
    // The focus goes from the entry, gone with the menu, to what says the token is removed.
    expect(view.getByLabelText('GitHub token')).toBeTruthy();
    await waitUntil(() =>
      expect(document.activeElement).toBe(view.getByText('Token removed from MindRoom.'))
    );
  });

  it('keeps saying the token is removed, focused, once the pull request no longer reads without it', async () => {
    const mindroom = githubServer(withUser);
    await saveInMindroom(mindroom);
    // No GitHub App: once the token is removed, the panel reads anonymously, and GitHub hides it.
    mindroom.connected(false);
    fetchMock.mockImplementation(async () => respond({ message: 'Not Found' }, 404));
    roomServer.current = mindroom.server;
    const view = await show();
    await signedInAs(view, 'Signed in as pat-login through MindRoom');
    await choose(view, 'Remove token from MindRoom');
    await waitUntil(() => expect(fetchMock).toHaveBeenCalled());
    expect(await view.findByText(/GitHub did not find this pull request/)).toBeTruthy();
    const note = view.getByText('Token removed from MindRoom.');
    await waitUntil(() => expect(document.activeElement).toBe(note));
    expect(mindroom.storedToken()).toBeUndefined();
    // A token saved there again is not the one removed.
    await type(view.getByLabelText('GitHub token'), 'ghp_good');
    await click(view.getByLabelText('Save in MindRoom at mindroom.example.org'));
    await click(view.getByRole('button', { name: 'Save' }));
    await signedInAs(view, 'Signed in as pat-login through MindRoom');
    expect(view.queryByText('Token removed from MindRoom.')).toBeNull();
  });

  it('leaves the focus where the person moved it while the token was being removed', async () => {
    const mindroom = githubServer(withUser);
    await saveInMindroom(mindroom);
    let proceed!: () => void;
    const held = new Promise<void>((resolve) => (proceed = resolve));
    const real = mindroom.server.request.getMockImplementation()!;
    mindroom.server.request.mockImplementation(async (path, init) => {
      if (path === '/api/github/token' && init?.method === 'DELETE') await held;
      return real(path, init);
    });
    roomServer.current = mindroom.server;
    const view = await show();
    await choose(view, 'Remove token from MindRoom');
    const elsewhere = document.body.appendChild(document.createElement('button'));
    try {
      elsewhere.focus();
      await act(async () => proceed());
      const note = await view.findByText('Token removed from MindRoom.');
      // Said, not focused: the line it is in is a live region.
      expect(note.closest('[aria-live="polite"]')).toBeTruthy();
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  it('leaves the focus on the title the person moved it back to, though the panel put it there once', async () => {
    const mindroom = githubServer(withUser);
    let proceed!: () => void;
    const held = new Promise<void>((resolve) => (proceed = resolve));
    const real = mindroom.server.request.getMockImplementation()!;
    mindroom.server.request.mockImplementation(async (path, init) => {
      if (path === '/api/github/token' && init?.method === 'DELETE') await held;
      return real(path, init);
    });
    roomServer.current = mindroom.server;
    const view = await show();
    // Saved from the form opened for it, which goes: the panel puts the focus on the title.
    await choose(view, 'Use a token in this browser');
    await type(view.getByLabelText('GitHub token'), 'ghp_good');
    await click(view.getByLabelText('Save in MindRoom at mindroom.example.org'));
    view.getByRole('button', { name: 'Save' }).focus();
    await click(view.getByRole('button', { name: 'Save' }));
    const title = () => view.container.querySelector<HTMLElement>('.mrpr-panel-title');
    await waitUntil(() => expect(document.activeElement).toBe(title()));
    await choose(view, 'Remove token from MindRoom');
    // The entry went with the menu, and the panel put the focus on the title in its place; the
    // person moves it on, and back.
    await waitUntil(() => expect(document.activeElement).toBe(title()));
    view.getByRole('button', { name: 'More actions' }).focus();
    title()?.focus();
    await act(async () => proceed());
    await view.findByText('Token removed from MindRoom.');
    expect(document.activeElement).toBe(title());
  });

  it('focuses the note once per removal, not again when a later save fails', async () => {
    const mindroom = githubServer(withUser);
    await saveInMindroom(mindroom);
    mindroom.connected(false);
    fetchMock.mockImplementation(async () => respond({ message: 'Not Found' }, 404));
    roomServer.current = mindroom.server;
    const view = await show();
    await choose(view, 'Remove token from MindRoom');
    const note = await view.findByText('Token removed from MindRoom.');
    await waitUntil(() => expect(document.activeElement).toBe(note));
    await type(view.getByLabelText('GitHub token'), 'ghp_bad');
    await click(view.getByLabelText('Save in MindRoom at mindroom.example.org'));
    view.getByRole('button', { name: 'Save' }).focus();
    await click(view.getByRole('button', { name: 'Save' }));
    await waitUntil(() => expect(mindroom.tokenRequests()).toEqual(['PUT', 'DELETE', 'PUT']));
    await waitUntil(() => expect(document.activeElement).toBe(view.getByLabelText('GitHub token')));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement).toBe(view.getByLabelText('GitHub token'));
  });

  const UNREADABLE = 'MindRoom cannot read the token saved there. Save a new one or remove it.';

  it('says MindRoom cannot read the token saved there, and saves a new one there', async () => {
    const mindroom = githubServer(withUser);
    await saveInMindroom(mindroom);
    mindroom.unreadable(true);
    roomServer.current = mindroom.server;
    const view = await show();
    expect(await view.findByText(UNREADABLE)).toBeTruthy();
    // Meanwhile the panel reads without it, as nothing goes through MindRoom.
    expect(await view.findByText('Add pull request cards')).toBeTruthy();
    expect(mindroom.githubRequests()).toEqual([]);
    // The person picks the server by its name: the answer that asks for a token is the server's.
    const inMindroom = view.getByLabelText('Save in MindRoom at mindroom.example.org');
    expect((inMindroom as HTMLInputElement).checked).toBe(false);
    expect((view.getByLabelText('Only this browser') as HTMLInputElement).checked).toBe(true);
    expect(view.getByRole('button', { name: 'Remove token from MindRoom' })).toBeTruthy();
    await type(view.getByLabelText('GitHub token'), 'ghp_good');
    await click(inMindroom);
    await click(view.getByRole('button', { name: 'Save' }));
    await signedInAs(view, 'Signed in as pat-login through MindRoom');
    expect(view.queryByText(UNREADABLE)).toBeNull();
    expect(view.queryByLabelText('GitHub token')).toBeNull();
  });

  it('offers to mend the token MindRoom cannot read while the pull request still loads without it', async () => {
    const mindroom = githubServer(withUser);
    await saveInMindroom(mindroom);
    mindroom.unreadable(true);
    let release!: (value: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
    roomServer.current = mindroom.server;
    const view = await show();
    await waitUntil(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await view.findByText(UNREADABLE)).toBeTruthy();
    expect(view.getByText('Loading pull request')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Remove token from MindRoom' })).toBeTruthy();
    // The form stays as the read ends, with what was typed in it.
    await type(view.getByLabelText('GitHub token'), 'ghp_typed');
    await act(async () => release(respond({ message: 'Not Found' }, 404)));
    await waitUntil(() => expect(view.queryByText('Loading pull request')).toBeNull());
    expect((view.getByLabelText('GitHub token') as HTMLInputElement).value).toBe('ghp_typed');
    expect(view.getAllByLabelText('GitHub token')).toHaveLength(1);
  });

  describe('a save from the token form, while the pull request reads again', () => {
    const refused = 'GitHub refused this token.';
    const saveBad = async (view: Awaited<ReturnType<typeof show>>, token = 'ghp_bad') => {
      await type(view.getByLabelText('GitHub token'), token);
      await click(view.getByLabelText('Save in MindRoom at mindroom.example.org'));
      await click(view.getByRole('button', { name: 'Save' }));
    };
    const kept = (view: Awaited<ReturnType<typeof show>>, token = 'ghp_bad') => {
      expect((view.getByLabelText('GitHub token') as HTMLInputElement).value).toBe(token);
      const inMindroom = view.getByLabelText('Save in MindRoom at mindroom.example.org');
      expect((inMindroom as HTMLInputElement).checked).toBe(true);
    };

    it('keeps the form and says the token was refused once the pull request read again loaded', async () => {
      const mindroom = githubServer(withUser);
      mindroom.connected(false);
      const real = mindroom.server.request.getMockImplementation()!;
      let releasePut!: () => void;
      const put = new Promise<void>((resolve) => (releasePut = resolve));
      mindroom.server.request.mockImplementation(async (path, init) => {
        if (path === '/api/github/token' && init?.method === 'PUT') await put;
        return real(path, init);
      });
      roomServer.current = mindroom.server;
      fetchMock.mockImplementation(async () => respond({ message: 'Not Found' }, 404));
      const view = await show();
      await view.findByLabelText('GitHub token');
      let releasePr!: (response: Response) => void;
      const pr = new Promise<Response>((resolve) => (releasePr = resolve));
      fetchMock.mockImplementation(() => pr);
      const key = ['pull-requests', 'pr', 'mindroom-ai', 'mindroom-chat', 200, false];
      await act(async () => void client.refetchQueries({ queryKey: key, exact: true }));
      await saveBad(view);
      await waitUntil(() => expect(mindroom.tokenRequests()).toEqual(['PUT']));
      await act(async () => releasePr(respond(pull())));
      expect(await view.findByText('Add pull request cards')).toBeTruthy();
      await act(async () => releasePut());
      expect(await view.findByText(refused)).toBeTruthy();
      kept(view);
    });

    it('keeps the form when the save starts in the same batch as the pull request loads', async () => {
      notifyManager.setScheduler(queueMicrotask);
      const mindroom = githubServer(withUser);
      mindroom.connected(false);
      const real = mindroom.server.request.getMockImplementation()!;
      let releasePut!: () => void;
      const put = new Promise<void>((resolve) => (releasePut = resolve));
      mindroom.server.request.mockImplementation(async (path, init) => {
        if (path === '/api/github/token' && init?.method === 'PUT') await put;
        return real(path, init);
      });
      roomServer.current = mindroom.server;
      fetchMock.mockImplementation(async () => respond({ message: 'Not Found' }, 404));
      const view = await show();
      await type(await view.findByLabelText('GitHub token'), 'ghp_bad');
      await click(view.getByLabelText('Save in MindRoom at mindroom.example.org'));
      let releasePr!: (response: Response) => void;
      const pr = new Promise<Response>((resolve) => (releasePr = resolve));
      fetchMock.mockImplementation(() => pr);
      const key = ['pull-requests', 'pr', 'mindroom-ai', 'mindroom-chat', 200, false];
      await act(async () => void client.refetchQueries({ queryKey: key, exact: true }));
      try {
        await act(async () => {
          view.getByRole('button', { name: 'Save' }).click();
          releasePr(respond(pull()));
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
        await view.findByText('Add pull request cards');
        await act(async () => releasePut());
        expect(await view.findByText(refused)).toBeTruthy();
        kept(view);
      } finally {
        releasePr(respond(pull()));
        releasePut();
        notifyManager.setScheduler((callback) => setTimeout(callback, 0));
      }
    });

    it('keeps the form and says the removal failed, though the status after it failed too', async () => {
      const mindroom = githubServer(withUser);
      await saveInMindroom(mindroom);
      mindroom.unreadable(true);
      const real = mindroom.server.request.getMockImplementation()!;
      let deleting = false;
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      mindroom.server.request.mockImplementation(async (path, init) => {
        if (path === '/api/github/token' && init?.method === 'DELETE') {
          deleting = true;
          await held;
          throw new MindroomServerError('Internal Server Error', 500, {});
        }
        if (deleting && path === '/api/github/status') {
          throw new MindroomServerError('Internal Server Error', 500, {});
        }
        return real(path, init);
      });
      roomServer.current = mindroom.server;
      const view = await show();
      const remove = await view.findByRole('button', { name: 'Remove token from MindRoom' });
      await view.findByText('Add pull request cards');
      await click(remove);
      await act(async () => release());
      expect(await view.findByText('MindRoom could not remove the token.')).toBeTruthy();
      expect(view.getByRole('button', { name: 'Cancel' })).toBeTruthy();
      expect(view.getAllByLabelText('GitHub token')).toHaveLength(1);
    });

    it('stops saying MindRoom cannot read the token once it is removed from the form', async () => {
      const mindroom = githubServer(withUser);
      await saveInMindroom(mindroom);
      mindroom.unreadable(true);
      roomServer.current = mindroom.server;
      const view = await show();
      await view.findByText('Add pull request cards');
      await saveBad(view);
      expect(await view.findByText(refused)).toBeTruthy();
      await click(view.getByRole('button', { name: 'Remove token from MindRoom' }));
      expect(await view.findByText('Token removed from MindRoom.')).toBeTruthy();
      // The removal it started succeeded: the form goes, and with it what it said.
      await waitUntil(() => expect(view.queryByText(UNREADABLE)).toBeNull());
      expect(view.queryByLabelText('GitHub token')).toBeNull();
    });

    it('keeps an untouched form once the pull request loads, until Cancel', async () => {
      let release!: (value: Response) => void;
      const held = new Promise<Response>((resolve) => (release = resolve));
      fetchMock.mockImplementation(async () => respond({ message: 'Not Found' }, 404));
      roomServer.current = githubServer(withUser, { connected: false }).server;
      const view = await show();
      expect(await view.findByLabelText('GitHub token')).toBeTruthy();
      fetchMock.mockImplementation(() => held);
      const key = ['pull-requests', 'pr', 'mindroom-ai', 'mindroom-chat', 200, false];
      await act(async () => void client.refetchQueries({ queryKey: key, exact: true }));
      await act(async () => release(respond(pull())));
      expect(await view.findByText('Add pull request cards')).toBeTruthy();
      expect(view.getAllByLabelText('GitHub token')).toHaveLength(1);
      await click(view.getByRole('button', { name: 'Cancel' }));
      expect(view.queryByLabelText('GitHub token')).toBeNull();
    });

    const panelFor = (number: number) => (
      <QueryClientProvider client={client}>
        <PullRequestPanel roomId="!room:example.org" request={{ ...REQUEST, number }} />
      </QueryClientProvider>
    );

    it("a removal finishing for an earlier pull request leaves this one's form", async () => {
      const mindroom = githubServer(withUser);
      await saveInMindroom(mindroom);
      mindroom.connected(false);
      mindroom.unreadable(true);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const real = mindroom.server.request.getMockImplementation()!;
      mindroom.server.request.mockImplementation(async (path, init) => {
        if (path === '/api/github/token' && init?.method === 'DELETE') await held;
        return real(path, init);
      });
      roomServer.current = mindroom.server;
      const view = await show();
      try {
        await click(await view.findByRole('button', { name: 'Remove token from MindRoom' }));
        view.rerender(panelFor(201));
        const input = (await view.findByLabelText('GitHub token')) as HTMLInputElement;
        await type(input, 'ghp_draft');
        await act(async () => release());
        await view.findByText('Token removed from MindRoom.');
        expect(view.getByLabelText('GitHub token')).toBe(input);
        expect(input.value).toBe('ghp_draft');
      } finally {
        release();
      }
    });

    it('leaves no form on a pull request shown again for a part failure of the one before', async () => {
      fetchMock.mockImplementation(async (url) => {
        if (/\/pulls\/\d+$/.test(url)) {
          return respond(pull({ title: url.endsWith('/pulls/200') ? 'PR A' : 'PR B' }));
        }
        if (new URL(url).pathname.endsWith('/pulls/200/reviews')) {
          return new Response('{}', {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' },
          });
        }
        return respond([]);
      });
      const view = await show({ ...REQUEST, number: 201 });
      await view.findByText('PR B');
      await view.findByText('No comments yet.');
      expect(view.queryByLabelText('GitHub token')).toBeNull();
      view.rerender(panelFor(200));
      await view.findByText('PR A');
      await view.findByLabelText('GitHub token');
      view.rerender(panelFor(201));
      await view.findByText('PR B');
      await view.findByText('No comments yet.');
      await waitUntil(() => expect(view.queryByLabelText('GitHub token')).toBeNull());
    });

    it('releases the form when the pull request changes, even to one without a reason', async () => {
      roomServer.current = githubServer(withUser, { connected: false }).server;
      fetchMock.mockImplementation(async () => respond({}, 404));
      const view = await show();
      await view.findByLabelText('GitHub token');
      const key = ['pull-requests', 'pr', 'mindroom-ai', 'mindroom-chat', 200, false];
      fetchMock.mockImplementation(async (url) =>
        /\/pulls\/\d+$/.test(url) ? respond(pull()) : respond([])
      );
      await act(async () => void client.refetchQueries({ queryKey: key, exact: true }));
      await view.findByText('Add pull request cards');
      expect(view.getByLabelText('GitHub token')).toBeTruthy();
      view.rerender(panelFor(201));
      await view.findByText('Add pull request cards');
      await new Promise((r) => setTimeout(r, 50));
      expect(view.queryByLabelText('GitHub token')).toBeNull();
      view.rerender(panelFor(200));
      await view.findByText('Add pull request cards');
      await new Promise((r) => setTimeout(r, 50));
      expect(view.queryByLabelText('GitHub token')).toBeNull();
    });

    it('keeps the form a failed part asked for, and says the token was refused', async () => {
      const mindroom = githubServer(withUser);
      mindroom.connected(false);
      roomServer.current = mindroom.server;
      fetchMock.mockImplementation(async (url) => {
        if (url.endsWith('/pulls/200')) return respond(pull());
        await new Promise((resolve) => setTimeout(resolve, 30));
        const limited = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' };
        return new Response('{}', { status: 403, headers: limited });
      });
      const view = await show();
      await view.findByText('Add pull request cards');
      await waitUntil(() => expect(view.getAllByLabelText('GitHub token')).toHaveLength(1));
      await saveBad(view);
      expect(await view.findByText(refused)).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(view.getByText(refused)).toBeTruthy();
      kept(view);
    });

    it('keeps the form opened to use a token, and says MindRoom could not save it, on a 500', async () => {
      const mindroom = githubServer(withUser);
      const real = mindroom.server.request.getMockImplementation()!;
      mindroom.server.request.mockImplementation(async (path, init) => {
        if (path !== '/api/github/token' || init?.method !== 'PUT') return real(path, init);
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new MindroomServerError('Internal Server Error', 500, {});
      });
      const base = github.getMockImplementation()!;
      github.mockImplementation(async (url, init) => {
        if (url.endsWith('/pulls/200')) await new Promise((resolve) => setTimeout(resolve, 30));
        return base(url, init);
      });
      roomServer.current = mindroom.server;
      const view = await show();
      await choose(view, 'Use a token in this browser');
      await saveBad(view, 'ghp_good');
      const failed = 'MindRoom could not save the token. Try again.';
      expect(await view.findByText(failed)).toBeTruthy();
      await waitUntil(() => expect(view.getByText('Add pull request cards')).toBeTruthy());
      expect(view.getByText(failed)).toBeTruthy();
      kept(view, 'ghp_good');
    });
  });

  it('keeps the form, what was typed and where it saves, once the pull request reads without it', async () => {
    const mindroom = githubServer(withUser);
    await saveInMindroom(mindroom);
    mindroom.unreadable(true);
    let release!: (value: Response) => void;
    const held = new Promise<Response>((resolve) => (release = resolve));
    const files = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) =>
      url.endsWith('/pulls/200') ? held : files(url, init)
    );
    roomServer.current = mindroom.server;
    const view = await show();
    await type(await view.findByLabelText('GitHub token'), 'ghp_typed');
    await click(view.getByLabelText('Save in MindRoom at mindroom.example.org'));
    await act(async () => release(respond(pull())));
    expect(await view.findByText('Add pull request cards')).toBeTruthy();
    expect((view.getByLabelText('GitHub token') as HTMLInputElement).value).toBe('ghp_typed');
    const inMindroom = view.getByLabelText('Save in MindRoom at mindroom.example.org');
    expect((inMindroom as HTMLInputElement).checked).toBe(true);
    expect(view.getAllByLabelText('GitHub token')).toHaveLength(1);
  });

  it.each([
    ['MindRoom cannot read the token saved there', true],
    ['GitHub hides the pull request', false],
  ])(
    'keeps the form, and what was typed, when MindRoom refuses a new token while %s',
    async (_, unreadable) => {
      const mindroom = githubServer(withUser);
      if (unreadable) await saveInMindroom(mindroom);
      mindroom.connected(false);
      mindroom.unreadable(unreadable);
      fetchMock.mockImplementation(async () => respond({ message: 'Not Found' }, 404));
      roomServer.current = mindroom.server;
      const view = await show();
      await view.findByLabelText('GitHub token');
      await type(view.getByLabelText('GitHub token'), 'ghp_bad');
      await click(view.getByLabelText('Save in MindRoom at mindroom.example.org'));
      await click(view.getByRole('button', { name: 'Save' }));
      expect(await view.findByText('GitHub refused this token.')).toBeTruthy();
      expect((view.getByLabelText('GitHub token') as HTMLInputElement).value).toBe('ghp_bad');
    }
  );

  it('reads the pull request again on Try again once the token was removed elsewhere, which reads as before', async () => {
    const mindroom = githubServer(withUser);
    await saveInMindroom(mindroom);
    mindroom.unreadable(true);
    fetchMock.mockImplementation(async () => respond({ message: 'Server Error' }, 500));
    roomServer.current = mindroom.server;
    const view = await show();
    const retry = await view.findByRole('button', { name: 'Try again' }, { timeout: 5000 });
    // Removed on another device, with no App: the panel reads without either, as it did.
    mindroom.connected(false);
    await mindroom.server.request('/api/github/token', { method: 'DELETE' });
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => respond(pull()));
    await click(retry);
    await waitUntil(() => expect(view.queryByText(UNREADABLE)).toBeNull());
    await waitUntil(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/pulls/200'))).toHaveLength(1)
    );
  });

  it('keeps a failed read, its message and Try again, beside the token MindRoom cannot read', async () => {
    const mindroom = githubServer(withUser);
    await saveInMindroom(mindroom);
    mindroom.unreadable(true);
    fetchMock.mockImplementation(async () => respond({ message: 'Server Error' }, 500));
    roomServer.current = mindroom.server;
    const view = await show();
    // After the two tries again a failed read gets.
    const failed = await view.findByText('GitHub answered with status 500.', {}, { timeout: 5000 });
    expect(failed).toBeTruthy();
    expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(view.getByText(UNREADABLE)).toBeTruthy();
    expect(view.getAllByLabelText('GitHub token')).toHaveLength(1);
  });

  it('offers to remove the token MindRoom cannot read where the pull request does not read without it', async () => {
    const mindroom = githubServer(withUser);
    await saveInMindroom(mindroom);
    mindroom.connected(false);
    mindroom.unreadable(true);
    fetchMock.mockImplementation(async () => respond({ message: 'Not Found' }, 404));
    roomServer.current = mindroom.server;
    const view = await show();
    expect(await view.findByText(UNREADABLE)).toBeTruthy();
    // Asking again would get the same answer.
    expect(view.queryByRole('button', { name: 'Try again' })).toBeNull();
    view.getByRole('button', { name: 'Remove token from MindRoom' }).focus();
    await click(view.getByRole('button', { name: 'Remove token from MindRoom' }));
    const note = await view.findByText('Token removed from MindRoom.');
    await waitUntil(() => expect(document.activeElement).toBe(note));
    expect(view.queryByText(UNREADABLE)).toBeNull();
    expect(mindroom.tokenRequests()).toEqual(['PUT', 'DELETE']);
  });

  it('says MindRoom cannot read the token once a request through it answers so', async () => {
    const mindroom = githubServer(withUser);
    await saveInMindroom(mindroom);
    roomServer.current = mindroom.server;
    const view = await show();
    await signedInAs(view, 'Signed in as pat-login through MindRoom');
    mindroom.unreadable(true);
    await click(await view.findByRole('button', { name: 'Merge' }));
    await click(await view.findByRole('button', { name: 'Confirm merge?' }));
    expect(await view.findByText(UNREADABLE)).toBeTruthy();
    expect(view.queryByText(/through MindRoom/)).toBeNull();
  });

  it('keeps reading without MindRoom, saying nothing of the token, on any other 503', async () => {
    const mindroom = githubServer(github);
    const real = mindroom.server.request.getMockImplementation()!;
    mindroom.server.request.mockImplementation(async (path, init) => {
      if (path !== '/api/github/status') return real(path, init);
      throw new MindroomServerError('Service Unavailable', 503, {
        error: 'github_connection_unavailable',
      });
    });
    roomServer.current = mindroom.server;
    const view = await show();
    expect(await view.findByText('Add pull request cards')).toBeTruthy();
    expect(view.queryByText(UNREADABLE)).toBeNull();
    expect(view.queryByLabelText('GitHub token')).toBeNull();
  });

  it('names the token saved in MindRoom, and removes it from there, back to the App', async () => {
    const mindroom = githubServer(withUser);
    await saveInMindroom(mindroom);
    roomServer.current = mindroom.server;
    const view = await show();
    await toggleMore(view);
    expect(await view.findByText('Signed in as pat-login through MindRoom')).toBeTruthy();
    // What removing it changes, under the entry.
    expect(view.getByText('Then MindRoom uses your GitHub App connection.')).toBeTruthy();
    const entry = view.getByText('Remove token from MindRoom').closest('button')!;
    entry.focus();
    await click(entry);
    await waitUntil(() => expect(mindroom.storedToken()).toBeUndefined());
    // Said at the panel's top, and focused: the entry went with the menu.
    await waitUntil(() =>
      expect(document.activeElement).toBe(view.getByText('Token removed from MindRoom.'))
    );
    await toggleMore(view);
    expect(await view.findByText('Signed in as octo through MindRoom')).toBeTruthy();
    expect(view.queryByText('Remove token from MindRoom')).toBeNull();
  });

  it.each([
    [401, 'GitHub refused the token saved in MindRoom.'],
    [
      404,
      'GitHub did not find this pull request. The token saved in MindRoom may not be able to read this repository.',
    ],
  ])(
    'offers to remove the token saved in MindRoom when GitHub answers %s to it, and reads with the App then',
    async (status, said) => {
      const mindroom = githubServer(async (url, init) =>
        url !== 'https://api.github.com/user' && new Headers(init?.headers).has('authorization')
          ? respond({ message: 'No' }, status)
          : withUser(url, init)
      );
      await saveInMindroom(mindroom);
      roomServer.current = mindroom.server;
      const view = await show();
      expect(await view.findByText(said)).toBeTruthy();
      view.getByRole('button', { name: 'Remove token from MindRoom' }).focus();
      await click(view.getByRole('button', { name: 'Remove token from MindRoom' }));
      // The focus goes from the button, gone with the error, to what says the token is removed.
      await waitUntil(() =>
        expect(document.activeElement).toBe(view.getByText('Token removed from MindRoom.'))
      );
      expect(view.queryByText(said)).toBeNull();
      expect(mindroom.storedToken()).toBeUndefined();
      await signedInAs(view, 'Signed in as octo through MindRoom');
    }
  );

  it('names the token saved in MindRoom, not the App, when GitHub refuses a write with it', async () => {
    const mindroom = githubServer(async (url, init) =>
      init?.method === 'PUT'
        ? respond({ message: 'Resource not accessible by personal access token' }, 403)
        : withUser(url, init)
    );
    await saveInMindroom(mindroom);
    roomServer.current = mindroom.server;
    const view = await show();
    await click(await view.findByRole('button', { name: 'Merge' }));
    await click(await view.findByRole('button', { name: 'Confirm merge?' }));
    await waitUntil(() =>
      expect(view.getByRole('status').textContent).toContain(
        'GitHub refused it. The token saved in MindRoom may not have write access to this repository (Pull requests and Contents: Read and write). Resource not accessible by personal access token'
      )
    );
    expect(mindroom.storedToken()).toBe('ghp_good');
  });

  it('says GitHub refused the token saved in MindRoom, not the App, and keeps it', async () => {
    const mindroom = githubServer(async (url, init) =>
      init?.method === 'PUT' ? respond({ message: 'Bad credentials' }, 401) : withUser(url, init)
    );
    await saveInMindroom(mindroom);
    roomServer.current = mindroom.server;
    const view = await show();
    await click(await view.findByRole('button', { name: 'Merge' }));
    await click(await view.findByRole('button', { name: 'Confirm merge?' }));
    await waitUntil(() =>
      expect(view.getByRole('status').textContent).toContain(
        'Could not merge this pull request GitHub refused the token saved in MindRoom.'
      )
    );
    expect(mindroom.storedToken()).toBe('ghp_good');
  });
});

describe('the dense header', () => {
  const GRAPHQL = 'https://api.github.com/graphql';
  const head = { ref: 'feature', sha: 'abc123', repo: { full_name: 'mindroom-ai/mindroom-chat' } };
  const repository = {
    viewerPermission: 'WRITE',
    mergeCommitAllowed: true,
    squashMergeAllowed: false,
    rebaseMergeAllowed: false,
    autoMergeAllowed: false,
    defaultBranchRef: { name: 'main' },
  };
  // A writer's panel, whose merge GitHub refuses unless `merges`.
  const asWriter = (over: Record<string, unknown> = {}, merges = false) => {
    localStorage.setItem(
      'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/githubToken',
      'tok'
    );
    fetchMock.mockImplementation(async (url) => {
      if (url === GRAPHQL) return respond({ data: { repository } });
      if (url.includes('/merge'))
        return merges
          ? respond({ merged: true })
          : respond({ message: 'Base branch was modified' }, 405);
      if (url.includes('/compare/')) return respond({ behind_by: 0 });
      if (url.includes('/check-runs')) return respond({ check_runs: [] });
      if (url.includes('/status?')) return respond({ statuses: [] });
      if (url.includes('/files') || url.includes('/commits') || url.includes('/comments'))
        return respond([]);
      if (url.includes('/reviews')) return respond([]);
      return respond(pull({ node_id: 'PR_kw200', head, mergeable: true, ...over }));
    });
  };

  beforeEach(stubObservers);
  afterEach(() => {
    panelControl.close = undefined;
  });
  beforeEach(() => {
    panelControl.close = vi.fn();
  });
  // The panel in a box that scrolls, as the room's panel box does.
  const showScrolling = async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return renderPluginComponent(
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        <QueryClientProvider client={client}>
          <PullRequestPanel roomId="!room:example.org" request={REQUEST} />
        </QueryClientProvider>
      </div>,
      { id: 'pull-requests', plugin }
    );
  };
  // Its name says what it does and which pull request it shows.
  const bar = 'Show details of pull request #200: Add pull request cards';

  it('puts the crumbs with More actions and Close, the title, the meta and the branches in that order', async () => {
    asWriter();
    const view = await show();
    const title = await view.findByRole('heading', { level: 2, name: 'Add pull request cards' });
    await view.findByRole('button', { name: 'Merge' });
    const crumbs = view.container.querySelector<HTMLElement>('.mrpr-crumbs');
    const parts = Array.from(crumbs?.querySelectorAll('a, button') ?? []).map(
      (part) => part.getAttribute('aria-label') ?? part.textContent
    );
    expect(parts).toEqual([
      'mindroom-ai/mindroom-chat',
      '#200',
      'More actions',
      'Close pull request panel',
    ]);
    const meta = view.container.querySelector<HTMLElement>('.mrpr-panel-meta');
    expect(meta?.textContent).toMatch(/^Bbasnijholt·updated 2 days ago.*3 files.*\+10.*-2/);
    const branches = view.container.querySelector<HTMLElement>('.mrpr-branches');
    expect(branches?.textContent).toMatch(/^main.*feature.*Merge$/);
    const order = [crumbs, title, meta, branches] as HTMLElement[];
    order.slice(1).forEach((part, index) => {
      expect(order[index]?.compareDocumentPosition(part)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });
    // The rows of before are gone: no copy button, no Open on GitHub link.
    expect(view.container.querySelector('.mrpr-header-actions')).toBeNull();
    expect(view.queryByRole('link', { name: 'Open on GitHub' })).toBeNull();
    expect(view.queryByRole('button', { name: /^Copy checkout command/ })).toBeNull();
  });

  it('keeps Copy checkout command and Open on GitHub in More actions, also without a token', async () => {
    const writeText = vi.fn(async () => undefined);
    const open = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('open', open);
    const view = await show();
    await click(await view.findByRole('button', { name: 'More actions' }));
    await click(view.getByRole('menuitem', { name: 'Open on GitHub' }));
    expect(open).toHaveBeenCalledWith(
      'https://github.com/mindroom-ai/mindroom-chat/pull/200',
      '_blank',
      'noopener,noreferrer'
    );
    await click(view.getByRole('button', { name: 'More actions' }));
    await click(view.getByRole('menuitem', { name: 'Copy checkout command' }));
    expect(writeText).toHaveBeenCalledWith('gh pr checkout 200 -R mindroom-ai/mindroom-chat');
    // The entry says so, to a screen reader too, and the menu stays open meanwhile.
    const copied = await view.findByRole('menuitem', { name: 'Copied' });
    expect(copied.getAttribute('aria-live')).toBe('polite');
  });

  it('closes the panel with its Close', async () => {
    const close = vi.fn();
    panelControl.close = close;
    const view = await show();
    await view.findByText('Add pull request cards');
    await click(view.getByRole('button', { name: 'Close pull request panel' }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('can be closed while the pull request loads', async () => {
    const close = vi.fn();
    panelControl.close = close;
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    const view = await show();
    expect(view.getByText('Loading pull request')).toBeTruthy();
    await click(view.getByRole('button', { name: 'Close pull request panel' }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('shows a bar that scrolls back to the top once the header is out of view', async () => {
    const view = await showScrolling();
    await view.findByText('Add pull request cards');
    const scroller = view.getByTestId('scroller');
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo as typeof scroller.scrollTo;
    expect(view.queryByRole('button', { name: bar })).toBeNull();
    // The observer watches the header against the box that scrolls.
    expect(observers.at(-1)?.targets).toEqual([view.container.querySelector('.mrpr-header')]);
    await report(false);
    const button = view.getByRole('button', { name: bar });
    expect(button.textContent).toBe('#200Add pull request cards');
    await click(button);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
    await report(true);
    expect(view.queryByRole('button', { name: bar })).toBeNull();
    expect(view.getByText('mindroom-ai/mindroom-chat')).toBeTruthy();
  });

  it('keeps the focus on the number as the top row turns into the bar and back', async () => {
    const view = await showScrolling();
    await view.findByText('Add pull request cards');
    const number = () => view.getByRole('link', { name: '#200' });
    act(() => number().focus());
    await report(false);
    expect(document.activeElement).toBe(view.getByRole('button', { name: bar }));
    await report(true);
    expect(document.activeElement).toBe(number());
    // What stays in the row keeps its focus, and focus elsewhere stays where it is.
    act(() => view.getByRole('button', { name: 'More actions' }).focus());
    await report(false);
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'More actions' }));
    act(() => view.getByRole('tab', { name: 'Summary' }).focus());
    await report(true);
    expect(document.activeElement).toBe(view.getByRole('tab', { name: 'Summary' }));
  });

  it("watches the header again under the top row's new height", async () => {
    const view = await showScrolling();
    await view.findByText('Add pull request cards');
    const bar = view.container.querySelector('.mrpr-bar') as Element;
    await act(async () => {
      for (const callback of resized) {
        callback(
          [{ target: bar, contentRect: { height: 60 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver
        );
      }
    });
    const watching = observers.filter(({ targets }) => targets.length > 0);
    expect(watching.map(({ options }) => options?.rootMargin)).toEqual(['-60px 0px 0px 0px']);
  });

  it('does not collapse on the Code tab, which scrolls itself', async () => {
    const view = await showScrolling();
    await view.findByText('Add pull request cards');
    await click(view.getByRole('tab', { name: 'Code' }));
    await report(false);
    expect(view.queryByRole('button', { name: bar })).toBeNull();
  });

  it('does not collapse while the result of an action shows', async () => {
    asWriter();
    const view = await showScrolling();
    await click(await view.findByRole('button', { name: 'Merge' }));
    await click(await view.findByRole('button', { name: 'Confirm merge?' }));
    expect(await view.findByText(/Base branch was modified/)).toBeTruthy();
    await report(false);
    expect(view.queryByRole('button', { name: bar })).toBeNull();
    await click(view.getByRole('button', { name: 'Dismiss' }));
    await report(false);
    expect(view.getByRole('button', { name: bar })).toBeTruthy();
  });

  it('has no button on the branch line of a merged pull request', async () => {
    asWriter({ state: 'closed', merged_at: '2026-11-02T00:00:00Z' });
    const view = await show();
    await view.findByRole('button', { name: 'More actions' });
    const branches = view.container.querySelector<HTMLElement>('.mrpr-branches');
    expect(branches?.textContent).toMatch(/^main.*feature$/);
    expect(branches?.querySelector('button')).toBeNull();
  });
});
