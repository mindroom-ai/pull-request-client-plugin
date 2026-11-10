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
import { trapOptions } from './testing/focusTrapStandIn';

vi.mock('focus-trap-react', async () => ({
  default: (await import('./testing/focusTrapStandIn')).FocusTrapStandIn,
}));

vi.mock('@mindroom/client-sdk/ui', async (importOriginal) => {
  const ui = await importOriginal<typeof import('@mindroom/client-sdk/ui')>();
  return { ...ui, useMarkdownHtml: (markdown: string) => markdown };
});

// jsdom has no custom elements, layout or ResizeObserver, which Pierre's tree and diff view need:
// the diff view stands in as the names of its items' files, each with its header's prefix and
// metadata and what its annotations render, and its footer, and the tree as a list of buttons, one
// for each path, with the status the tree was given.
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
    renderHeaderPrefix?: (item: Item) => ReactNode;
    renderHeaderMetadata?: (item: Item) => ReactNode;
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
                <div data-testid={`header:${item.id}`}>
                  {props.renderHeaderPrefix?.(item)}
                  {props.renderHeaderMetadata?.(item)}
                </div>
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
      // The tree adds and removes paths in batches; this applies the files' ones, in order.
      batch: (operations: readonly { type: string; path: string }[]) => {
        let paths = state.paths;
        for (const { type, path } of operations) {
          if (path.endsWith('/')) continue;
          if (type === 'remove') paths = paths.filter((candidate) => candidate !== path);
          if (type === 'add') paths = [...paths, path];
        }
        update({ paths });
      },
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
  sha: null,
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
  files?: PullRequestFile[];
  threads?: ListState<ReviewThread>;
  commits?: ListState<Commit>;
  commit?: string;
  truncatedReviewComments?: number;
};

// The panel keeps the chosen commit; this stands in for it.
function Holder({
  files,
  threads,
  commits,
  initial,
  truncatedReviewComments,
}: Omit<Options, 'themeKind' | 'commit'> & { initial?: string }) {
  const [chosen, setChosen] = useState(initial);
  return (
    <CodeTab
      pullRequest={REF}
      files={files ?? FILES}
      threads={threads ?? loaded<ReviewThread>([])}
      commits={commits ?? loaded(COMMITS)}
      commit={chosen}
      onCommitChange={setChosen}
      truncatedReviewComments={truncatedReviewComments}
    />
  );
}

const show = ({ themeKind, commit, ...options }: Options = {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return renderPluginComponent(
    <QueryClientProvider client={client}>
      <Holder {...options} initial={commit} />
    </QueryClientProvider>,
    { id: 'pull-requests', plugin, themeKind: themeKind ?? 'light' }
  );
};

const click = (element: HTMLElement) => act(async () => element.click());
const shiftClick = (element: HTMLElement) =>
  act(async () => {
    element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })
    );
  });

const diffNames = () =>
  (view.props?.items as { id: string }[] | undefined)?.map((item) => item.id) ?? [];
const annotationsOf = (path: string) =>
  (view.props?.items as { id: string; annotations?: unknown[] }[]).find((item) => item.id === path)
    ?.annotations;
const versionOf = (path: string) =>
  (view.props?.items as { id: string; version?: number }[]).find((item) => item.id === path)
    ?.version;
type ShownItem = {
  id: string;
  collapsed?: boolean;
  fileDiff: {
    cacheKey?: string;
    hunks: { additionLines: number; deletionLines: number }[];
  };
};
const itemOf = (path: string) =>
  (view.props?.items as ShownItem[]).find((item) => item.id === path);
const options = () => view.props?.options as Record<string, unknown>;

type TabView = Awaited<ReturnType<typeof show>>;
// The viewed checkbox of a file: in its diff's header, or in its row without a diff.
const viewedBox = (tab: TabView, path: string) => {
  const holder =
    tab.queryByTestId(`header:${path}`) ??
    [...tab.container.querySelectorAll('.mrpr-no-diff')].find((row) =>
      row.textContent?.startsWith(path)
    );
  const box = holder?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!box) throw new Error(`No viewed checkbox for ${path}`);
  return box;
};
const viewedPaths = (tab: TabView, paths: string[]) =>
  paths.filter((path) => viewedBox(tab, path).checked);
