// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequest, PullRequestRef } from '../github';
import plugin from '../index';
import { TimelineTab } from './TimelineTab';

const empty = vi.hoisted(() => ({ on: false }));
// One test shows the tab with no events at all, which the real timeline never has (it opens with
// the pull request itself).
vi.mock('./detail.logic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./detail.logic')>();
  return {
    ...actual,
    buildTimeline: (...args: Parameters<typeof actual.buildTimeline>) =>
      empty.on ? [] : actual.buildTimeline(...args),
  };
});

vi.mock('@mindroom/client-sdk/ui', async (importOriginal) => {
  const ui = await importOriginal<typeof import('@mindroom/client-sdk/ui')>();
  return { ...ui, useMarkdownHtml: (markdown: string) => markdown };
});

const REF: PullRequestRef = { owner: 'mindroom-ai', repo: 'mindroom-chat', number: 200 };
const HEAD = 'headsha';
const PR_URL = 'https://github.com/mindroom-ai/mindroom-chat/pull/200';

const pull = (over: Partial<PullRequest> = {}): PullRequest => ({
  title: 'Add pull request cards',
  state: 'open',
  draft: false,
  body: 'Shows a **bold** claim.',
  author: null,
  labels: [],
  requestedReviewers: [],
  requestedTeams: [],
  mergeableState: null,
  autoMerge: null,
  headSha: HEAD,
  headRepo: 'mindroom-ai/mindroom-chat',
  baseRepo: 'mindroom-ai/mindroom-chat',
  mergedAt: null,
  closedAt: null,
  commentCount: 0,
  reviewCommentCount: 0,
  commitCount: 1,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  baseRef: 'main',
  headRef: 'feature',
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  url: PR_URL,
  ...over,
});

const user = (login: string, type = 'User') => ({ login, type, avatar_url: null, html_url: 'x' });

const review = (id: number, login: string | null, state: string, over = {}) => ({
  id,
  state,
  user: login === null ? null : user(login),
  body: '',
  commit_id: HEAD,
  submitted_at: new Date(Date.UTC(2026, 10, 1, 0, id)).toISOString(),
  html_url: `https://github.com/r/${id}`,
  ...over,
});

const issueComment = (id: number, login: string, body: string, over = {}) => ({
  id,
  user: user(login),
  body,
  created_at: new Date(Date.UTC(2026, 10, 1, 0, id)).toISOString(),
  html_url: `https://github.com/c/${id}`,
  reactions: {},
  ...over,
});

const reviewComment = (id: number, over = {}) => ({
  ...issueComment(id, 'ann', `Thread ${id}`),
  path: 'src/a.ts',
  line: 12,
  original_line: 12,
  side: 'RIGHT',
  position: 3,
  commit_id: HEAD,
  ...over,
});

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString();
const commit = (sha: string, message: string, minute: number) => ({
  sha,
  html_url: `https://github.com/c/${sha}`,
  author: user('ann'),
  commit: { message, author: { name: 'Ann' }, committer: { date: at(minute) } },
});

type Parts = {
  commits?: unknown[] | Response;
  reviews?: unknown[];
  comments?: unknown[] | ((url: string) => unknown[]);
  reviewComments?: unknown[];
};

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const serve = (parts: Parts = {}) =>
  fetchMock.mockImplementation(async (url) => {
    const answer = (part: unknown[] | Response | undefined) =>
      part instanceof Response ? part : respond(part ?? []);
    if (url.includes('/pulls/200/commits')) return answer(parts.commits);
    if (url.includes('/pulls/200/reviews')) return answer(parts.reviews);
    if (url.includes('/pulls/200/comments')) return answer(parts.reviewComments);
    if (url.includes('/issues/200/comments')) {
      return answer(typeof parts.comments === 'function' ? parts.comments(url) : parts.comments);
    }
    throw new Error(`unexpected request ${url}`);
  });

const show = async (
  over: {
    order?: 'newest' | 'oldest';
    pullRequest?: PullRequest;
    onOpenCommit?: (sha: string) => void;
  } = {}
) => {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, retry: false } } });
  return renderPluginComponent(
    <QueryClientProvider client={client}>
      <TimelineTab
        pullRequestRef={REF}
        pullRequest={over.pullRequest ?? pull()}
        order={over.order ?? 'newest'}
        onOpenCommit={over.onOpenCommit ?? (() => undefined)}
      />
    </QueryClientProvider>,
    { id: 'pull-requests', plugin }
  );
};

const click = (element: HTMLElement) => act(async () => element.click());

