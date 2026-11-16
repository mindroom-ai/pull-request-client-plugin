// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from '../index';
import { CommentBody } from './CommentBody';

const NO_IMAGES = { byUrl: {}, byAttachment: {} };

type ImageSource = (src: string) => string | undefined;
const markdown = vi.hoisted(() => ({
  html: undefined as string | undefined,
  imageSources: [] as (ImageSource | undefined)[],
}));
vi.mock('@mindroom/client-sdk/ui', async (importOriginal) => {
  const ui = await importOriginal<typeof import('@mindroom/client-sdk/ui')>();
  return {
    ...ui,
    useMarkdownHtml: (_markdown: string, options?: { imageSource?: ImageSource }) => {
      markdown.imageSources.push(options?.imageSource);
      return markdown.html;
    },
  };
});

// The body asks the app's query client for the query to fetch again when a signed image fails.
const render = async (ui: React.ReactElement) => {
  const client = new QueryClient();
  const inClient = (body: React.ReactElement) => (
    <QueryClientProvider client={client}>{body}</QueryClientProvider>
  );
  const view = await renderPluginComponent(inClient(ui), { id: 'pull-requests', plugin });
  return { ...view, rerender: (next: React.ReactElement) => view.rerender(inClient(next)) };
};

const heights = (height: number) =>
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(height);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.restoreAllMocks();
  markdown.html = undefined;
  markdown.imageSources = [];
  // jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
});

describe('CommentBody', () => {
  it('shows the plain text until the renderer has loaded, then its HTML', async () => {
    const view = await render(<CommentBody body="Looks **good**" images={NO_IMAGES} />);
    expect(view.container.textContent).toBe('Looks **good**');
    markdown.html = '<p>Looks <strong>good</strong></p>';
    view.rerender(<CommentBody body="Looks **good**" images={NO_IMAGES} />);
    expect(view.container.querySelector('strong')?.textContent).toBe('good');
  });

  it("resolves its images by GitHub's HTML, with one function while that stays", async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const signed = `https://private-user-images.githubusercontent.com/1/2-${uuid}.png?jwt=x`;
    const images = { byUrl: {}, byAttachment: { [uuid]: signed } };
    const body = `![a](https://github.com/user-attachments/assets/${uuid})`;
    const view = await render(<CommentBody body={body} images={images} />);
    view.rerender(<CommentBody body={body} images={images} />);
    const [first, second] = markdown.imageSources;
    expect(first?.(`https://github.com/user-attachments/assets/${uuid}`)).toBe(signed);
    expect(second).toBe(first);
    view.rerender(<CommentBody body={body} images={{ byUrl: {}, byAttachment: {} }} />);
    expect(markdown.imageSources.at(-1)).not.toBe(first);
  });

  it('renders nothing for a body of only HTML comments and whitespace', async () => {
    const view = await render(
      <CommentBody body={'<!-- MURMUR_IGNORE -->\n  '} images={NO_IMAGES} />
    );
    expect(view.container.textContent).toBe('');
    expect(view.container.querySelector('.mrpr-comment-body')).toBeNull();
  });

  it('keeps a body that says more than its HTML comment', async () => {
    const view = await render(
      <CommentBody body={'<!-- bot -->\nNeeds a test.'} images={NO_IMAGES} />
    );
    expect(view.container.textContent).toContain('Needs a test.');
  });

  it('shows a short body whole, with no button', async () => {
    heights(100);
    const view = await render(<CommentBody body="Short" images={NO_IMAGES} />);
    expect(view.queryByText('Show full comment')).toBeNull();
  });

  it('clamps a tall body at 240 px until Show full comment expands it', async () => {
    heights(500);
    const view = await render(<CommentBody body="Tall" images={NO_IMAGES} />);
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
