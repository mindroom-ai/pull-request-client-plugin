// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequest, PullRequestRef } from '../github';
import { forgetSigned, imageSources } from '../images';
import plugin from '../index';
import { usePullRequest } from '../queries';
import { trapOptions } from '../testing/focusTrapStandIn';
import { SummaryTab } from './SummaryTab';

vi.mock('focus-trap-react', async () => ({
  default: (await import('../testing/focusTrapStandIn')).FocusTrapStandIn,
}));

// The app's Markdown renderer loads on demand and cannot load here; this one renders bold text,
// and an image where `imageSource` gives it an address, as the app's sanitizer keeps it.
vi.mock('@mindroom/client-sdk/ui', async (importOriginal) => {
  const ui = await importOriginal<typeof import('@mindroom/client-sdk/ui')>();
  return {
    ...ui,
    useMarkdownHtml: (
      markdown: string,
      options?: { imageSource?: (src: string) => string | undefined }
    ) =>
      markdown
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt: string, src: string) => {
          const mapped = options?.imageSource?.(src);
          return mapped ? `<img alt="${alt}" src="${mapped}">` : '';
        }),
  };
});

const REF: PullRequestRef = { owner: 'mindroom-ai', repo: 'mindroom-chat', number: 200 };
const HEAD = 'headsha';
const PR_URL = 'https://github.com/mindroom-ai/mindroom-chat/pull/200';
const UUID = '11111111-2222-3333-4444-555555555555';
const ATTACHMENT = `https://github.com/user-attachments/assets/${UUID}`;
// A signed address whose `jwt` is valid until 2100, as GitHub mints them, new for each answer.
const signed = (key: string) => {
  const payload = btoa(JSON.stringify({ exp: 4_102_444_800, key }))
    .replace(/=+$/u, '')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_');
  return `https://private-user-images.githubusercontent.com/1/2-${UUID}.png?jwt=e30.${payload}.sig&v=1`;
};
const SIGNED = signed('first');
const CAMO = 'https://camo.githubusercontent.com/abc/def';
// The signed address as GitHub's HTML writes it, with its `&` escaped.
const SIGNED_HTML = SIGNED.replace('&', '&amp;');

