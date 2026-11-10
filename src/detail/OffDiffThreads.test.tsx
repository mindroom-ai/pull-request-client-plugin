// @vitest-environment jsdom
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewComment } from '../github';
import plugin from '../index';
import type { ReviewThread } from '../reviewThreads';
import { OffDiffThreads } from './OffDiffThreads';

vi.mock('@mindroom/client-sdk/ui', async (importOriginal) => {
  const ui = await importOriginal<typeof import('@mindroom/client-sdk/ui')>();
  return { ...ui, useMarkdownHtml: (markdown: string) => markdown };
});

const comment = (id: number, path: string): ReviewComment => ({
  id,
  author: null,
  body: `Comment ${id}`,
  createdAt: '2026-11-01T00:00:00Z',
  url: '',
  reactions: [],
  path,
  line: id,
  originalLine: id,
  side: 'RIGHT',
  inReplyToId: null,
  reviewId: null,
  outdated: false,
  commitId: 'head',
});

const thread = (id: number, path: string, line: number | null = id): ReviewThread => ({
  id,
  path,
  line,
  side: 'RIGHT',
  outdated: false,
  comments: [comment(id, path)],
});

const show = (threads: ReviewThread[]) =>
  renderPluginComponent(<OffDiffThreads threads={threads} />, { id: 'pull-requests', plugin });

const click = (element: HTMLElement) => act(async () => element.click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('OffDiffThreads', () => {
  it('the bar groups by path and collapses', async () => {
    const view = await show([
      thread(1, 'src/a.ts'),
      thread(2, 'README.md', null),
      thread(3, 'src/a.ts'),
    ]);
    const toggle = view.getByRole('button', { name: 'Conversations not on the current diff (3)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByText('Comment 1')).toBeNull();

    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const groups = view.getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'src/a.ts',
      'README.md',
    ]);
    expect(groups[0]?.textContent).toContain('Line 1');
    expect(groups[0]?.textContent).toContain('Comment 1');
    expect(groups[0]?.textContent).toContain('Line 3');
    expect(groups[0]?.textContent).toContain('Comment 3');
    // A thread without a line shows no line.
    expect(groups[1]?.textContent).not.toContain('Line');
    expect(groups[1]?.textContent).toContain('Comment 2');

    await click(toggle);
    expect(view.queryAllByRole('group')).toHaveLength(0);
  });

  it('shows nothing without such threads', async () => {
    const view = await show([]);
    expect(view.container.textContent).toBe('');
  });
});
