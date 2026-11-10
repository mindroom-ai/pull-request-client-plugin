// @vitest-environment jsdom
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from '../index';
import { CommentBody } from './CommentBody';

const markdown = vi.hoisted(() => ({ html: undefined as string | undefined }));
vi.mock('@mindroom/client-sdk/ui', async (importOriginal) => {
  const ui = await importOriginal<typeof import('@mindroom/client-sdk/ui')>();
  return { ...ui, useMarkdownHtml: () => markdown.html };
});

const render = (ui: React.ReactElement) =>
  renderPluginComponent(ui, { id: 'pull-requests', plugin });

const heights = (height: number) =>
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(height);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.restoreAllMocks();
  markdown.html = undefined;
  // jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
});

describe('CommentBody', () => {
  it('shows the plain text until the renderer has loaded, then its HTML', async () => {
    const view = await render(<CommentBody body="Looks **good**" />);
    expect(view.container.textContent).toBe('Looks **good**');
    markdown.html = '<p>Looks <strong>good</strong></p>';
    view.rerender(<CommentBody body="Looks **good**" />);
    expect(view.container.querySelector('strong')?.textContent).toBe('good');
  });

  it('renders nothing for a body of only HTML comments and whitespace', async () => {
    const view = await render(<CommentBody body={'<!-- MURMUR_IGNORE -->\n  '} />);
    expect(view.container.textContent).toBe('');
    expect(view.container.querySelector('.mrpr-comment-body')).toBeNull();
  });

  it('keeps a body that says more than its HTML comment', async () => {
    const view = await render(<CommentBody body={'<!-- bot -->\nNeeds a test.'} />);
    expect(view.container.textContent).toContain('Needs a test.');
  });

  it('shows a short body whole, with no button', async () => {
    heights(100);
    const view = await render(<CommentBody body="Short" />);
    expect(view.queryByText('Show full comment')).toBeNull();
  });

  it('clamps a tall body at 240 px until Show full comment expands it', async () => {
    heights(500);
    const view = await render(<CommentBody body="Tall" />);
    const clip = view.container.querySelector('.mrpr-comment-clip') as HTMLElement;
    expect(clip.className).toContain('mrpr-comment-clamped');
    const button = view.getByText('Show full comment');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await act(async () => button.click());
    expect(clip.className).not.toContain('mrpr-comment-clamped');
    expect(view.getByText('Show less').getAttribute('aria-expanded')).toBe('true');
    await act(async () => view.getByText('Show less').click());
    expect(clip.className).toContain('mrpr-comment-clamped');
  });
});