const pull = (over: Partial<PullRequest> = {}): PullRequest => ({
  title: 'Add pull request cards',
  state: 'open',
  draft: false,
  body: 'Shows a **bold** claim.',
  images: { byUrl: {}, byAttachment: {} },
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
  pull?: unknown;
  reviews?: unknown[] | Response;
  comments?: unknown[] | Response;
  reviewComments?: unknown[] | Response;
  checks?: unknown[];
  checksTotal?: number;
};

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const serve = (parts: Parts = {}) =>
  fetchMock.mockImplementation(async (url) => {
    const answer = (part: unknown[] | Response | undefined) =>
      part instanceof Response ? part : respond(part ?? []);
    if (url.includes('/check-runs')) {
      return respond({ check_runs: parts.checks ?? [], total_count: parts.checksTotal });
    }
    if (url.includes('/status?')) return respond({ statuses: [] });
    if (url.endsWith('/pulls/200')) return respond(parts.pull ?? {});
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

// The tab as the panel shows it, with the pull request out of its query.
function FetchedSummary() {
  const query = usePullRequest(REF);
  return query.data ? <SummaryTab pullRequest={query.data} pullRequestRef={REF} /> : null;
}

const calls = (path: string) => fetchMock.mock.calls.filter(([url]) => url.endsWith(path)).length;
const fail = (image: Element) => act(async () => void image.dispatchEvent(new Event('error')));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  // The signed addresses images.ts handed out stay for the module; each test starts without them.
  forgetSigned(SIGNED);
  forgetSigned(SIGNED.replace(UUID, '99999999-2222-3333-4444-555555555555'));
  fetchMock.mockReset();
  serve();
  vi.stubGlobal('fetch', fetchMock);
  // jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
  // A held back refetch waits on a timer; it must not outlive its test.
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
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

  it("shows the description's attachment from the address GitHub's HTML signed", async () => {
    const view = await show(
      pull({
        body: `## Screenshots\n\n![Before](${ATTACHMENT}) ![Badge](https://img.example/b.svg) ![Gone](https://img.example/x.png)`,
        images: imageSources(
          `<p><img src="${SIGNED_HTML}" alt="Before"> <img src="${CAMO}" data-canonical-src="https://img.example/b.svg"></p>`
        ),
      })
    );
    const images = [...view.container.querySelectorAll('.mrpr-description img')];
    expect(images.map((image) => [image.getAttribute('alt'), image.getAttribute('src')])).toEqual([
      ['Before', SIGNED],
      ['Badge', CAMO],
    ]);
  });

  it("shows a comment's attachment from its body_html", async () => {
    serve({
      comments: [
        issueComment(1, 'ann', `See ![shot](${ATTACHMENT})`, {
          body_html: `<p>See <img src="${SIGNED_HTML}" alt="shot"></p>`,
        }),
      ],
    });
    const view = await show();
    expect((await view.findByAltText('shot')).getAttribute('src')).toBe(SIGNED);
  });

  it('fetches the pull request again, once a minute at most, when a signed image fails', async () => {
    const answer = {
      title: 'Shots',
      state: 'open',
      body: `![Before](${ATTACHMENT})`,
      body_html: `<p><img src="${SIGNED_HTML}" alt="Before"></p>`,
      head: { sha: HEAD },
    };
    serve({ pull: answer });
    const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    const view = await renderPluginComponent(
      <QueryClientProvider client={client}>
        <FetchedSummary />
      </QueryClientProvider>,
      { id: 'pull-requests', plugin }
    );
    // GitHub signs the attachment anew; the failed address, valid by the clock, is not kept.
    const second = signed('second');
    answer.body_html = `<p><img src="${second.replace('&', '&amp;')}" alt="Before"></p>`;
    await fail(await view.findByAltText('Before'));
    await vi.waitFor(() => expect(calls('/pulls/200')).toBe(2));
    await vi.waitFor(async () =>
      expect((await view.findByAltText('Before')).getAttribute('src')).toBe(second)
    );
    await fail(await view.findByAltText('Before'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(calls('/pulls/200')).toBe(2);
    const now = Date.now();
    const later = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await fail(await view.findByAltText('Before'));
    await vi.waitFor(() => expect(calls('/pulls/200')).toBe(3));
    later.mockRestore();
  });

  it("two signed images that fail at once both get the next answer's addresses", async () => {
    const U2 = '99999999-2222-3333-4444-555555555555';
    const signed2 = (key: string) => signed(key).replace(UUID, U2);
    const answer = {
      title: 'Shots',
      state: 'open',
      body: `![A](${ATTACHMENT}) ![B](https://github.com/user-attachments/assets/${U2})`,
      body_html: `<p><img src="${SIGNED_HTML}" alt="A"> <img src="${signed2('first').replace(
        '&',
        '&amp;'
      )}" alt="B"></p>`,
      head: { sha: HEAD },
    };
    serve({ pull: answer });
    const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    const view = await renderPluginComponent(
      <QueryClientProvider client={client}>
        <FetchedSummary />
      </QueryClientProvider>,
      { id: 'pull-requests', plugin }
    );
    const a2 = signed('second');
    const b2 = signed2('second');
    answer.body_html = `<p><img src="${a2.replace('&', '&amp;')}" alt="A"> <img src="${b2.replace(
      '&',
      '&amp;'
    )}" alt="B"></p>`;
    const a = await view.findByAltText('A');
    const b = await view.findByAltText('B');
    await act(async () => {
      a.dispatchEvent(new Event('error'));
      b.dispatchEvent(new Event('error'));
    });
    await vi.waitFor(() => expect(calls('/pulls/200')).toBe(2));
    await vi.waitFor(async () =>
      expect((await view.findByAltText('A')).getAttribute('src')).toBe(a2)
    );
    expect((await view.findByAltText('B')).getAttribute('src')).toBe(b2);
  });

  it('a failure within the minute after a refetch fetches again when the minute ends', async () => {
    const U2 = '99999999-2222-3333-4444-555555555555';
    const signed2 = (key: string) => signed(key).replace(UUID, U2);
    const html = (a: string, b: string) =>
      `<p><img src="${a.replace('&', '&amp;')}" alt="A"> <img src="${b.replace(
        '&',
        '&amp;'
      )}" alt="B"></p>`;
    const answer = {
      title: 'Shots',
      state: 'open',
      body: `![A](${ATTACHMENT}) ![B](https://github.com/user-attachments/assets/${U2})`,
      body_html: html(SIGNED, signed2('first')),
      head: { sha: HEAD },
    };
    serve({ pull: answer });
    const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    const view = await renderPluginComponent(
      <QueryClientProvider client={client}>
        <FetchedSummary />
      </QueryClientProvider>,
      { id: 'pull-requests', plugin }
    );
    const src = async (alt: string) => (await view.findByAltText(alt)).getAttribute('src');
    answer.body_html = html(signed('second'), signed2('second'));
    await fail(await view.findByAltText('A'));
    await vi.waitFor(async () => expect(await src('A')).toBe(signed('second')));
    expect(calls('/pulls/200')).toBe(2);
    // B had not failed, so it keeps its address; it fails 10 s later, inside the minute.
    expect(await src('B')).toBe(signed2('first'));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    answer.body_html = html(signed('third'), signed2('third'));
    await fail(await view.findByAltText('B'));
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(calls('/pulls/200')).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(50_000));
    await vi.waitFor(async () => expect(await src('B')).toBe(signed2('third')));
    expect(calls('/pulls/200')).toBe(3);
  });

  it('an image failing while the panel fetches the pull request joins that fetch', async () => {
    serve({
      pull: {
        title: 'Shots',
        state: 'open',
        body: `![Before](${ATTACHMENT})`,
        body_html: `<p><img src="${SIGNED_HTML}" alt="Before"></p>`,
        head: { sha: HEAD },
      },
    });
    const served = fetchMock.getMockImplementation()!;
    let aborted = 0;
    fetchMock.mockImplementation(async (url, init) => {
      // After the first answer, GitHub takes longer than S3 takes to refuse an expired image.
      if (url.endsWith('/pulls/200') && calls('/pulls/200') > 1) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 150);
          init?.signal?.addEventListener('abort', () => {
            aborted += 1;
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      return served(url, init);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    const ui = (
      <QueryClientProvider client={client}>
        <FetchedSummary />
      </QueryClientProvider>
    );
    const first = await renderPluginComponent(ui, { id: 'pull-requests', plugin });
    await first.findByAltText('Before');
    first.unmount();
    // Reopened ten minutes later on the cached answer: stale, and its signed image has expired.
    const query = client.getQueryCache().find({ queryKey: ['pull-requests'], exact: false })!;
    query.setState({ dataUpdatedAt: Date.now() - 600_000 });
    const view = await renderPluginComponent(ui, { id: 'pull-requests', plugin });
    expect(calls('/pulls/200')).toBe(2);
    await fail(await view.findByAltText('Before'));
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect({ fetches: calls('/pulls/200'), aborted }).toEqual({ fetches: 2, aborted: 0 });
  });

  it("fetches a comment's list again when its signed image fails, not for another image", async () => {
    serve({
      comments: [
        issueComment(1, 'ann', `![shot](${ATTACHMENT}) ![badge](https://img.example/b.svg)`, {
          body_html: `<p><img src="${SIGNED_HTML}" alt="shot"> <img src="${CAMO}" data-canonical-src="https://img.example/b.svg"></p>`,
        }),
      ],
    });
    const view = await show();
    await fail(await view.findByAltText('badge'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(calls('/issues/200/comments?per_page=100&page=1')).toBe(1);
    await fail(await view.findByAltText('shot'));
    await vi.waitFor(() => expect(calls('/issues/200/comments?per_page=100&page=1')).toBe(2));
    await fail(await view.findByAltText('shot'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(calls('/issues/200/comments?per_page=100&page=1')).toBe(2);
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

  it('says so when GitHub has more check runs than it sent', async () => {
    serve({
      checks: [{ name: 'lint', status: 'completed', conclusion: 'success' }],
      checksTotal: 101,
    });
    const view = await show();
    await click(view.getByRole('button', { name: 'Checks' }));
    const note = await view.findByRole('link', {
      name: 'Showing the first 1; see the rest on GitHub',
    });
    expect(note.getAttribute('href')).toBe(`${PR_URL}/checks`);
    expect(view.getByText('lint')).toBeTruthy();
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
      expect(filter.getAttribute('aria-haspopup')).toBe('menu');
      await click(filter);
      expect(view.getByRole('menu', { name: 'Filter comments' })).toBeTruthy();
      const showBots = view.getByRole('menuitemcheckbox', { name: 'Show bots' });
      expect(showBots.getAttribute('aria-checked')).toBe('false');
      await click(showBots);
      expect(showBots.getAttribute('aria-checked')).toBe('true');
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

    it('Escape closes the filter menu and gives the focus back to its button', async () => {
      const view = await show();
      const filter = await view.findByRole('button', { name: 'Filter comments' });
      await click(filter);
      act(() => view.getByRole('menuitemcheckbox', { name: 'Show bots' }).focus());
      await act(async () => {
        trapOptions().escapeDeactivates?.();
      });
      expect(view.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(filter);
    });

    it("shows a bot's thread with a human reply while bots are hidden", async () => {
      const bot = user('robo[bot]', 'Bot');
      serve({
        reviewComments: [
          reviewComment(1, { user: bot, body: 'Bot finding' }),
          reviewComment(2, { in_reply_to_id: 1, body: 'Human reply' }),
          reviewComment(3, { user: bot, body: 'Bot alone' }),
        ],
      });
      const view = await show();
      expect(await view.findByText('Bot finding')).toBeTruthy();
      expect(view.getByText('Human reply')).toBeTruthy();
      expect(view.queryByText('Bot alone')).toBeNull();
      expect(view.getByRole('button', { name: 'Filter comments' }).textContent).toContain(
        '1 hidden'
      );
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
      await click(first.getByRole('menuitemcheckbox', { name: 'Show bots' }));
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
        if (url.includes('/status?')) return respond({ statuses: [] });
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
