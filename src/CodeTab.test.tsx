// @vitest-environment jsdom
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubError, type Commit, type PullRequestFile, type ReviewComment } from './github';
import plugin from './index';
import type { ReviewThread } from './reviewThreads';
import { CodeTab, type ListState } from './CodeTab';

vi.mock('focus-trap-react', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@mindroom/client-sdk/ui', async (importOriginal) => {
  const ui = await importOriginal<typeof import('@mindroom/client-sdk/ui')>();
  return { ...ui, useMarkdownHtml: (markdown: string) => markdown };
});

// jsdom has no custom elements, layout or ResizeObserver, which Pierre's tree and diff view need:
// the diff view stands in as the names of its items' files, each with what its annotations
// render, and its footer, and the tree as a list of buttons, one for each path, with the status
// the tree was given.
const view = vi.hoisted(() => ({
  scrollTo: vi.fn(),
  props: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@pierre/diffs/react', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  type Annotation = { side: string; lineNumber: number };
  type Item = { id: string; fileDiff: { name: string }; annotations?: Annotation[] };
  type Props = {
    items: Item[];
    renderCodeViewFooter?: () => ReactNode;
    renderAnnotation?: (
      annotation: Annotation,
      fileDiff: Item['fileDiff'],
      item: Item
    ) => ReactNode;
  };
  return {
    CodeView: forwardRef<unknown, Props>(function CodeView(props, ref) {
      view.props = props;
      useImperativeHandle(ref, () => ({ scrollTo: view.scrollTo }));
      return (
        <div data-testid="diff-view">
          <ol aria-label="Diffs">
            {props.items.map((item) => (
              <li key={item.id}>
                {item.fileDiff.name}
                {item.annotations?.map((annotation) => (
                  <div key={`${annotation.side}:${annotation.lineNumber}`}>
                    {props.renderAnnotation?.(annotation, item.fileDiff, item)}
                  </div>
                ))}
              </li>
            ))}
          </ol>
          {props.renderCodeViewFooter?.()}
        </div>
      );
    }),
  };
});

vi.mock('@pierre/trees/react', async () => {
  const { useState, useSyncExternalStore } = await import('react');
  type Options = { onSelectionChange?: (paths: readonly string[]) => void };
  type Entry = { path: string; status: string };
  const createModel = (options: Options) => {
    let state = { paths: [] as readonly string[], statuses: new Map<string, string>() };
    const listeners = new Set<() => void>();
    const update = (next: Partial<typeof state>) => {
      state = { ...state, ...next };
      listeners.forEach((listener) => listener());
    };
    return {
      options,
      state: () => state,
      resetPaths: (paths: readonly string[]) => update({ paths }),
      setGitStatus: (entries: readonly Entry[] = []) =>
        update({ statuses: new Map(entries.map((entry) => [entry.path, entry.status])) }),
      batch() {},
      setIcons() {},
      getItem: () => null,
      getVisibleCount: () => state.paths.length,
      getItemHeight: () => 24,
      getSelectedPaths: () => [],
      getFocusedPath: () => null,
      focusPath() {},
      scrollToPath() {},
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  };
  type Model = ReturnType<typeof createModel>;
  return {
    useFileTree: (options: Options) => {
      const [model] = useState(() => createModel(options));
      return { model };
    },
    useFileTreeSelector: (model: Model, selector: (model: Model) => unknown) => selector(model),
    FileTree: ({ model, 'aria-label': label }: { model: Model; 'aria-label'?: string }) => {
      const { paths, statuses } = useSyncExternalStore(model.subscribe, model.state);
      return (
        <ul aria-label={label}>
          {paths.map((path) => (
            <li key={path} data-status={statuses.get(path)}>
              <button type="button" onClick={() => model.options.onSelectionChange?.([path])}>
                {path}
              </button>
            </li>
          ))}
        </ul>
      );
    },
  };
});

const FILES_URL = 'https://github.com/mindroom-ai/mindroom-chat/pull/200/files';
const REF = { owner: 'mindroom-ai', repo: 'mindroom-chat', number: 200 };

const file = (over: Partial<PullRequestFile> & Pick<PullRequestFile, 'path'>): PullRequestFile => ({
  previousPath: null,
  status: 'modified',
  additions: 1,
  deletions: 1,
  patch: '@@ -1 +1 @@\n-old\n+new',
  url: FILES_URL,
  ...over,
});

const FILES: PullRequestFile[] = [
  file({ path: 'src/app.ts' }),
  file({ path: 'README.md' }),
  file({ path: 'src/new.ts', status: 'added', deletions: 0, patch: '@@ -0,0 +1 @@\n+new' }),
  file({ path: 'old.ts', status: 'removed', additions: 0, patch: '@@ -1 +0,0 @@\n-old' }),
  file({
    path: 'docs/b.md',
    previousPath: 'docs/a.md',
    status: 'renamed',
    additions: 0,
    deletions: 0,
    patch: null,
  }),
  file({ path: 'lib/copy.ts', previousPath: 'lib/source.ts', status: 'copied' }),
  file({ path: 'logo.png', patch: null }),
];

const comment = (id: number, over: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  author: { login: 'ann', name: null, avatarUrl: null, url: null, isBot: false },
  body: `Comment ${id}`,
  createdAt: '2026-11-01T00:00:00Z',
  url: '',
  reactions: [],
  path: 'src/app.ts',
  line: 1,
  originalLine: 1,
  side: 'RIGHT',
  inReplyToId: null,
  reviewId: null,
  outdated: false,
  commitId: 'head',
  ...over,
});

const thread = (id: number, over: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  path: 'src/app.ts',
  line: 1,
  side: 'RIGHT',
  outdated: false,
  comments: [comment(id)],
  ...over,
});