const foldToggle = (tab: TabView, path: string) => {
  const button = tab
    .getByTestId(`header:${path}`)
    .querySelector<HTMLButtonElement>('button[aria-expanded]');
  if (!button) throw new Error(`No fold toggle for ${path}`);
  return button;
};

const chooseCommit = async (tabView: Awaited<ReturnType<typeof show>>, name: RegExp | string) => {
  await click(tabView.getByRole('button', { name: /^Diff scope:/ }));
  await click(tabView.getByRole('menuitemradio', { name }));
};

const treeItems = (tree: HTMLElement) =>
  [...tree.querySelectorAll('li')].map((item) => [item.textContent, item.dataset.status]);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
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
      ['docs/b.md', 'renamed'],
      ['lib/copy.ts', 'renamed'],
      ['old.ts', 'deleted'],
      ['README.md', 'modified'],
      ['src/app.ts', 'modified'],
      ['src/new.ts', 'added'],
      ['logo.png', 'modified'],
    ]);
    expect(tab.getByText('7 files')).toBeTruthy();
  });

  it('gives the diff view the parsed files in tree order', async () => {
    await show();
    expect(diffNames()).toEqual([
      'docs/b.md',
      'lib/copy.ts',
      'old.ts',
      'README.md',
      'src/app.ts',
      'src/new.ts',
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
      const groups = [...tab.container.querySelectorAll('.mrpr-off-diff [role="group"]')];
      expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
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

  describe('viewed marks', () => {
    it('marks a file viewed and collapses it', async () => {
      const tab = await show();
      const before = versionOf('src/app.ts');
      const box = viewedBox(tab, 'src/app.ts');
      expect(box.checked).toBe(false);
      expect(box.getAttribute('aria-label')).toBe('Viewed');
      expect(itemOf('src/app.ts')?.collapsed).toBe(false);

      await click(box);
      expect(viewedBox(tab, 'src/app.ts').checked).toBe(true);
      expect(itemOf('src/app.ts')?.collapsed).toBe(true);
      // Pierre's view folds an item it has drawn only once its version changes.
      expect(versionOf('src/app.ts')).not.toBe(before);
      expect(
        tab.getByTestId('header:src/app.ts').querySelector('[aria-label="Expand diff"]')
      ).toBeTruthy();
      expect(itemOf('README.md')?.collapsed).toBe(false);

      await click(viewedBox(tab, 'src/app.ts'));
      expect(viewedBox(tab, 'src/app.ts').checked).toBe(false);
      expect(itemOf('src/app.ts')?.collapsed).toBe(false);
      expect(versionOf('src/app.ts')).toBe(before);
    });

    it('a changed patch shows Changed', async () => {
      const first = await show();
      await click(viewedBox(first, 'src/app.ts'));
      first.unmount();

      // A push changed the file since.
      const tab = await show({
        files: FILES.map((entry) =>
          entry.path === 'src/app.ts' ? { ...entry, patch: '@@ -1 +1 @@\n-old\n+newer' } : entry
        ),
      });
      const box = viewedBox(tab, 'src/app.ts');
      expect(box.checked).toBe(false);
      expect(box.getAttribute('aria-label')).toBe('Changed');
      const changed = tab.getByText('Changed');
      expect(changed.classList.contains('mrpr-tone-warning')).toBe(true);
      expect(tab.getByText('0 / 7 viewed')).toBeTruthy();

      await click(box);
      expect(viewedBox(tab, 'src/app.ts').checked).toBe(true);
      expect(viewedBox(tab, 'src/app.ts').getAttribute('aria-label')).toBe('Viewed');
      expect(tab.queryByText('Changed')).toBeNull();
    });

    it('a file without a patch shows Changed once its blob changed', async () => {
      const withLogo = (sha: string) =>
        FILES.map((entry) => (entry.path === 'logo.png' ? { ...entry, sha } : entry));
      const first = await show({ files: withLogo('b10b1') });
      await click(viewedBox(first, 'logo.png'));
      first.unmount();

      const pushed = await show({ files: withLogo('b10b2') });
      expect(viewedBox(pushed, 'logo.png').getAttribute('aria-label')).toBe('Changed');
      expect(viewedBox(pushed, 'logo.png').checked).toBe(false);
      pushed.unmount();

      const same = await show({ files: withLogo('b10b1') });
      expect(viewedBox(same, 'logo.png').checked).toBe(true);
    });

    it('viewed files start folded when a view starts', async () => {
      const first = await show();
      await click(viewedBox(first, 'src/app.ts'));
      expect(itemOf('src/app.ts')?.collapsed).toBe(true);
      first.unmount();

      const tab = await show();
      expect(itemOf('src/app.ts')?.collapsed).toBe(true);
      expect(itemOf('README.md')?.collapsed).toBe(false);
      // Unfolding it afterwards keeps it viewed.
      await click(foldToggle(tab, 'src/app.ts'));
      expect(itemOf('src/app.ts')?.collapsed).toBe(false);
      expect(viewedBox(tab, 'src/app.ts').checked).toBe(true);

      // A commit's view starts again, and so does All commits after it.
      await chooseCommit(tab, /^Commit 2/);
      expect(await tab.findByText('2 files')).toBeTruthy();
      expect(itemOf('src/app.ts')?.collapsed).toBe(true);
      expect(itemOf('src/extra.ts')?.collapsed).toBe(false);
      await click(foldToggle(tab, 'src/app.ts'));
      expect(itemOf('src/app.ts')?.collapsed).toBe(false);
      await chooseCommit(tab, 'All commits');
      expect(itemOf('src/app.ts')?.collapsed).toBe(true);
    });

    it('Shift-click marks a range', async () => {
      const tab = await show();
      const order = [
        'docs/b.md',
        'lib/copy.ts',
        'old.ts',
        'README.md',
        'src/app.ts',
        'src/new.ts',
        'logo.png',
      ];
      await click(viewedBox(tab, 'lib/copy.ts'));
      await shiftClick(viewedBox(tab, 'README.md'));
      expect(viewedPaths(tab, order)).toEqual(['lib/copy.ts', 'old.ts', 'README.md']);
      expect(['lib/copy.ts', 'old.ts', 'README.md'].map((path) => itemOf(path)?.collapsed)).toEqual(
        [true, true, true]
      );
      expect(itemOf('docs/b.md')?.collapsed).toBe(false);

      // On to the file without a diff, the last one shown.
      await shiftClick(viewedBox(tab, 'logo.png'));
      expect(viewedPaths(tab, order)).toEqual(order.slice(1));

      // A range unmarks too, as the file clicked goes.
      await click(viewedBox(tab, 'src/new.ts'));
      await shiftClick(viewedBox(tab, 'old.ts'));
      expect(viewedPaths(tab, order)).toEqual(['lib/copy.ts', 'logo.png']);
      expect(itemOf('README.md')?.collapsed).toBe(false);
    });

    it('X / N viewed', async () => {
      const tab = await show();
      expect(tab.getByText('0 / 7 viewed')).toBeTruthy();
      await click(viewedBox(tab, 'src/app.ts'));
      await click(viewedBox(tab, 'logo.png'));
      expect(tab.getByText('2 / 7 viewed')).toBeTruthy();

      // A commit's view counts the files the pull request has; the commit's own new file has no
      // mark, since the pull request does not change it.
      await chooseCommit(tab, /^Commit 2/);
      expect(await tab.findByText('1 / 1 viewed')).toBeTruthy();
      expect(viewedBox(tab, 'src/app.ts').checked).toBe(true);
      expect(
        tab.getByTestId('header:src/extra.ts').querySelector('input[type="checkbox"]')
      ).toBeNull();
    });
  });

  describe('display controls', () => {
    const TEST_FILES = [
      file({ path: 'src/a.ts' }),
      file({ path: 'src/a.test.ts' }),
      file({ path: 'e2e/flow.spec.ts', patch: null }),
      file({ path: 'README.md' }),
    ];

    it('hide test files hides them and says how many', async () => {
      const tab = await show({ files: TEST_FILES });
      const toggle = tab.getByRole('button', { name: 'Hide test files' });
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      expect(tab.getByText('4 files')).toBeTruthy();

      await click(toggle);
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(diffNames()).toEqual(['README.md', 'src/a.ts']);
      expect(tab.queryByText('No diff to show')).toBeNull();
      const tree = tab.getByRole('list', { name: /^Files of/ });
      expect(treeItems(tree).map(([path]) => path)).toEqual(['README.md', 'src/a.ts']);
      expect(tab.getByText('2 files')).toBeTruthy();
      expect(tab.getByText('0 / 2 viewed')).toBeTruthy();

      await click(tab.getByRole('button', { name: '2 test files hidden' }));
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      expect(diffNames()).toEqual(['README.md', 'src/a.ts', 'src/a.test.ts']);
      expect(tab.getByText('No diff to show')).toBeTruthy();
      expect(tab.getByText('4 files')).toBeTruthy();
    });

    it('offers no test file toggle without test files', async () => {
      const tab = await show();
      expect(tab.queryByRole('button', { name: 'Hide test files' })).toBeNull();
    });

    it('ignore whitespace re-parses', async () => {
      const tab = await show({
        files: [
          file({ path: 'src/a.ts', patch: '@@ -1 +1 @@\n-a  b\n+a b' }),
          file({ path: 'src/b.ts', patch: '@@ -1 +1 @@\n-x\n+y' }),
        ],
      });
      const before = versionOf('src/a.ts');
      expect(itemOf('src/a.ts')?.fileDiff.hunks[0]?.additionLines).toBe(1);
      const toggle = tab.getByRole('button', { name: 'Hide whitespace changes' });
      expect(toggle.getAttribute('aria-pressed')).toBe('false');

      await click(toggle);
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      const hidden = itemOf('src/a.ts');
      expect(hidden?.fileDiff.cacheKey).toMatch(/:ignore-whitespace$/);
      expect(hidden?.fileDiff.hunks.map((hunk) => hunk.additionLines + hunk.deletionLines)).toEqual(
        [0]
      );
      expect(versionOf('src/a.ts')).not.toBe(before);
      expect(itemOf('src/b.ts')?.fileDiff.hunks[0]?.additionLines).toBe(1);
    });

    it('split and wrap reach the diff view', async () => {
      const tab = await show();
      expect(options()).toMatchObject({ diffStyle: 'unified', overflow: 'wrap' });
      const stacked = tab.getByRole('button', { name: 'Stacked diff view' });
      const split = tab.getByRole('button', { name: 'Split diff view' });
      expect(stacked.getAttribute('aria-pressed')).toBe('true');

      await click(split);
      expect(options()).toMatchObject({ diffStyle: 'split' });
      expect(split.getAttribute('aria-pressed')).toBe('true');
      expect(stacked.getAttribute('aria-pressed')).toBe('false');

      const wrap = tab.getByRole('button', { name: 'Wrap lines' });
      expect(wrap.getAttribute('aria-pressed')).toBe('true');
      await click(wrap);
      expect(options()).toMatchObject({ overflow: 'scroll' });
      expect(wrap.getAttribute('aria-pressed')).toBe('false');
    });

    it('the diff options menu holds the same choices', async () => {
      const tab = await show();
      await click(tab.getByRole('button', { name: 'Diff options' }));
      const whitespace = tab.getByRole('menuitemcheckbox', { name: 'Hide whitespace changes' });
      expect(whitespace.getAttribute('aria-checked')).toBe('false');
      await click(whitespace);
      expect(whitespace.getAttribute('aria-checked')).toBe('true');
      expect(
        tab.getByRole('button', { name: 'Hide whitespace changes' }).getAttribute('aria-pressed')
      ).toBe('true');
      await click(tab.getByRole('menuitemcheckbox', { name: 'Wrap lines' }));
      expect(options()).toMatchObject({ overflow: 'scroll' });

      expect(tab.getByRole('menuitemradio', { name: 'Stacked' }).getAttribute('aria-checked')).toBe(
        'true'
      );
      // A click focuses the row it chooses, inside the menu's focus trap.
      const split = tab.getByRole('menuitemradio', { name: 'Split' });
      act(() => split.focus());
      await click(split);
      expect(options()).toMatchObject({ diffStyle: 'split' });
      // Choosing a layout closes the menu and gives the focus back to its button.
      expect(tab.queryByRole('menuitemradio', { name: 'Split' })).toBeNull();
      expect(document.activeElement).toBe(tab.getByRole('button', { name: 'Diff options' }));
    });

    it('Escape closes the diff options menu and gives the focus back to its button', async () => {
      const tab = await show();
      const button = tab.getByRole('button', { name: 'Diff options' });
      await click(button);
      act(() => tab.getByRole('menuitemcheckbox', { name: 'Wrap lines' }).focus());
      await act(async () => {
        trapOptions().escapeDeactivates?.();
      });
      expect(tab.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(button);
    });

    it('prefs persist across mounts', async () => {
      const first = await show({ files: TEST_FILES });
      await click(first.getByRole('button', { name: 'Split diff view' }));
      await click(first.getByRole('button', { name: 'Wrap lines' }));
      await click(first.getByRole('button', { name: 'Hide whitespace changes' }));
      await click(first.getByRole('button', { name: 'Hide test files' }));
      first.unmount();

      const tab = await show({ files: TEST_FILES });
      expect(options()).toMatchObject({ diffStyle: 'split', overflow: 'scroll' });
      expect(itemOf('src/a.ts')?.fileDiff.cacheKey).toMatch(/:ignore-whitespace$/);
      expect(diffNames()).toEqual(['README.md', 'src/a.ts']);
      for (const name of ['Split diff view', 'Hide whitespace changes', 'Hide test files']) {
        expect(tab.getByRole('button', { name }).getAttribute('aria-pressed')).toBe('true');
      }
      expect(tab.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe(
        'false'
      );
    });

    it("collapses or expands all, and each file's chevron folds its own", async () => {
      const tab = await show();
      await click(tab.getByRole('button', { name: 'Collapse all files' }));
      expect(diffNames().map((path) => itemOf(path)?.collapsed)).toEqual(Array(6).fill(true));

      // The header's chevron, then a click on the header itself, unfold one file each.
      const chevron = tab
        .getByTestId('header:README.md')
        .querySelector<HTMLButtonElement>('[aria-label="Expand diff"]');
      expect(chevron?.getAttribute('aria-expanded')).toBe('false');
      // The chevron of a folded file points the way the text runs.
      expect(chevron?.querySelector('svg')?.classList.contains('mrpr-arrow-back')).toBe(true);
      await click(chevron!);
      expect(itemOf('README.md')?.collapsed).toBe(false);
      expect(itemOf('old.ts')?.collapsed).toBe(true);
      expect(
        tab.getByTestId('header:README.md').querySelector('[aria-label="Collapse diff"]')
      ).toBeTruthy();

      // One file open, so the toolbar offers to fold them all again.
      await click(tab.getByRole('button', { name: 'Collapse all files' }));
      expect(itemOf('README.md')?.collapsed).toBe(true);
      await click(tab.getByRole('button', { name: 'Expand all files' }));
      expect(diffNames().map((path) => itemOf(path)?.collapsed)).toEqual(Array(6).fill(false));
    });

    it('choosing a folded file in the tree unfolds it', async () => {
      const tab = await show();
      await click(viewedBox(tab, 'README.md'));
      expect(itemOf('README.md')?.collapsed).toBe(true);
      await click(tab.getByRole('button', { name: 'README.md' }));
      expect(itemOf('README.md')?.collapsed).toBe(false);
      expect(view.scrollTo).toHaveBeenCalledWith({ type: 'item', id: 'README.md', align: 'start' });
      // Still viewed: only the fold changed.
      expect(viewedBox(tab, 'README.md').checked).toBe(true);
    });

    it('a click on a header folds its file, but not one on its controls', async () => {
      const tab = await show();
      // Pierre draws the header in its own element; the title names the file.
      const header = document.createElement('div');
      header.setAttribute('data-diffs-header', '');
      const title = document.createElement('span');
      title.setAttribute('data-title', '');
      title.textContent = 'README.md';
      const mark = document.createElement('label');
      mark.setAttribute('data-viewed-toggle', '');
      const button = document.createElement('button');
      header.append(title, mark, button);
      tab.getByTestId('diff-view').append(header);
      await click(title);
      expect(itemOf('README.md')?.collapsed).toBe(true);
      await click(mark);
      await click(button);
      expect(itemOf('README.md')?.collapsed).toBe(true);
      await click(title);
      expect(itemOf('README.md')?.collapsed).toBe(false);
      header.remove();
    });
  });

  describe('file order and headers', () => {
    it('orders source before its tests and lockfiles last', async () => {
      const tab = await show({
        files: [
          file({ path: 'package-lock.json', patch: '@@ -1 +1 @@\n-{}\n+{ }' }),
          file({
            path: 'src/b.test.ts',
            status: 'added',
            patch: '@@ -0,0 +1 @@\n+import { b } from "./b";',
          }),
          file({
            path: 'src/a.ts',
            status: 'added',
            patch: '@@ -0,0 +1 @@\n+import { b } from "./b";',
          }),
          file({ path: 'src/b.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+export const b = 1;' }),
          file({ path: 'README.md' }),
        ],
      });
      // Each source file after what it imports, its tests after the sources, lockfiles last; the
      // tree shows them in the same order.
      const order = ['README.md', 'src/b.ts', 'src/a.ts', 'src/b.test.ts', 'package-lock.json'];
      expect(diffNames()).toEqual(order);
      const tree = tab.getByRole('list', { name: /^Files of/ });
      expect(treeItems(tree).map(([path]) => path)).toEqual(order);
    });

    it("each header shows GitHub's counts, also for files without a diff", async () => {
      const tab = await show({
        files: FILES.map((entry) =>
          entry.path === 'src/app.ts' ? { ...entry, additions: 12, deletions: 3 } : entry
        ),
      });
      expect(tab.getByTestId('header:src/app.ts').textContent).toContain('+12-3');
      // A pure rename changes no line.
      expect(tab.getByTestId('header:docs/b.md').textContent).not.toMatch(/\+\d/);
      expect(tab.getByText('No diff to show').closest('li')?.textContent).toContain('+1-1');
      // Pierre's own counts, from the hunks, give way to them.
      expect(options().unsafeCSS).toMatch(/\[data-additions-count\][^}]*display: none/);
    });
  });

  describe('empty states', () => {
    it('says so when the pull request changes no file', async () => {
      const tab = await show({ files: [] });
      expect(tab.getByText('This pull request has no file changes.')).toBeTruthy();
      expect(tab.queryByTestId('diff-view')).toBeNull();
    });

    it('says so when only test files changed and they are hidden', async () => {
      const tab = await show({
        files: [file({ path: 'src/a.test.ts' }), file({ path: 'e2e/b.spec.ts', patch: null })],
      });
      await click(tab.getByRole('button', { name: 'Hide test files' }));
      expect(tab.getByText('Only test files changed, and test files are hidden.')).toBeTruthy();
      expect(tab.queryByTestId('diff-view')).toBeNull();
      await click(tab.getByRole('button', { name: '2 test files hidden' }));
      expect(diffNames()).toEqual(['src/a.test.ts']);
    });

    it('says so when only whitespace changed and whitespace changes are hidden', async () => {
      const tab = await show({
        files: [file({ path: 'src/a.ts', patch: '@@ -1 +1 @@\n-a  b\n+a b' })],
      });
      expect(diffNames()).toEqual(['src/a.ts']);
      await click(tab.getByRole('button', { name: 'Hide whitespace changes' }));
      expect(
        tab.getByText('Only whitespace changed, and whitespace changes are hidden.')
      ).toBeTruthy();
      expect(tab.queryByTestId('diff-view')).toBeNull();
    });
  });

  it('says when GitHub cut the review comments short', async () => {
    const tab = await show({ truncatedReviewComments: 1000 });
    const note = tab.getByRole('link', { name: 'Showing the first 1000; see the rest on GitHub' });
    expect(note.getAttribute('href')).toBe('https://github.com/mindroom-ai/mindroom-chat/pull/200');
    expect(diffNames()).toHaveLength(6);
  });
});
