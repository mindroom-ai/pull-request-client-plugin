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
    expect(view.getByRole('tab', { name: 'Code' }).getAttribute('aria-selected')).toBe('true');
    await act(async () => {
      view
        .getByRole('tab', { name: 'Code' })
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
});