const commit = (n: number): Commit => ({
  sha: `${n}`.repeat(40),
  headline: `Commit ${n}`,
  author: null,
  authorName: 'Ann',
  committedAt: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
  url: '',
});

const COMMITS = [commit(1), commit(2)];

const loaded = <T,>(items: T[]): ListState<T> => ({ status: 'success', items });

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// The second commit changes src/app.ts otherwise than the pull request as a whole, and adds a file.
const COMMIT_FILES = [
  {
    filename: 'src/app.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch: '@@ -5 +5 @@\n-a\n+b',
  },
  {
    filename: 'src/extra.ts',
    status: 'added',
    additions: 1,
    deletions: 0,
    patch: '@@ -0,0 +1 @@\n+x',
  },
];

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const commitRequests = () => fetchMock.mock.calls.filter(([url]) => url.includes('/commits/'));

type Options = {
  themeKind?: 'light' | 'dark';
  threads?: ListState<ReviewThread>;
  commits?: ListState<Commit>;
  commit?: string;
};

// The panel keeps the chosen commit; this stands in for it.
function Holder({ threads, commits, initial }: Omit<Options, 'themeKind'> & { initial?: string }) {
  const [chosen, setChosen] = useState(initial);
  return (
    <CodeTab
      pullRequest={REF}
      files={FILES}
      threads={threads ?? loaded<ReviewThread>([])}
      commits={commits ?? loaded(COMMITS)}
      commit={chosen}
      onCommitChange={setChosen}
    />
  );
}

const show = (options: Options = {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return renderPluginComponent(
    <QueryClientProvider client={client}>
      <Holder threads={options.threads} commits={options.commits} initial={options.commit} />
    </QueryClientProvider>,
    { id: 'pull-requests', plugin, themeKind: options.themeKind ?? 'light' }
  );
};

const click = (element: HTMLElement) => act(async () => element.click());

const diffNames = () =>
  (view.props?.items as { id: string }[] | undefined)?.map((item) => item.id) ?? [];
const annotationsOf = (path: string) =>
  (view.props?.items as { id: string; annotations?: unknown[] }[]).find((item) => item.id === path)
    ?.annotations;
const versionOf = (path: string) =>
  (view.props?.items as { id: string; version?: number }[]).find((item) => item.id === path)
    ?.version;

const chooseCommit = async (tabView: Awaited<ReturnType<typeof show>>, name: RegExp | string) => {
  await click(tabView.getByRole('button', { name: /^Diff scope:/ }));
  await click(tabView.getByRole('menuitemradio', { name }));
};

const treeItems = (tree: HTMLElement) =>
  [...tree.querySelectorAll('li')].map((item) => [item.textContent, item.dataset.status]);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  view.scrollTo.mockReset();
  view.props = undefined;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url) =>
    url.includes(`/commits/${commit(2).sha}`)
      ? respond({ sha: commit(2).sha, files: COMMIT_FILES })
      : respond({}, 404)
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  vi.unstubAllGlobals();
});