/** The titles of the timeline's events, in order. */
const rows = (container: HTMLElement) =>
  [...container.querySelectorAll('.mrpr-timeline-event')].map((row) => row.textContent ?? '');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  empty.on = false;
  fetchMock.mockReset();
  serve();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TimelineTab', () => {
  const full = () =>
    serve({
      commits: [commit('abcdef1234', 'Add cards', 5)],
      reviews: [review(1, 'bob', 'APPROVED', { submitted_at: at(10) })],
      reviewComments: [reviewComment(20, { created_at: at(15) })],
    });

  it('lists opened, commits, verdicts, threads and merged newest first', async () => {
    full();
    const view = await show({
      pullRequest: pull({ createdAt: at(0), mergedAt: at(30), closedAt: at(30), state: 'merged' }),
    });
    await view.findByText('Add cards');
    const events = rows(view.container);
    expect(events).toHaveLength(5);
    expect(events[0]).toContain('Pull request merged');
    expect(events[1]).toContain('Thread 20');
    expect(events[2]).toContain('Approved');
    expect(events[3]).toContain('Add cards');
    expect(events[3]).toContain('abcdef1');
    expect(events[4]).toContain('Pull request opened');
    // The thread shows expanded, with its path.
    expect(events[1]).toContain('src/a.ts:12');
  });

  it('oldest first reverses', async () => {
    full();
    const view = await show({ order: 'oldest', pullRequest: pull({ createdAt: at(0) }) });
    await view.findByText('Add cards');
    const events = rows(view.container);
    expect(events[0]).toContain('Pull request opened');
    expect(events.at(-1)).toContain('Thread 20');
  });

  it('shows a verdict on earlier commits as such and a dismissed one as dismissed', async () => {
    serve({
      reviews: [
        review(1, 'bob', 'APPROVED', { commit_id: 'old', submitted_at: at(10) }),
        review(2, 'cy', 'DISMISSED', { submitted_at: at(11) }),
      ],
    });
    const view = await show();
    expect(await view.findByText('Approved earlier changes')).toBeTruthy();
    expect(view.getByText('Review dismissed')).toBeTruthy();
  });

  it('says Outdated on an outdated thread and names a missing author ghost', async () => {
    serve({
      reviewComments: [{ ...reviewComment(21), position: null, line: null, user: null }],
    });
    const view = await show();
    expect(await view.findByText('Outdated')).toBeTruthy();
    expect(view.getByText('ghost')).toBeTruthy();
    expect(view.container.textContent).not.toContain('ghost:');
  });

  it('groups plain comments and expands the group', async () => {
    serve({
      comments: [
        issueComment(1, 'ann', 'First note'),
        issueComment(2, 'bob', 'Second note'),
        issueComment(3, 'ann', 'Third note'),
      ],
    });
    const view = await show({ pullRequest: pull({ createdAt: at(0) }) });
    const toggle = await view.findByText('3 comments · 2 authors');
    expect(view.container.textContent).not.toContain('First note');
    expect(rows(view.container)).toHaveLength(2);
    await click(toggle.closest('button') as HTMLElement);
    expect(view.getByText('First note')).toBeTruthy();
    expect(view.getByText('Third note')).toBeTruthy();
    expect(toggle.closest('button')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('choosing a commit opens Code on it', async () => {
    serve({ commits: [commit('abcdef1234', 'Add cards', 5)] });
    const onOpenCommit = vi.fn();
    const view = await show({ onOpenCommit });
    await click(await view.findByRole('button', { name: 'View commit abcdef1' }));
    expect(onOpenCommit).toHaveBeenCalledWith('abcdef1234');
  });

  it('No activity yet.', async () => {
    empty.on = true;
    const view = await show();
    expect(await view.findByText('No activity yet.')).toBeTruthy();
    expect(view.container.querySelector('.mrpr-timeline')).toBeNull();
  });

  it('names each list GitHub cut short, the commits by the count of the pull request', async () => {
    let next = 0;
    serve({
      commits: [commit('abcdef1234', 'Add cards', 5), commit('bcdef12345', 'Fix cards', 6)],
      // Every page is full, so the list stops at ten pages.
      comments: () =>
        Array.from({ length: 100 }, () => issueComment((next += 1), 'ann', `C${next}`)),
    });
    const view = await show({ pullRequest: pull({ commitCount: 300 }) });
    const commits = await view.findByRole('link', {
      name: 'Showing the first 2 commits; see the rest on GitHub',
    });
    expect(commits.getAttribute('href')).toBe(`${PR_URL}/commits`);
    const comments = await view.findByRole('link', {
      name: 'Showing the first 1000 comments; see the rest on GitHub',
    });
    expect(comments.getAttribute('href')).toBe(PR_URL);
    expect(view.queryByText(/Showing the first \d+;/)).toBeNull();
  });

  it('says nothing is cut when every commit came', async () => {
    serve({ commits: [commit('abcdef1234', 'Add cards', 5)] });
    const view = await show({ pullRequest: pull({ commitCount: 1 }) });
    await view.findByText('Add cards');
    expect(view.queryByText(/Showing the first/)).toBeNull();
  });

  it('a failing query shows its error with Retry while the others still show', async () => {
    serve({
      commits: respond({ message: 'boom' }, 500),
      comments: [issueComment(1, 'ann', 'Hello')],
    });
    const view = await show();
    expect(await view.findByText('GitHub answered with status 500.')).toBeTruthy();
    expect(view.getByText('1 comment · 1 author')).toBeTruthy();
    const before = fetchMock.mock.calls.length;
    await click(view.getByRole('button', { name: 'Try again' }));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });
});
