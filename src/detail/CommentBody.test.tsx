// @vitest-environment jsdom
import { act } from '../testing/act';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from '../index';
import { CommentBody } from './CommentBody';

const NO_IMAGES = { byUrl: {}, byAttachment: {} };
const UUID = '11111111-2222-3333-4444-555555555555';
const ATTACHMENT = `https://github.com/user-attachments/assets/${UUID}`;
const SIGNED = `https://private-user-images.githubusercontent.com/1/2-${UUID}.png?jwt=x`;
const BADGE = 'https://img.example/b.svg';
const CAMO = 'https://camo.githubusercontent.com/abc/def';

type ImageSource = (src: string) => string | undefined;
const markdown = vi.hoisted(() => ({
  html: undefined as string | undefined,
  inputs: [] as string[],
  imageSources: [] as (ImageSource | undefined)[],
}));
vi.mock('@mindroom/client-sdk/ui', async (importOriginal) => {
  const ui = await importOriginal<typeof import('@mindroom/client-sdk/ui')>();
  return {
    ...ui,
    useMarkdownHtml: (input: string, options?: { imageSource?: ImageSource }) => {
      markdown.inputs.push(input);
      markdown.imageSources.push(options?.imageSource);
      return markdown.html;
    },
  };
});

const render = (ui: React.ReactElement) =>
  renderPluginComponent(ui, { id: 'pull-requests', plugin });

const heights = (height: number) =>
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(height);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.restoreAllMocks();
  markdown.html = undefined;
  markdown.inputs = [];
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

  it('scrolls a wide table in its own box, as a thread shows one', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    markdown.html = '<table><tbody><tr><td><code>ed6eed9</code></td></tr></tbody></table>';
    const view = await render(<CommentBody body="| a |" images={NO_IMAGES} />);
    const box = view.getByRole('region', { name: 'Scrollable table' });
    expect(box.querySelector('td code')?.textContent).toBe('ed6eed9');
  });

  it("resolves its images by GitHub's HTML, with one function while that stays", async () => {
    const images = { byUrl: { [BADGE]: CAMO }, byAttachment: { [UUID]: SIGNED } };
    const body = `![a](${ATTACHMENT}) ![b](${BADGE})`;
    const view = await render(<CommentBody body={body} images={images} />);
    view.rerender(<CommentBody body={body} images={images} />);
    const [first, second] = markdown.imageSources;
    expect(first?.(ATTACHMENT)).toBe(ATTACHMENT);
    expect(first?.(BADGE)).toBe(CAMO);
    expect(second).toBe(first);
    view.rerender(<CommentBody body={body} images={{ byUrl: {}, byAttachment: {} }} />);
    expect(markdown.imageSources.at(-1)).not.toBe(first);
  });

  it('loads a failed attachment from its signed address once, and no other image', async () => {
    markdown.html = `<p><img alt="a" src="${ATTACHMENT}"> <img alt="b" src="${CAMO}"></p>`;
    const images = { byUrl: { [BADGE]: CAMO }, byAttachment: { [UUID]: SIGNED } };
    const view = await render(<CommentBody body="![a](x)" images={images} />);
    const fail = (alt: string) =>
      act(async () => void view.getByAltText(alt).dispatchEvent(new Event('error')));
    await fail('a');
    expect(view.getByAltText('a').getAttribute('src')).toBe(SIGNED);
    await fail('a');
    expect(view.getByAltText('a').getAttribute('src')).toBe(SIGNED);
    await fail('b');
    expect(view.getByAltText('b').getAttribute('src')).toBe(CAMO);
  });

  it('renders nothing for a body of only HTML comments and whitespace', async () => {
    const view = await render(
      <CommentBody body={'<!-- MURMUR_IGNORE -->\n  '} images={NO_IMAGES} />
    );
    expect(view.container.textContent).toBe('');
    expect(view.container.querySelector('.mrpr-comment-body')).toBeNull();
  });

  it('strips HTML comments and links verified refs from bodyMeta', async () => {
    const bodyMeta = {
      links: { '#42': 'https://github.com/acme/widgets/issues/42' },
      commits: {},
      videos: {},
    };
    const view = await render(
      <CommentBody
        body={'<!-- auto-generated note -->\nSee #42.'}
        images={NO_IMAGES}
        bodyMeta={bodyMeta}
      />
    );
    expect(view.container.textContent).toBe(
      'See [#42](https://github.com/acme/widgets/issues/42).'
    );
    expect(markdown.inputs.at(-1)).toBe('See [#42](https://github.com/acme/widgets/issues/42).');
  });

  it('shows a short body whole, with no button', async () => {
    heights(100);
    const view = await render(<CommentBody body="Short" images={NO_IMAGES} />);
    expect(view.queryByText('Show full comment')).toBeNull();
  });

  it('clamps a tall body at 15rem until Show full comment expands it', async () => {
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

  it("measures the clamp in the root's font size, which the page zoom scales", async () => {
    heights(300);
    document.documentElement.style.fontSize = '24px';
    try {
      // 15rem is 360 px at 150 %: nothing is hidden.
      const view = await render(<CommentBody body="Tall" images={NO_IMAGES} />);
      expect(view.queryByText('Show full comment')).toBeNull();
      // 240 px at 100 %: the same body is cut.
      await act(async () => {
        document.documentElement.style.fontSize = '16px';
        await Promise.resolve();
      });
      expect(view.getByText('Show full comment')).toBeTruthy();
    } finally {
      document.documentElement.style.fontSize = '';
    }
  });
});