describe('CodeTab', () => {
  it('lists every file in the tree, patchless ones included', async () => {
    const tab = await show();
    const tree = tab.getByRole('list', { name: 'Files of mindroom-ai/mindroom-chat #200' });
    expect(treeItems(tree)).toEqual([
      ['src/app.ts', 'modified'],
      ['README.md', 'modified'],
      ['src/new.ts', 'added'],
      ['old.ts', 'deleted'],
      ['docs/b.md', 'renamed'],
      ['lib/copy.ts', 'renamed'],
      ['logo.png', 'modified'],
    ]);
    expect(tab.getByText('7 files')).toBeTruthy();
  });

  it('gives the diff view the parsed files in tree order', async () => {
    const tab = await show();
    const diffs = tab.getByRole('list', { name: 'Diffs' });
    expect([...diffs.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'src/app.ts',
      'src/new.ts',
      'README.md',
      'old.ts',
      'docs/b.md',
      'lib/copy.ts',
    ]);
    expect(view.props?.disableWorkerPool).toBe(true);
    expect(view.props?.options).toMatchObject({
      theme: 'pierre-light',
      diffStyle: 'unified',
      overflow: 'wrap',
    });
  });

  it('draws the diffs in the dark theme while the app shows a dark one', async () => {
    await show({ themeKind: 'dark' });
    expect(view.props?.options).toMatchObject({ theme: 'pierre-dark' });
  });

  it('choosing a file scrolls its diff into view', async () => {
    const tab = await show();
    await click(tab.getByRole('button', { name: 'README.md' }));
    expect(view.scrollTo).toHaveBeenCalledWith({ type: 'item', id: 'README.md', align: 'start' });
  });

  it('shows No diff to show for a patchless file', async () => {
    const tab = await show();
    const row = tab.getByText('No diff to show').closest('li');
    expect(row?.textContent).toContain('logo.png');
    const link = row?.querySelector('a');
    expect(link?.getAttribute('href')).toBe(FILES_URL);
    expect(link?.textContent).toBe('Open on GitHub');
    expect(tab.getAllByText('No diff to show')).toHaveLength(1);
  });

  it('choosing a patchless file scrolls its row into view', async () => {
    // jsdom does not scroll.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const tab = await show();
    await click(tab.getByRole('button', { name: 'logo.png' }));
    expect(view.scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(tab.getByText('No diff to show').closest('li'));
  });

  it('the Files toggle hides the tree', async () => {
    const tab = await show();
    const toggle = tab.getByRole('button', { name: 'Files' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await click(toggle);
    expect(tab.queryByRole('list', { name: /^Files of/ })).toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(tab.getByTestId('diff-view')).toBeTruthy();
    await click(toggle);
    expect(tab.getByRole('list', { name: /^Files of/ })).toBeTruthy();
  });

  describe('review threads', () => {
    it('threads on rendered lines become annotations', async () => {
      const right = thread(1);
      const left = thread(2, { path: 'old.ts', side: 'LEFT' });
      const tab = await show({ threads: loaded([right, left]) });
      expect(annotationsOf('src/app.ts')).toEqual([
        { side: 'additions', lineNumber: 1, metadata: { threads: [right] } },
      ]);
      expect(annotationsOf('old.ts')).toEqual([
        { side: 'deletions', lineNumber: 1, metadata: { threads: [left] } },
      ]);
      expect(annotationsOf('README.md')).toEqual([]);
      const row = tab.getByText('Comment 1').closest('li');
      expect(row?.textContent).toContain('src/app.ts');
      expect(tab.getByText('Comment 2').closest('li')?.textContent).toContain('old.ts');
      expect(tab.getAllByRole('button', { name: '1 comment' })).toHaveLength(2);
      expect(tab.queryByRole('button', { name: /^Conversations not on/ })).toBeNull();
    });

    it('redraws a file whose threads loaded after it', async () => {
      const client = new QueryClient();
      const at = (threads: ListState<ReviewThread>) => (
        <QueryClientProvider client={client}>
          <Holder threads={threads} />
        </QueryClientProvider>
      );
      const tab = await renderPluginComponent(at({ status: 'pending' }), {
        id: 'pull-requests',
        plugin,
      });
      const before = { app: versionOf('src/app.ts'), readme: versionOf('README.md') };
      tab.rerender(at(loaded([thread(1)])));
      // Pierre's view keeps an item it has drawn until its version changes.
      expect(versionOf('src/app.ts')).not.toBe(before.app);
      expect(versionOf('README.md')).toBe(before.readme);
    });

    it('threads outside the hunks, outdated threads and all threads on a commit view go to the bar', async () => {
      const placed = thread(1);
      const tab = await show({
        threads: loaded([
          placed,
          thread(2, { line: 30 }),
          thread(3, { outdated: true }),
          thread(4, { line: null }),
          thread(5, { path: 'logo.png' }),
        ]),
      });
      expect(annotationsOf('src/app.ts')).toEqual([
        { side: 'additions', lineNumber: 1, metadata: { threads: [placed] } },
      ]);
      const bar = tab.getByRole('button', { name: 'Conversations not on the current diff (4)' });
      await click(bar);
      expect(tab.getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual([
        'src/app.ts',
        'logo.png',
      ]);
      expect(tab.getByRole('group', { name: 'src/app.ts' }).textContent).not.toContain('Comment 1');

      await chooseCommit(tab, /^Commit 2/);
      expect(
        await tab.findByRole('button', { name: 'Conversations not on the current diff (5)' })
      ).toBeTruthy();
      expect(diffNames()).toEqual(['src/app.ts', 'src/extra.ts']);
      expect(annotationsOf('src/app.ts')).toEqual([]);
    });

    it('shows the error of the review comments in place of the bar, and the diff', async () => {
      const retry = vi.fn();
      const tab = await show({
        threads: { status: 'error', error: new GitHubError('failed', 500), retry },
      });
      expect(tab.getByText('GitHub answered with status 500.')).toBeTruthy();
      expect(diffNames()).toHaveLength(6);
      await click(tab.getByRole('button', { name: 'Try again' }));
      expect(retry).toHaveBeenCalledTimes(1);
    });
  });

  describe('commits', () => {
    it('choosing a commit shows its files', async () => {
      const tab = await show();
      const whole = versionOf('src/app.ts');
      await chooseCommit(tab, /^Commit 2/);
      expect(await tab.findByText('2 files')).toBeTruthy();
      expect(diffNames()).toEqual(['src/app.ts', 'src/extra.ts']);
      expect(tab.getByRole('button', { name: 'Diff scope: Commit 2' })).toBeTruthy();
      expect(
        treeItems(tab.getByRole('list', { name: 'Files of mindroom-ai/mindroom-chat #200' }))
      ).toEqual([
        ['src/app.ts', 'modified'],
        ['src/extra.ts', 'added'],
      ]);
      // The same path is another diff in the commit's view.
      expect(versionOf('src/app.ts')).not.toBe(whole);
      expect(commitRequests().map(([url]) => url)).toEqual([
        `https://api.github.com/repos/mindroom-ai/mindroom-chat/commits/${commit(2).sha}`,
      ]);

      await chooseCommit(tab, 'All commits');
      expect(diffNames()).toHaveLength(6);
      expect(tab.getByText('7 files')).toBeTruthy();
      expect(commitRequests()).toHaveLength(1);
    });

    it('falls back when the commit is gone', async () => {
      // The Timeline can open a commit that a force-push took out of the pull request.
      const tab = await show({ commit: 'gone' });
      expect(tab.getByRole('button', { name: 'Diff scope: All commits' })).toBeTruthy();
      expect(tab.getByText('7 files')).toBeTruthy();
      expect(diffNames()).toHaveLength(6);
      expect(commitRequests()).toHaveLength(0);
    });

    it("shows a commit's files loading, then their error with a retry", async () => {
      let answer: (response: Response) => void = () => undefined;
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          })
      );
      const tab = await show({ commit: commit(1).sha });
      expect(tab.getByText('Loading files')).toBeTruthy();
      expect(tab.queryByTestId('diff-view')).toBeNull();
      fetchMock.mockImplementation(async () => respond({}, 500));
      await act(async () => answer(respond({}, 500)));
      expect(await tab.findByText('GitHub answered with status 500.')).toBeTruthy();
      // The selector stays, so the reader can go back to All commits.
      await chooseCommit(tab, 'All commits');
      expect(diffNames()).toHaveLength(6);
    });

    it('shows the error of the commits in place of the selector, and the diff', async () => {
      const retry = vi.fn();
      const tab = await show({
        commits: { status: 'error', error: new GitHubError('failed', 0), retry },
      });
      expect(tab.queryByRole('button', { name: /^Diff scope:/ })).toBeNull();
      expect(tab.getByText('GitHub could not be reached.')).toBeTruthy();
      expect(diffNames()).toHaveLength(6);
      await click(tab.getByRole('button', { name: 'Try again' }));
      expect(retry).toHaveBeenCalledTimes(1);
    });

    it('shows no selector while the commits load', async () => {
      const tab = await show({ commits: { status: 'pending' } });
      expect(tab.queryByRole('button', { name: /^Diff scope:/ })).toBeNull();
      expect(diffNames()).toHaveLength(6);
    });
  });
});
