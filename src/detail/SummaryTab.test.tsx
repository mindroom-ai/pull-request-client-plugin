// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequest, PullRequestRef } from '../github';
import plugin from '../index';
import { SummaryTab } from './SummaryTab';

vi.mock('focus-trap-react', () => ({
  default: ({ children }: { children: ReactNode }) => children,
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

type Parts = {
  reviews?: unknown[] | Response;
  comments?: unknown[] | Response;
  reviewComments?: unknown[] | Response;
  checks?: unknown[];
};

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const serve = (parts: Parts = {}) =>
  fetchMock.mockImplementation(async (url) => {
    const answer = (part: unknown[] | Response | undefined) =>
      part instanceof Response ? part : respond(part ?? []);
    if (url.includes('/check-runs')) return respond({ check_runs: parts.checks ?? [] });
    if (url.endsWith('/status')) return respond({ statuses: [] });
    if (url.includes('/pulls/200/reviews')) return answer(parts.reviews);
    if (url.includes('/pulls/200/comments')) return answer(parts.reviewComments);
    if (url.includes('/issues/200/comments')) return answer(parts.comments);
    throw new Error(`unexpected request ${url}`);
  });

const show = async (pullRequest: PullRequest = pull()) => {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return renderPluginComponent(
    <QueryClientProvider client={client}>
      <SummaryTab pullRequest={pullRequest} pullRequestRef={REF} />
    </QueryClientProvider>,
    { id: 'pull-requests', plugin }
  );
};

const click = (element: HTMLElement) => act(async () => element.click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  fetchMock.mockReset();
  serve();
  vi.stubGlobal('fetch', fetchMock);
  // jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SummaryTab', () => {
  it('reviewers show their latest verdicts and stale approvals faded', async () => {
    serve({
      reviews: [
        review(1, 'ann', 'APPROVED'),
        review(2, 'bob', 'APPROVED', { commit_id: 'old' }),
        review(3, 'cy', 'CHANGES_REQUESTED'),
        review(4, 'dee', 'COMMENTED'),
      ],
    });
    const view = await show();
    expect(await view.findByText('Approved earlier changes')).toBeTruthy();
    const rings = [...view.container.querySelectorAll('[class*="mrpr-ring-"]')].map(
      (ring) => ring.className
    );
    expect(rings).toHaveLength(3);
    expect(rings.filter((name) => name.includes('mrpr-ring-approved'))).toHaveLength(2);
    expect(rings.filter((name) => name.includes('mrpr-ring-stale'))).toHaveLength(1);
    expect(rings.filter((name) => name.includes('mrpr-ring-changes-requested'))).toHaveLength(1);
    expect(view.getByText('Approved')).toBeTruthy();
    expect(view.getByText('Changes requested')).toBeTruthy();
    // The corner badge is positioned on the avatar's wrapper.
    expect(view.container.querySelector('.mrpr-reviewer .mrpr-outcome-badge')).toBeTruthy();
  });

  it('names a reviewer without an author as ghost, not by the review key', async () => {
    serve({ reviews: [review(5, null, 'APPROVED')] });
    const view = await show();
    expect(await view.findByText('ghost')).toBeTruthy();
    expect(view.container.textContent).not.toContain('ghost:');
  });

  it('keeps bot verdicts in the reviewers row while bots are hidden', async () => {
    serve({ reviews: [review(1, 'robo[bot]', 'APPROVED')] });
    const view = await show();
    expect(await view.findByText('robo[bot]')).toBeTruthy();
    expect(view.container.querySelector('.mrpr-ring-approved')).toBeTruthy();
  });

  it('requested reviewers and teams without a review show plain', async () => {
    serve({ reviews: [review(1, 'ann', 'APPROVED')] });
    const view = await show(
      pull({
        requestedReviewers: [
          { login: 'eve', name: null, avatarUrl: null, url: null, isBot: false },
          { login: 'ann', name: null, avatarUrl: null, url: null, isBot: false },
        ],
        requestedTeams: ['core-team'],
      })
    );
    expect(await view.findByText('Approved')).toBeTruthy();
    expect(view.getByText('eve')).toBeTruthy();
    expect(view.getByText('core-team')).toBeTruthy();
    // Only ann has a verdict, and she shows once.
    expect(view.container.querySelectorAll('[class*="mrpr-ring-"]')).toHaveLength(1);
    expect(view.getAllByText('ann')).toHaveLength(1);
  });

  it('shows the labels', async () => {
    const view = await show(
      pull({
        labels: [
          { name: 'bug', color: 'd73a4a' },
          { name: 'docs', color: '0075ca' },
        ],
      })
    );
    expect(await view.findByText('bug')).toBeTruthy();
    expect(view.getByText('docs')).toBeTruthy();
    expect(
      (view.getByText('bug').closest('.mrpr-label') as HTMLElement).style.getPropertyValue(
        '--label'
      )
    ).toBe('#d73a4a');
  });

  it('description collapses', async () => {
    const view = await show();
    expect(view.getByText('bold').tagName).toBe('STRONG');
    const heading = view.getByRole('button', { name: 'Description' });
    expect(heading.getAttribute('aria-expanded')).toBe('true');
    await click(heading);
    expect(heading.getAttribute('aria-expanded')).toBe('false');
    expect((view.getByText('bold').closest('[hidden]') as HTMLElement | null)?.hidden).toBe(true);
    await click(heading);
    expect(view.getByText('bold').closest('[hidden]')).toBeNull();
  });

  it('says so when there is no description', async () => {
    const view = await show(pull({ body: '' }));
    expect(view.getByText('No description.')).toBeTruthy();
  });

  it('checks section lists checks collapsed by default', async () => {
    serve({
      checks: [
        {
          name: 'lint',
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.com/runs/1',
          completed_at: '2026-11-02T00:00:00Z',
        },
        {
          name: 'test',
          status: 'completed',
          conclusion: 'success',
          completed_at: '2026-11-02T00:00:00Z',
        },
      ],
    });
    const view = await show();
    const heading = view.getByRole('button', { name: 'Checks' });
    expect(heading.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByText('lint')).toBeNull();
    await click(heading);
    expect(await view.findByText('lint')).toBeTruthy();
    expect(view.getByText('test')).toBeTruthy();
    expect(view.getByText('Failed')).toBeTruthy();
    expect(view.getByText('Passed')).toBeTruthy();
    expect(view.getByRole('link', { name: 'Details' }).getAttribute('href')).toBe(
      'https://github.com/runs/1'
    );
  });

  describe('comments', () => {
    const texts = (view: Awaited<ReturnType<typeof show>>) =>
      [...view.container.querySelectorAll('.mrpr-comment-card')].map(
        (card) => card.querySelector('.mrpr-markdown')?.textContent
      );
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        issueComment(index + 1, 'ann', `Comment ${index + 1}`, {
          created_at: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
        })
      );

    it('comments in order with paging', async () => {
      serve({ comments: many(25) });
      const view = await show(pull({ commentCount: 25 }));
      expect(await view.findByRole('button', { name: 'Comments (25)' })).toBeTruthy();
      await view.findByText('Comment 25');
      expect(texts(view)).toHaveLength(10);
      expect(texts(view)[0]).toBe('Comment 25');
      expect(texts(view)[9]).toBe('Comment 16');
      await click(view.getByRole('button', { name: 'Show 10 older conversations' }));
      expect(texts(view)).toHaveLength(20);
      await click(view.getByRole('button', { name: 'Show 5 older conversations' }));
      expect(texts(view)).toHaveLength(25);
      expect(texts(view)[24]).toBe('Comment 1');
      expect(view.queryByRole('button', { name: /older conversations/ })).toBeNull();
      await click(view.getByRole('button', { name: 'Newest first' }));
      expect(view.getByRole('button', { name: 'Oldest first' })).toBeTruthy();
      expect(texts(view)[0]).toBe('Comment 1');
      expect(texts(view)[24]).toBe('Comment 25');
    });

    it('hides bot comments until Show bots', async () => {
      serve({
        comments: [
          issueComment(1, 'ann', 'Human remark'),
          { ...issueComment(2, 'robo[bot]', 'Bot remark'), user: user('robo[bot]', 'Bot') },
        ],
      });
      const view = await show();
      expect(await view.findByText('Human remark')).toBeTruthy();
      expect(view.queryByText('Bot remark')).toBeNull();
      const filter = view.getByRole('button', { name: 'Filter comments' });
      expect(filter.textContent).toContain('1 hidden');
      await click(filter);
      await click(view.getByRole('checkbox', { name: 'Show bots' }));
      expect(view.getByText('Bot remark')).toBeTruthy();
      expect(view.getByRole('button', { name: 'Filter comments' }).textContent).not.toContain(
        'hidden'
      );
      expect(
        Object.entries(localStorage).some(
          ([key, value]) => key.endsWith('summary:showBots') && value === 'true'
        )
      ).toBe(true);
    });

    it('starts with the bots shown when the stored choice says so', async () => {
      serve({
        comments: [
          { ...issueComment(2, 'robo[bot]', 'Bot remark'), user: user('robo[bot]', 'Bot') },
        ],
      });
      const first = await show();
      await first.findByRole('button', { name: 'Filter comments' });
      await click(first.getByRole('button', { name: 'Filter comments' }));
      await click(first.getByRole('checkbox', { name: 'Show bots' }));
      first.unmount();
      const view = await show();
      expect(await view.findByText('Bot remark')).toBeTruthy();
    });

    it('a thread card shows path, line and Outdated', async () => {
      serve({
        reviewComments: [
          reviewComment(1, { position: null }),
          reviewComment(2, { in_reply_to_id: 1, body: 'A reply', user: user('bob') }),
          reviewComment(3, {
            path: 'src/b.ts',
            line: 7,
            body: 'Fresh',
            created_at: '2026-11-05T00:00:00Z',
          }),
        ],
        reviews: [review(1, 'ann', 'COMMENTED', { body: 'Overall remark' })],
      });
      const view = await show();
      expect(await view.findByText('src/a.ts:12')).toBeTruthy();
      expect(view.getByText('Outdated')).toBeTruthy();
      expect(view.getByText('src/b.ts:7')).toBeTruthy();
      expect(view.getAllByText('Outdated')).toHaveLength(1);
      expect(view.getByText('A reply').closest('.mrpr-replies')).toBeTruthy();
      expect(view.getByText('Overall remark')).toBeTruthy();
      expect(view.queryByText(/Resolved/)).toBeNull();
    });

    it('shows a review with a body with its verdict badge', async () => {
      serve({ reviews: [review(1, 'ann', 'CHANGES_REQUESTED', { body: 'Please fix' })] });
      const view = await show();
      const body = await view.findByText('Please fix');
      expect(body.closest('.mrpr-comment-card')?.textContent).toContain('Changes requested');
    });

    it('links the time to the comment, with the date as its tooltip', async () => {
      serve({ comments: [issueComment(1, 'ann', 'Hi')] });
      const view = await show();
      await view.findByText('Hi');
      const time = view.container.querySelector('.mrpr-comment-card time') as HTMLElement;
      expect(time.closest('a')?.getAttribute('href')).toBe('https://github.com/c/1');
      expect(time.title).not.toBe('');
    });

    it('shows reactions on a comment', async () => {
      serve({ comments: [issueComment(1, 'ann', 'Hi', { reactions: { heart: 2 } })] });
      const view = await show();
      expect(await view.findByRole('img', { name: 'heart, 2' })).toBeTruthy();
    });

    it('says so when there are no comments', async () => {
      const view = await show();
      expect(await view.findByText('No comments yet.')).toBeTruthy();
    });

    it('truncated lists say so with a GitHub link', async () => {
      let next = 0;
      fetchMock.mockImplementation(async (url) => {
        if (url.includes('/issues/200/comments')) {
          return respond(
            Array.from({ length: 100 }, () => issueComment((next += 1), 'ann', `C${next}`))
          );
        }
        if (url.includes('/check-runs')) return respond({ check_runs: [] });
        if (url.endsWith('/status')) return respond({ statuses: [] });
        return respond([]);
      });
      const view = await show();
      const note = await view.findByRole('link', {
        name: 'Showing the first 1000; see the rest on GitHub',
      });
      expect(note.getAttribute('href')).toBe(PR_URL);
    });
  });

  it('a failing reviews query shows its error state and the comments still render', async () => {
    serve({
      reviews: respond({}, 404),
      comments: [issueComment(1, 'ann', 'Still here')],
    });
    const view = await show(
      pull({
        requestedReviewers: [
          { login: 'eve', name: null, avatarUrl: null, url: null, isBot: false },
        ],
      })
    );
    expect(await view.findByText(/GitHub did not find this pull request/)).toBeTruthy();
    expect(view.getByText('Still here')).toBeTruthy();
    expect(view.getByText('eve')).toBeTruthy();
  });

  it('retries a failed reviews query from its own state', async () => {
    serve({ reviews: respond({}, 500) });
    const view = await show();
    await view.findByText('GitHub answered with status 500.');
    serve({ reviews: [review(1, 'ann', 'APPROVED')] });
    await click(view.getByRole('button', { name: 'Try again' }));
    expect(await view.findByText('Approved')).toBeTruthy();
    expect(view.queryByText('GitHub answered with status 500.')).toBeNull();
  });

  it('a failing comments query shows its error state beside the loaded threads', async () => {
    serve({
      comments: respond({}, 404),
      reviewComments: [reviewComment(1)],
    });
    const view = await show();
    expect(await view.findByText(/GitHub did not find this pull request/)).toBeTruthy();
    expect(view.getByText('Thread 1')).toBeTruthy();
  });
});
