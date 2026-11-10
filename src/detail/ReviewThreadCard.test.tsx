// @vitest-environment jsdom
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewComment } from '../github';
import plugin from '../index';
import type { ReviewThread } from '../reviewThreads';
import { ReviewThreadCard } from './ReviewThreadCard';

// The app's Markdown renderer loads on demand and cannot load here; this one renders bold text.
vi.mock('@mindroom/client-sdk/ui', async (importOriginal) => {
  const ui = await importOriginal<typeof import('@mindroom/client-sdk/ui')>();
  return {
    ...ui,
    useMarkdownHtml: (markdown: string) =>
      markdown.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'),
  };
});

const comment = (id: number, login: string, over: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  author: {
    login,
    name: null,
    avatarUrl: null,
    url: `https://github.com/${login}`,
    isBot: false,
  },
  body: `Comment ${id}`,
  createdAt: new Date(Date.now() - id * 3_600_000).toISOString(),
  url: `https://github.com/mindroom-ai/mindroom-chat/pull/200#discussion_r${id}`,
  reactions: [],
  path: 'src/app.ts',
  line: 11,
  originalLine: 11,
  side: 'RIGHT',
  inReplyToId: null,
  reviewId: null,
  outdated: false,
  commitId: 'head',
  ...over,
});

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: 1,
  path: 'src/app.ts',
  line: 11,
  side: 'RIGHT',
  outdated: false,
  comments: [
    comment(1, 'ann', {
      body: 'Needs a **test**.',
      reactions: [{ content: '+1', count: 2 }],
    }),
    comment(2, 'bob', { body: 'Added one.', inReplyToId: 1 }),
  ],
  ...over,
});

const show = (value: ReviewThread) =>
  renderPluginComponent(<ReviewThreadCard thread={value} />, { id: 'pull-requests', plugin });

const click = (element: HTMLElement) => act(async () => element.click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('ReviewThreadCard', () => {
  it('the thread card shows comments and Outdated', async () => {
    const view = await show(thread({ outdated: true }));
    expect(view.getByRole('button', { name: '2 comments' })).toBeTruthy();
    expect(view.getByText('Outdated')).toBeTruthy();
    const [first, second] = view.getAllByRole('article');
    expect(first?.textContent).toContain('ann');
    expect(second?.textContent).toContain('bob');
    expect(view.getByText('test').tagName).toBe('STRONG');
    expect(view.getByText('Added one.')).toBeTruthy();
    expect(view.getByRole('img', { name: 'thumbs up, 2' })).toBeTruthy();
    // The time links to the comment on GitHub; the login to its author.
    const time = first?.querySelector('time');
    expect(time?.textContent).toBe('1 hour ago');
    expect(time?.closest('a')?.getAttribute('href')).toBe(
      'https://github.com/mindroom-ai/mindroom-chat/pull/200#discussion_r1'
    );
    expect(view.getByRole('link', { name: "Open ann's profile" }).getAttribute('href')).toBe(
      'https://github.com/ann'
    );
  });

  it('says nothing of Outdated for a current thread, and one comment in the singular', async () => {
    const view = await show(thread({ comments: [comment(1, 'ann')] }));
    expect(view.getByRole('button', { name: '1 comment' })).toBeTruthy();
    expect(view.queryByText('Outdated')).toBeNull();
  });

  it('opens expanded and folds to its heading', async () => {
    const view = await show(thread());
    const toggle = view.getByRole('button', { name: '2 comments' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryAllByRole('article')).toHaveLength(0);
    await click(toggle);
    expect(view.getAllByRole('article')).toHaveLength(2);
  });

  it('offers nothing that writes', async () => {
    const view = await show(thread());
    expect(view.getAllByRole('button').map((button) => button.textContent)).toEqual(['2 comments']);
    expect(view.container.querySelector('textarea, input')).toBeNull();
  });
});
