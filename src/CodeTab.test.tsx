// @vitest-environment jsdom
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from './testing/act';
import type { MindroomServer } from '@mindroom/client-sdk/server';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GitHubError,
  type Commit,
  type PullRequestRef,
  type PullRequestFile,
  type ReviewComment,
} from './github';
import plugin from './index';
import type { ReviewThread } from './reviewThreads';
import { CodeTab, type ListState } from './CodeTab';
import {
  hydratePartialDiff,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
} from '@pierre/diffs';
import { fnv1a32, getDiffLineStat } from './diff/diffRendering';
import { trapOptions } from './testing/focusTrapStandIn';
import {
  greenhouseAfter,
  greenhouseBefore,
  greenhousePatch,
  greenhousePath,
} from './testing/greenhouseDiff';
import { githubServer } from './testing/mindroomServer';
import { usePullRequestFiles } from './queries';
import { GitHubServerContext } from './token';

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
  type Item = {
    id: string;
    fileDiff: { name: string; isPartial: boolean };
    annotations?: Annotation[];
  };
  type Props = {
    items: Item[];
    renderCodeViewHeader?: () => ReactNode;
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
          {props.renderCodeViewHeader?.()}
          <ol aria-label="Diffs">
            {props.items.map((item) => (
              <li
                key={item.id}
                data-testid={`${item.fileDiff.isPartial ? 'partial' : 'complete'}:${item.id}`}
              >
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
  type Decoration = { text: string; title?: string; parts?: { text: string; color?: string }[] };
  type Options = {
    initialExpansion?: 'open' | 'closed';
    onSelectionChange?: (paths: readonly string[]) => void;
    renderRowDecoration?: (context: {
      item: { kind: 'directory' | 'file'; name: string; path: string };
    }) => Decoration | null;
  };
  type Entry = { path: string; status: string };
  const createModel = (options: Options) => {
    let state = {
      paths: [] as readonly string[],
      statuses: new Map<string, string>(),
      folders: [] as [string, Decoration | null][],
      focusedPath: null as string | null,
    };
    const listeners = new Set<() => void>();
    // Like Pierre, it draws the folders' decorations when it draws its rows: on a change of
    // paths or git status, or when its composition is set.
    const update = (next: Partial<typeof state>) => {
      const paths = next.paths ?? state.paths;
      const directories = paths.flatMap((path) => {
        const segments = path.split('/').slice(0, -1);
        return segments.map((_, index) => `${segments.slice(0, index + 1).join('/')}/`);
      });
      const folders = [...new Set(directories)].map((path): [string, Decoration | null] => [
        path,
        options.renderRowDecoration?.({ item: { kind: 'directory', name: path, path } }) ?? null,
      ]);
      state = { ...state, ...next, folders };
      listeners.forEach((listener) => listener());
    };
    return {
      options,
      state: () => state,
      resetPaths: (paths: readonly string[]) => update({ paths }),
      // Pierre draws nothing again for the git status it has.
      setGitStatus: (entries: readonly Entry[] = []) => {
        const statuses = new Map(entries.map((entry) => [entry.path, entry.status]));
        const same =
          statuses.size === state.statuses.size &&
          [...statuses].every(([path, status]) => state.statuses.get(path) === status);
        if (!same) update({ statuses });
      },
      getComposition: () => undefined,
      setComposition: () => update({}),
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
      getFocusedPath: () => state.focusedPath,
      focusPath(path: string) {
        if (state.focusedPath === path) return;
        state = { ...state, focusedPath: path };
        listeners.forEach((listener) => listener());
      },
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
      const { paths, statuses, folders, focusedPath } = useSyncExternalStore(
        model.subscribe,
        model.state
      );
      return (
        <>
          <ul aria-label={label} data-initial-expansion={model.options.initialExpansion}>
            {paths.map((path, index) => (
              <li key={path} data-status={statuses.get(path)}>
                <button
                  type="button"
                  role="treeitem"
                  tabIndex={focusedPath === path || (focusedPath === null && index === 0) ? 0 : -1}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.currentTarget.click();
                    }
                  }}
                  onClick={() => {
                    model.focusPath(path);
                    model.options.onSelectionChange?.([path]);
                  }}
                >
                  {path}
                </button>
              </li>
            ))}
          </ul>
          <div data-testid="tree-folders">
            {folders.map(([path, decoration]) =>
              decoration === null ? null : (
                // Like Pierre, it draws the parts when there are some, and the text otherwise.
                <span key={path} data-path={path} title={decoration.title}>
                  {(decoration.parts ?? [{ text: decoration.text }]).map((part, index) => (
                    <span key={index} data-color={part.color}>
                      {part.text}
                    </span>
                  ))}
                </span>
              )
            )}
          </div>
        </>
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
  images: { byUrl: {}, byAttachment: {} },
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
  pullRequest?: PullRequestRef;
  themeKind?: 'light' | 'dark';
  files?: PullRequestFile[];
  threads?: ListState<ReviewThread>;
  commits?: ListState<Commit>;
  commit?: string;
  truncatedReviewComments?: number;
  truncatedCommits?: number;
};

// The panel keeps the chosen commit; this stands in for it.
function Holder({
  pullRequest = REF,
  files,
  threads,
  commits,
  initial,
  truncatedReviewComments,
  truncatedCommits,
}: Omit<Options, 'themeKind' | 'commit'> & { initial?: string }) {
  const [chosen, setChosen] = useState(initial);
  return (
    <CodeTab
      pullRequest={pullRequest}
      files={files ?? FILES}
      threads={threads ?? loaded<ReviewThread>([])}
      commits={commits ?? loaded(COMMITS)}
      commit={chosen}
      onCommitChange={setChosen}
      truncatedReviewComments={truncatedReviewComments}
      truncatedCommits={truncatedCommits}
    />
  );
}

const show = (
  { themeKind, commit, ...options }: Options = {},
  client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } }),
  server?: MindroomServer,
  serverPending = false
) => {
  return renderPluginComponent(
    <QueryClientProvider client={client}>
      <GitHubServerContext.Provider value={{ server, pending: serverPending }}>
        <Holder {...options} initial={commit} />
      </GitHubServerContext.Provider>
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
  fileDiff: FileDiffMetadata;
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
// The changed lines the tree shows on its folders, by folder, the parts it draws apart by a space.
const folderLines = (tab: TabView) =>
  Object.fromEntries(
    [...tab.getByTestId('tree-folders').querySelectorAll<HTMLElement>('[data-path]')].map(
      (folder) => [
        folder.dataset.path,
        [...folder.children].map((part) => part.textContent).join(' '),
      ]
    )
  );
const folderColors = (tab: TabView, path: string) =>
  [
    ...tab
      .getByTestId('tree-folders')
      .querySelectorAll<HTMLElement>(`[data-path="${path}"] > [data-color]`),
  ].map((part) => [part.textContent, part.dataset.color]);

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
  describe('blob hydration', () => {
    const request = { owner: 'meadow-labs', repo: 'seedling-demo', number: 17 };
    const sha = 'a'.repeat(40);
    const otherSha = 'b'.repeat(40);
    const endpoint = `https://api.github.com/repos/${request.owner}/${request.repo}/git/blobs/`;
    const tokenKey = 'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/githubToken';
    const markKey = `mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/viewed:${request.owner}/${request.repo}#${request.number}`;
    const testFile = file({
      path: greenhousePath,
      sha,
      patch: greenhousePatch,
      additions: 2,
      deletions: 2,
    });
    const other = file({ ...testFile, path: 'seedlings.py', sha: otherSha });
    const blobCalls = () =>
      fetchMock.mock.calls.filter(([url]) => url.includes('/git/blobs/')).map(([url]) => url);
    const response = (text = greenhouseAfter) => new Response(text);
    const loader = () => options().loadDiffFiles as FileDiffContentsLoader | undefined;

    it('makes zero passive blob requests on mount, unfold, or re-render and keeps loadDiffFiles stable', async () => {
      localStorage.setItem(tokenKey, 'e2e-token');
      localStorage.setItem(markKey, JSON.stringify({ [greenhousePath]: fnv1a32(greenhousePatch) }));
      fetchMock.mockImplementation(async () => response());
      const tab = await show({ files: [testFile, other], pullRequest: request });
      expect(options().onPostRender).toBeUndefined();
      expect(tab.getByTestId(`partial:${greenhousePath}`)).toBeTruthy();
      expect(tab.getByTestId(`partial:${other.path}`)).toBeTruthy();
      const firstLoader = loader();
      expect(firstLoader).toBeTypeOf('function');
      expect(blobCalls()).toEqual([]);

      // Unfolding a viewed file and toggling the tree still trigger zero passive blob reads and
      // preserve the exact `loadDiffFiles` function identity for Pierre's `areOptionsEqual`.
      await click(foldToggle(tab, greenhousePath));
      await click(tab.getByRole('button', { name: 'Files' }));
      expect(blobCalls()).toEqual([]);
      expect(loader()).toBe(firstLoader);
    });

    it('passes loadDiffFiles only when authenticated GitHub access is ready', async () => {
      const anonymous = await show({ files: [testFile], pullRequest: request });
      expect(loader()).toBeUndefined();
      expect(blobCalls()).toEqual([]);
      anonymous.unmount();

      const pending = await show(
        { files: [testFile], pullRequest: request },
        new QueryClient(),
        undefined,
        true
      );
      expect(loader()).toBeUndefined();
      pending.unmount();

      localStorage.setItem(tokenKey, 'e2e-token');
      const withToken = await show({ files: [testFile], pullRequest: request });
      expect(loader()).toBeTypeOf('function');
      withToken.unmount();
    });

    it('fetches only the clicked file blob, reconstructs oldFile, and retains nothing in React Query', async () => {
      localStorage.setItem(tokenKey, 'e2e-token');
      fetchMock.mockImplementation(async (url) =>
        url === endpoint + sha ? response() : respond({}, 404)
      );
      const client = new QueryClient();
      await show({ files: [testFile, other], pullRequest: request }, client);
      expect(blobCalls()).toEqual([]);

      const loadedFiles = await loader()!(itemOf(greenhousePath)!.fileDiff);
      expect(loadedFiles).toEqual({
        oldFile: { name: greenhousePath, contents: greenhouseBefore },
        newFile: { name: greenhousePath, contents: greenhouseAfter },
      });
      expect(blobCalls()).toEqual([endpoint + sha]);
      expect(client.getQueryCache().findAll({ queryKey: ['pull-requests', 'blob'] })).toEqual([]);
    });

    it('uses prevName ?? name for renamed files in a commit view without passive fetches', async () => {
      localStorage.setItem(tokenKey, 'e2e-token');
      const shaOfCommit = commit(2).sha;
      fetchMock.mockImplementation(async (url) => {
        if (url.endsWith(`/commits/${shaOfCommit}`))
          return respond({
            files: [
              {
                filename: greenhousePath,
                previous_filename: 'orchard.py',
                status: 'renamed',
                sha,
                additions: 2,
                deletions: 2,
                patch: greenhousePatch,
              },
            ],
          });
        return url === endpoint + sha ? response() : respond({}, 404);
      });
      const tab = await show({ commit: shaOfCommit, pullRequest: request });
      await tab.findByTestId(`partial:${greenhousePath}`);
      expect(blobCalls()).toEqual([]);

      const loadedFiles = await loader()!(itemOf(greenhousePath)!.fileDiff);
      expect(loadedFiles).toEqual({
        oldFile: { name: 'orchard.py', contents: greenhouseBefore },
        newFile: { name: greenhousePath, contents: greenhouseAfter },
      });
      expect(blobCalls()).toEqual([endpoint + sha]);
    });

    it('loads a diff blob on demand through the MindRoom server proxy', async () => {
      const upstream = githubServer(async (url) =>
        url === endpoint + sha ? response() : respond({}, 404)
      );
      await show({ files: [testFile], pullRequest: request }, new QueryClient(), upstream.server);
      await act(async () => {
        await vi.waitFor(() => expect(loader()).toBeTypeOf('function'));
      });
      expect(upstream.githubRequests()).toEqual([]);

      const loadedFiles = await loader()!(itemOf(greenhousePath)!.fileDiff);
      expect(loadedFiles).toEqual({
        oldFile: { name: greenhousePath, contents: greenhouseBefore },
        newFile: { name: greenhousePath, contents: greenhouseAfter },
      });
      expect(upstream.githubRequests()).toEqual([
        {
          path: new URL(endpoint + sha).pathname,
          method: 'GET',
          accept: 'application/vnd.github.raw+json',
          max_bytes: 128 * 1024,
        },
      ]);
    });

    it('rejects cleanly on missing SHA, >128 KiB, LFS, mismatch, auth failure, and retries after transient failure', async () => {
      localStorage.setItem(tokenKey, 'retry-blob-fixture');
      const noSha = file({ ...testFile, path: 'no-sha.py', sha: null });
      const oversized = file({ ...testFile, path: 'huge.py', sha: '1'.repeat(40) });
      const lfs = file({ ...testFile, path: 'lfs.py', sha: '2'.repeat(40) });
      const mismatch = file({ ...testFile, path: 'mismatch.py', sha: '3'.repeat(40) });
      const flaky = file({ ...testFile, path: 'flaky.py', sha: '4'.repeat(40) });
      let flakyAttempts = 0;
      fetchMock.mockImplementation(async (url) => {
        if (url === endpoint + oversized.sha) return response('x'.repeat(128 * 1024 + 1));
        if (url === endpoint + lfs.sha)
          return response('version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 10\n');
        if (url === endpoint + mismatch.sha) return response(greenhouseBefore);
        if (url === endpoint + flaky.sha) {
          flakyAttempts += 1;
          return flakyAttempts === 1 ? respond({}, 500) : response();
        }
        return respond({}, 404);
      });
      const tab = await show({
        files: [noSha, oversized, lfs, mismatch, flaky],
        pullRequest: request,
      });
      const expand = async (diff: FileDiffMetadata) => {
        let error: unknown;
        let result: Awaited<ReturnType<FileDiffContentsLoader>> | undefined;
        await act(async () => {
          try {
            result = await loader()!(diff);
          } catch (caught) {
            error = caught;
          }
        });
        if (error !== undefined) throw error;
        return result!;
      };

      await expect(expand(itemOf(noSha.path)!.fileDiff)).rejects.toThrow();
      expect(blobCalls()).toEqual([]);
      expect(tab.getByRole('status').textContent).toBe('Full context unavailable for no-sha.py.');

      await expect(expand(itemOf(oversized.path)!.fileDiff)).rejects.toThrow();
      expect(tab.getByRole('status').textContent).toBe('Full context unavailable for huge.py.');
      // Repeat click on a deterministic unavailable SHA reuses the session cache without re-fetching.
      const callsAfterOversized = blobCalls().length;
      await expect(expand(itemOf(oversized.path)!.fileDiff)).rejects.toThrow();
      expect(blobCalls()).toHaveLength(callsAfterOversized);
      expect(tab.getByRole('status').textContent).toBe('Full context unavailable for huge.py.');

      await expect(expand(itemOf(lfs.path)!.fileDiff)).rejects.toThrow();
      expect(tab.getByRole('status').textContent).toBe('Full context unavailable for lfs.py.');

      await expect(expand(itemOf(mismatch.path)!.fileDiff)).rejects.toThrow();
      expect(tab.getByRole('status').textContent).toBe('Full context unavailable for mismatch.py.');

      // A transient 500 shows the notice, then retrying once the server recovers clears it.
      await expect(expand(itemOf(flaky.path)!.fileDiff)).rejects.toThrow();
      expect(itemOf(flaky.path)!.fileDiff.isPartial).toBe(true);
      expect(tab.getByRole('status').textContent).toBe('Full context unavailable for flaky.py.');
      await expect(expand(itemOf(flaky.path)!.fileDiff)).resolves.toEqual({
        oldFile: { name: flaky.path, contents: greenhouseBefore },
        newFile: { name: flaky.path, contents: greenhouseAfter },
      });
      expect(tab.queryByRole('status')).toBeNull();

      // An upstream 401 auth failure rejects and shows the notice; switching commits clears it.
      fetchMock.mockImplementationOnce(async () => respond({}, 401));
      await expect(expand(itemOf(flaky.path)!.fileDiff)).rejects.toThrow();
      expect(tab.getByRole('status').textContent).toBe('Full context unavailable for flaky.py.');
      fetchMock.mockImplementationOnce(async () =>
        respond({ sha: commit(2).sha, files: COMMIT_FILES })
      );
      await chooseCommit(tab, /^Commit 2/);
      expect(await tab.findByText('2 files')).toBeTruthy();
      expect(tab.queryByRole('status')).toBeNull();
      await chooseCommit(tab, 'All commits');

      // Removing the stored token before invoking rejects cleanly without mutating the diff.
      localStorage.removeItem(tokenKey);
      await expect(expand(itemOf(flaky.path)!.fileDiff)).rejects.toThrow();
      expect(itemOf(flaky.path)!.fileDiff.isPartial).toBe(true);
    });

    it('deduplicates concurrent requests for the same SHA, caps concurrency at four, and aborts queued reads on unmount', async () => {
      localStorage.setItem(tokenKey, 'e2e-token');
      const duplicate = file({ ...testFile, path: 'duplicate.py', sha });
      const extra = Array.from({ length: 5 }, (_, index) =>
        file({ ...testFile, path: `bed_${index}.py`, sha: `${index + 1}`.repeat(40) })
      );
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const aborted: string[] = [];
      fetchMock.mockImplementation(
        (url, init) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              aborted.push(url);
              reject(init.signal?.reason ?? new Error('aborted'));
            });
            void waiting.then(() => {
              if (!init?.signal?.aborted) resolve(response());
            });
          })
      );
      const tab = await show({ files: [testFile, duplicate, ...extra], pullRequest: request });
      const load = loader()!;

      // Two files sharing `sha` issue only one fetch; 5 more files queue behind the cap of 4.
      const first = load(itemOf(greenhousePath)!.fileDiff);
      const second = load(itemOf(duplicate.path)!.fileDiff);
      const rest = extra.map((entry) => load(itemOf(entry.path)!.fileDiff));
      expect(blobCalls()).toEqual([
        endpoint + sha,
        ...extra.slice(0, 3).map(({ sha: entrySha }) => endpoint + entrySha),
      ]);

      // Unmounting aborts the four active reads and cancels the queued ones without fetching them.
      tab.unmount();
      release();
      const settled = await Promise.allSettled([first, second, ...rest]);
      expect(settled.every((result) => result.status === 'rejected')).toBe(true);
      expect(aborted).toHaveLength(4);
      expect(blobCalls()).toEqual([
        endpoint + sha,
        ...extra.slice(0, 3).map(({ sha: entrySha }) => endpoint + entrySha),
      ]);
    });

    it('hydrates cleanly with ignoreWhitespace enabled against real @pierre/diffs hydratePartialDiff', async () => {
      localStorage.setItem(tokenKey, 'e2e-token');
      const wsPatch = greenhousePatch.replace('+    return COUNT + 2', '+    return  COUNT + 1');
      const wsBlob = greenhouseAfter.replace('return COUNT + 2', 'return  COUNT + 1');
      const wsFile = file({ ...testFile, patch: wsPatch });
      fetchMock.mockImplementation(async (url) =>
        url === endpoint + sha ? response(wsBlob) : respond({}, 404)
      );
      const tab = await show({ files: [wsFile], pullRequest: request });
      await click(tab.getByRole('button', { name: 'Hide whitespace changes' }));

      const diff = itemOf(greenhousePath)!.fileDiff;
      expect(diff.isPartial).toBe(true);
      expect(diff.cacheKey).toMatch(/:ignore-whitespace$/);
      const loadedFiles = await loader()!(diff);
      const hydrated = hydratePartialDiff('clone', diff, loadedFiles);
      expect(hydrated.isPartial).toBe(false);
      expect(getDiffLineStat([hydrated])).toEqual({ additions: 1, deletions: 1 });
      expect(hydrated.hunks[1]?.collapsedBefore).toBe(6);
      expect(hydrated.hunks[1]?.hunkContent).toEqual([
        { type: 'context', lines: 6, additionLineIndex: 8, deletionLineIndex: 8 },
      ]);
    });

    it('yields fresh unmutated partial diffs across ignoreWhitespace, commit, and credential changes', async () => {
      localStorage.setItem(tokenKey, 'token-one');
      fetchMock.mockImplementation(async (url) => {
        if (url.endsWith(`/commits/${commit(2).sha}`)) {
          return respond({
            sha: commit(2).sha,
            files: [
              {
                filename: greenhousePath,
                status: 'modified',
                sha,
                additions: 2,
                deletions: 2,
                patch: greenhousePatch,
              },
            ],
          });
        }
        return url === endpoint + sha ? response() : respond({}, 404);
      });
      const tab = await show({ files: [testFile, other], pullRequest: request });

      // Simulate Pierre's in-place `Object.assign(fileDiff, hydratePartialDiff(...))` mutation.
      const hydrateInPlace = async () => {
        const current = itemOf(greenhousePath)!.fileDiff;
        const loadedFiles = await loader()!(current);
        Object.assign(current, hydratePartialDiff('clone', current, loadedFiles));
        return current;
      };

      const hydrated = await hydrateInPlace();
      expect(hydrated.isPartial).toBe(false);
      // Unrelated UI updates preserve the hydrated diff object in place.
      await click(viewedBox(tab, other.path));
      expect(itemOf(greenhousePath)!.fileDiff).toBe(hydrated);

      // Toggling ignoreWhitespace on and back off yields fresh partial diffs (never the mutated one).
      await click(tab.getByRole('button', { name: 'Hide whitespace changes' }));
      const wsDiff = itemOf(greenhousePath)!.fileDiff;
      expect(wsDiff).not.toBe(hydrated);
      expect(wsDiff.isPartial).toBe(true);
      await click(tab.getByRole('button', { name: 'Hide whitespace changes' }));
      const restored = itemOf(greenhousePath)!.fileDiff;
      expect(restored).not.toBe(hydrated);
      expect(restored.isPartial).toBe(true);

      // Switching commits yields a fresh partial diff with a view-scoped cacheKey.
      const hydratedBeforeCommit = await hydrateInPlace();
      await chooseCommit(tab, /^Commit 2/);
      await tab.findByTestId(`partial:${greenhousePath}`);
      const commitDiff = itemOf(greenhousePath)!.fileDiff;
      expect(commitDiff).not.toBe(hydratedBeforeCommit);
      expect(commitDiff.isPartial).toBe(true);
      expect(commitDiff.cacheKey).not.toBe(hydratedBeforeCommit.cacheKey);

      // Switching back to All commits also yields a fresh partial diff.
      await chooseCommit(tab, 'All commits');
      expect(itemOf(greenhousePath)!.fileDiff.isPartial).toBe(true);

      // Replacing the browser token under the same access.key preserves hydrated diffs while
      // using the latest token for subsequent loads.
      const hydratedForTokenOne = await hydrateInPlace();
      await act(async () => {
        localStorage.setItem(tokenKey, 'token-two');
        window.dispatchEvent(new StorageEvent('storage', { key: tokenKey }));
      });
      expect(itemOf(greenhousePath)!.fileDiff).toBe(hydratedForTokenOne);
      fetchMock.mockClear();
      fetchMock.mockImplementation(async (url) =>
        url === endpoint + otherSha ? response() : respond({}, 404)
      );
      await loader()!(itemOf(other.path)!.fileDiff);
      const authHeader = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization');
      expect(authHeader).toBe('Bearer token-two');

      // Signing out changes access.key and yields a fresh partial diff with a distinct cacheKey.
      await act(async () => {
        localStorage.removeItem(tokenKey);
        window.dispatchEvent(new StorageEvent('storage', { key: tokenKey }));
      });
      const anonDiff = itemOf(greenhousePath)!.fileDiff;
      expect(anonDiff).not.toBe(hydratedForTokenOne);
      expect(anonDiff.isPartial).toBe(true);
      expect(anonDiff.cacheKey).not.toBe(hydratedForTokenOne.cacheKey);
      expect(loader()).toBeUndefined();
    });

    it('expands a Pierre-retained fileDiff after a binary-only files refresh without aborting in-flight reads', async () => {
      localStorage.setItem(tokenKey, 'e2e-token');
      const client = new QueryClient();
      const binaryBefore = file({ path: 'logo.png', patch: null, sha: '1'.repeat(40) });
      const binaryAfter = file({ path: 'logo.png', patch: null, sha: '2'.repeat(40) });
      let releaseInFlight!: () => void;
      const waiting = new Promise<void>((resolve) => {
        releaseInFlight = resolve;
      });
      fetchMock.mockImplementation(async (url, init) => {
        if (url === endpoint + otherSha) {
          await new Promise<void>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            void waiting.then(resolve);
          });
          return response();
        }
        return url === endpoint + sha ? response() : respond({}, 404);
      });
      const renderWith = (files: PullRequestFile[]) => (
        <QueryClientProvider client={client}>
          <GitHubServerContext.Provider value={{ server: undefined, pending: false }}>
            <Holder files={files} pullRequest={request} />
          </GitHubServerContext.Provider>
        </QueryClientProvider>
      );
      const tab = await renderPluginComponent(renderWith([testFile, other, binaryBefore]), {
        id: 'pull-requests',
        plugin,
        themeKind: 'light',
      });
      const retainedDiff = itemOf(greenhousePath)!.fileDiff;
      const beforeVersion = versionOf(greenhousePath);
      const inFlightOther = loader()!(itemOf(other.path)!.fileDiff);

      // Refresh `files` with only a binary file change; unchanged text files keep their version.
      await act(async () => {
        tab.rerender(renderWith([testFile, other, binaryAfter]));
      });
      expect(versionOf(greenhousePath)).toBe(beforeVersion);

      // Invoking `loadDiffFiles` with Pierre's retained `fileDiff` from before the refresh succeeds.
      await expect(loader()!(retainedDiff)).resolves.toEqual({
        oldFile: { name: greenhousePath, contents: greenhouseBefore },
        newFile: { name: greenhousePath, contents: greenhouseAfter },
      });

      // The in-flight expansion of `other` was not aborted by the binary-only refresh.
      releaseInFlight();
      await expect(inFlightOther).resolves.toEqual({
        oldFile: { name: other.path, contents: greenhouseBefore },
        newFile: { name: other.path, contents: greenhouseAfter },
      });
      expect(blobCalls()).toEqual([endpoint + otherSha, endpoint + sha]);
    });

    it('bumps cacheKey and version when a file sha changes with the same patch and loads the new sha', async () => {
      localStorage.setItem(tokenKey, 'e2e-token');
      const client = new QueryClient();
      const rebasedAfter = greenhouseAfter.replace('fresh soil', 'fresh compost');
      const rebasedBefore = greenhouseBefore.replace('fresh soil', 'fresh compost');
      fetchMock.mockImplementation(async (url) => {
        if (url === endpoint + sha) return response(greenhouseAfter);
        if (url === endpoint + otherSha) return response(rebasedAfter);
        return respond({}, 404);
      });
      const renderWith = (files: PullRequestFile[]) => (
        <QueryClientProvider client={client}>
          <GitHubServerContext.Provider value={{ server: undefined, pending: false }}>
            <Holder files={files} pullRequest={request} />
          </GitHubServerContext.Provider>
        </QueryClientProvider>
      );
      const tab = await renderPluginComponent(renderWith([testFile]), {
        id: 'pull-requests',
        plugin,
        themeKind: 'light',
      });
      const oldDiff = itemOf(greenhousePath)!.fileDiff;
      const oldVersion = versionOf(greenhousePath);
      const oldFiles = await loader()!(oldDiff);
      Object.assign(oldDiff, hydratePartialDiff('clone', oldDiff, oldFiles));
      expect(oldDiff.isPartial).toBe(false);

      // Rebase changes the blob SHA while keeping the patch hunks identical.
      await act(async () => {
        tab.rerender(renderWith([file({ ...testFile, sha: otherSha })]));
      });
      const newDiff = itemOf(greenhousePath)!.fileDiff;
      expect(newDiff.isPartial).toBe(true);
      expect(newDiff.cacheKey).not.toBe(oldDiff.cacheKey);
      expect(versionOf(greenhousePath)).not.toBe(oldVersion);

      // The stale diff rejects; expanding the refreshed item loads the new blob SHA.
      await expect(loader()!(oldDiff)).rejects.toThrow();
      await expect(loader()!(newDiff)).resolves.toEqual({
        oldFile: { name: greenhousePath, contents: rebasedBefore },
        newFile: { name: greenhousePath, contents: rebasedAfter },
      });
      expect(blobCalls()).toEqual([endpoint + sha, endpoint + otherSha]);
    });

    it('bounds pull request and commit file list cache retention to 60 seconds', async () => {
      const client = new QueryClient();
      const shaOfCommit = commit(2).sha;
      const Probe = () => {
        usePullRequestFiles(REF, true);
        return null;
      };
      fetchMock.mockImplementation(async (url) => {
        if (url.includes(`/commits/${shaOfCommit}`))
          return respond({ sha: shaOfCommit, files: COMMIT_FILES });
        if (url.includes('/files')) return respond([]);
        return respond({}, 404);
      });
      const probe = await renderPluginComponent(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
        { id: 'pull-requests', plugin }
      );
      const tab = await show({ commit: shaOfCommit }, client);
      await tab.findByText('2 files');
      const queries = client.getQueryCache().findAll({ queryKey: ['pull-requests', 'pr'] });
      const prFiles = queries.find((query) => query.queryKey.at(-1) === 'files');
      const commitFiles = queries.find((query) => query.queryKey.at(-2) === 'commit-files');
      expect(prFiles?.gcTime).toBe(60_000);
      expect(commitFiles?.gcTime).toBe(60_000);
      probe.unmount();
    });

    it('preserves fileDiff object identity on unchanged source files across hideTests toggles', async () => {
      localStorage.setItem(tokenKey, 'e2e-token');
      const testDiff = file({ ...testFile, path: 'greenhouse.test.py', sha: otherSha });
      fetchMock.mockImplementation(async (url) =>
        url === endpoint + sha ? response() : respond({}, 404)
      );
      const tab = await show({ files: [testFile, testDiff], pullRequest: request });
      const before = itemOf(greenhousePath)!.fileDiff;

      await click(foldToggle(tab, greenhousePath));
      expect(itemOf(greenhousePath)?.collapsed).toBe(true);
      await click(tab.getByRole('button', { name: 'Hide test files' }));
      expect(itemOf(greenhousePath)!.fileDiff).toBe(before);
      await click(tab.getByRole('button', { name: 'Hide test files' }));
      expect(itemOf(greenhousePath)!.fileDiff).toBe(before);

      await click(foldToggle(tab, greenhousePath));
      await expect(loader()!(itemOf(greenhousePath)!.fileDiff)).resolves.toEqual({
        oldFile: { name: greenhousePath, contents: greenhouseBefore },
        newFile: { name: greenhousePath, contents: greenhouseAfter },
      });
      expect(blobCalls()).toEqual([endpoint + sha]);
    });
  });

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
    await click(tab.getByRole('treeitem', { name: 'README.md' }));
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
    await click(tab.getByRole('treeitem', { name: 'logo.png' }));
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

  describe('responsive Files tree', () => {
    let codeWidth = 400;
    let diffsHeight = 600;
    let clientWidth: { mockRestore(): void } | undefined;
    let clientHeight: { mockRestore(): void } | undefined;
    let observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
    beforeEach(() => {
      codeWidth = 400;
      diffsHeight = 600;
      observers = [];
      clientWidth = vi
        .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.classList.contains('mrpr-code') ? codeWidth : 0;
        });
      clientHeight = vi
        .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.classList.contains('mrpr-code-diffs') ? diffsHeight : 0;
        });
      vi.stubGlobal(
        'ResizeObserver',
        class {
          private readonly entry: (typeof observers)[number];
          constructor(callback: ResizeObserverCallback) {
            this.entry = { callback, targets: new Set() };
            observers.push(this.entry);
          }
          observe(target: Element) {
            this.entry.targets.add(target);
          }
          unobserve(target: Element) {
            this.entry.targets.delete(target);
          }
          disconnect() {
            this.entry.targets.clear();
          }
        }
      );
    });
    afterEach(() => {
      clientWidth?.mockRestore();
      clientHeight?.mockRestore();
    });
    const resizeCode = (width: number) =>
      act(async () => {
        codeWidth = width;
        for (const { callback, targets } of observers) {
          const code = [...targets].find((target) => target.classList.contains('mrpr-code'));
          if (code) {
            callback(
              [{ target: code, contentRect: { width } } as unknown as ResizeObserverEntry],
              {} as ResizeObserver
            );
          }
        }
      });

    it('renders stacked tree collapsed inside CodeView header when narrow and switches cleanly across 640px', async () => {
      const tab = await show();
      const diffView = tab.getByTestId('diff-view');
      const stackedList = tab.getByRole('list', { name: /^Files of/ });
      expect(diffView.contains(stackedList)).toBe(true);
      expect(stackedList.getAttribute('data-initial-expansion')).toBe('closed');
      expect(tab.container.querySelector('.mrpr-code-tree')).toBeNull();
      expect(
        (tab.container.querySelector('.mrpr-code-diffs') as HTMLElement).style.getPropertyValue(
          '--mrpr-stacked-tree-max-height'
        )
      ).toBe('270px');

      const goToFiles = tab.getByRole('button', { name: 'Go to files' });
      expect(goToFiles.getAttribute('aria-pressed')).toBeNull();
      await click(goToFiles);
      expect(view.scrollTo).toHaveBeenCalledWith({
        type: 'position',
        position: 0,
        behavior: 'smooth',
      });
      expect(diffView.contains(document.activeElement)).toBe(true);

      // Widening across 640px moves the tree to the side-by-side column with folders expanded
      // and stops observing .mrpr-code-diffs for stacked height bounds.
      await resizeCode(640);
      expect(
        (tab.container.querySelector('.mrpr-code-diffs') as HTMLElement).style.getPropertyValue(
          '--mrpr-stacked-tree-max-height'
        )
      ).toBe('');
      expect(
        observers.some(({ targets }) =>
          [...targets].some((target) => target.classList.contains('mrpr-code-diffs'))
        )
      ).toBe(false);
      const toggle = tab.getByRole('button', { name: 'Files' });
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      const wideList = tab.getByRole('list', { name: /^Files of/ });
      expect(diffView.contains(wideList)).toBe(false);
      expect(wideList.getAttribute('data-initial-expansion')).toBe('open');

      // Hiding the wide sidebar persists when returning to wide after visiting stacked.
      await click(toggle);
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      expect(tab.queryByRole('list', { name: /^Files of/ })).toBeNull();

      // Fractional widths below 640px switch back to stacked inside CodeView header.
      await resizeCode(639.5);
      expect(tab.getByRole('button', { name: 'Go to files' })).toBeTruthy();
      expect(diffView.contains(tab.getByRole('list', { name: /^Files of/ }))).toBe(true);

      await resizeCode(700);
      expect(tab.getByRole('button', { name: 'Files' }).getAttribute('aria-pressed')).toBe('false');
      expect(tab.queryByRole('list', { name: /^Files of/ })).toBeNull();
    });

    it('starts open side-by-side when wide (>= 640px)', async () => {
      codeWidth = 640;
      const tab = await show();
      const diffView = tab.getByTestId('diff-view');
      expect(tab.getByRole('button', { name: 'Files' }).getAttribute('aria-pressed')).toBe('true');
      const list = tab.getByRole('list', { name: /^Files of/ });
      expect(diffView.contains(list)).toBe(false);
      expect(list.getAttribute('data-initial-expansion')).toBe('open');
    });

    it('disables Go to files when no CodeView is mounted and uses instant scroll under reduced motion', async () => {
      const emptyTab = await show({ files: [] });
      const disabledButton = emptyTab.getByRole('button', {
        name: 'Go to files',
      }) as HTMLButtonElement;
      expect(disabledButton.disabled).toBe(true);
      await act(async () => emptyTab.unmount());

      vi.stubGlobal('matchMedia', () => ({ matches: true }));
      const tab = await show();
      // Verify selector priority: active [role="treeitem"][tabindex="0"] beats its ancestor [role="tree"]
      // and earlier [role="treeitem"][tabindex="-1"] rows inside Pierre's shadow root.
      const host = document.createElement('file-tree-container');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML =
        '<div role="tree" tabindex="-1">' +
        '<button type="button" role="treeitem" tabindex="-1">first</button>' +
        '<button type="button" role="treeitem" tabindex="0">active</button>' +
        '</div>';
      const stackedTree = tab.container.querySelector('.mrpr-code-tree-stacked .mrpr-tree')!;
      stackedTree.appendChild(host);
      const [firstRow, activeRow] = shadow.querySelectorAll<HTMLElement>('[role="treeitem"]');

      await click(tab.getByRole('button', { name: 'Go to files' }));
      expect(view.scrollTo).toHaveBeenCalledWith({
        type: 'position',
        position: 0,
        behavior: 'instant',
      });
      expect(shadow.activeElement).toBe(activeRow);

      // Without a tabindex="0" row, falls back to the first [role="treeitem"] rather than [role="tree"].
      activeRow!.setAttribute('tabindex', '-1');
      await click(tab.getByRole('button', { name: 'Go to files' }));
      expect(shadow.activeElement).toBe(firstRow);
    });

    it('moves focus to the Files button when resizing across 640px unmounts a focused tree', async () => {
      codeWidth = 640;
      const tab = await show();
      const fileButton = tab.getByRole('treeitem', { name: 'src/app.ts' });
      act(() => fileButton.focus());
      expect(document.activeElement).toBe(fileButton);

      await resizeCode(500);
      expect(document.activeElement).toBe(tab.getByRole('button', { name: 'Go to files' }));

      const stackedButton = tab.getByRole('treeitem', { name: 'src/app.ts' });
      act(() => stackedButton.focus());
      await resizeCode(700);
      expect(document.activeElement).toBe(tab.getByRole('button', { name: 'Files' }));

      // Focus outside the tree stays untouched across resizes.
      const wrapButton = tab.getByRole('button', { name: 'Wrap lines' });
      act(() => wrapButton.focus());
      await resizeCode(600);
      expect(document.activeElement).toBe(wrapButton);
    });

    it('moves focus from the stacked tree to the revealed diff on Enter and returns via Go to files', async () => {
      Element.prototype.scrollIntoView = vi.fn();
      const tab = await show();
      const stackedTree = tab.container.querySelector('.mrpr-code-tree-stacked')!;
      const readmeRow = tab.getByRole('treeitem', { name: 'README.md' });
      act(() => readmeRow.focus());
      expect(document.activeElement).toBe(readmeRow);

      await act(async () => {
        readmeRow.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        );
      });
      expect(view.scrollTo).toHaveBeenCalledWith({
        type: 'item',
        id: 'README.md',
        align: 'start',
      });
      expect(stackedTree.contains(document.activeElement)).toBe(false);
      expect(document.activeElement).toBe(foldToggle(tab, 'README.md'));
      expect(readmeRow.getAttribute('tabindex')).toBe('0');

      await click(tab.getByRole('button', { name: 'Go to files' }));
      expect(document.activeElement).toBe(readmeRow);

      // Activating a patchless file in the stacked tree moves focus to its footer row.
      const logoRow = tab.getByRole('treeitem', { name: 'logo.png' });
      act(() => logoRow.focus());
      await act(async () => {
        logoRow.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        );
      });
      expect(stackedTree.contains(document.activeElement)).toBe(false);
      expect(document.activeElement).toBe(tab.getByText('No diff to show').closest('li'));

      await click(tab.getByRole('button', { name: 'Go to files' }));
      expect(document.activeElement).toBe(logoRow);

      // Wide desktop sidebar keeps focus on the tree item when activating a file.
      await resizeCode(640);
      const wideReadme = tab.getByRole('treeitem', { name: 'README.md' });
      act(() => wideReadme.focus());
      await act(async () => {
        wideReadme.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        );
      });
      expect(document.activeElement).toBe(wideReadme);
    });

    it('falls back on one animation frame for virtualized stacked reveals and cancels pending frames', async () => {
      let nextId = 1;
      const frames = new Map<number, FrameRequestCallback>();
      const requestFrame = vi.fn((cb: FrameRequestCallback) => {
        const id = nextId++;
        frames.set(id, cb);
        return id;
      });
      const cancelFrame = vi.fn((id: number) => {
        frames.delete(id);
      });
      vi.stubGlobal('requestAnimationFrame', requestFrame);
      vi.stubGlobal('cancelAnimationFrame', cancelFrame);
      const flushFrames = () =>
        act(async () => {
          for (const [id, cb] of [...frames]) {
            frames.delete(id);
            cb(0);
          }
        });

      const tab = await show();
      const diffs = tab.container.querySelector<HTMLElement>('.mrpr-code-diffs')!;

      // 1. Virtualized diff header still not mounted by rAF falls back to .mrpr-code-diffs.
      const appToggle = foldToggle(tab, 'src/app.ts');
      const appHeader = appToggle.parentElement!;
      appToggle.remove();
      const appRow = tab.getByRole('treeitem', { name: 'src/app.ts' });
      act(() => appRow.focus());
      await click(appRow);
      expect(document.activeElement).toBe(appRow);
      await flushFrames();
      expect(document.activeElement).toBe(diffs);

      // 2. Virtualized diff header mounted before rAF receives focus instead of the container.
      const newToggle = foldToggle(tab, 'src/new.ts');
      const newHeader = newToggle.parentElement!;
      newToggle.remove();
      const newRow = tab.getByRole('treeitem', { name: 'src/new.ts' });
      act(() => newRow.focus());
      await click(newRow);
      newHeader.prepend(newToggle);
      await flushFrames();
      expect(document.activeElement).toBe(newToggle);
      appHeader.prepend(appToggle);

      // 3. If the tree reclaims focus after onSelectionChange, rAF moves it back to the diff control.
      const readmeRow = tab.getByRole('treeitem', { name: 'README.md' });
      act(() => readmeRow.focus());
      await click(readmeRow);
      expect(document.activeElement).toBe(foldToggle(tab, 'README.md'));
      act(() => readmeRow.focus());
      await flushFrames();
      expect(document.activeElement).toBe(foldToggle(tab, 'README.md'));

      // 4. Go to files cancels any pending reveal focus frame so focus stays on the tree row.
      const oldToggle = foldToggle(tab, 'old.ts');
      oldToggle.remove();
      const oldRow = tab.getByRole('treeitem', { name: 'old.ts' });
      act(() => oldRow.focus());
      await click(oldRow);
      expect(frames.size).toBe(1);
      await click(tab.getByRole('button', { name: 'Go to files' }));
      expect(cancelFrame).toHaveBeenCalled();
      expect(frames.size).toBe(0);
      expect(document.activeElement).toBe(oldRow);

      // 5. Unmounting cancels any pending reveal focus frame.
      await click(oldRow);
      expect(frames.size).toBe(1);
      await act(async () => tab.unmount());
      expect(frames.size).toBe(0);
    });
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

    it('a viewed file folds and opens with its mark, also one another tab sets', async () => {
      const key =
        'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/viewed:mindroom-ai/mindroom-chat#200';
      const patch = FILES[0]?.patch ?? '';
      // Another tab of the same account writes the marks, and this one hears of it.
      const markElsewhere = (paths: string[]) =>
        act(() => {
          if (paths.length === 0) localStorage.removeItem(key);
          else
            localStorage.setItem(
              key,
              JSON.stringify(Object.fromEntries(paths.map((path) => [path, fnv1a32(patch)])))
            );
          window.dispatchEvent(new StorageEvent('storage', { key }));
        });
      localStorage.setItem(key, JSON.stringify({ 'src/app.ts': fnv1a32(patch) }));
      const tab = await show();
      expect(viewedBox(tab, 'src/app.ts').checked).toBe(true);
      expect(itemOf('src/app.ts')?.collapsed).toBe(true);

      // Opened by hand, it stays open as it is unmarked, and folds as it is marked again.
      await click(foldToggle(tab, 'src/app.ts'));
      expect(itemOf('src/app.ts')?.collapsed).toBe(false);
      await click(viewedBox(tab, 'src/app.ts'));
      expect(viewedBox(tab, 'src/app.ts').checked).toBe(false);
      expect(itemOf('src/app.ts')?.collapsed).toBe(false);
      await click(viewedBox(tab, 'src/app.ts'));
      expect(itemOf('src/app.ts')?.collapsed).toBe(true);

      markElsewhere([]);
      expect(viewedBox(tab, 'src/app.ts').checked).toBe(false);
      expect(itemOf('src/app.ts')?.collapsed).toBe(false);
      markElsewhere(['src/app.ts', 'README.md']);
      expect(itemOf('src/app.ts')?.collapsed).toBe(true);
      expect(itemOf('README.md')?.collapsed).toBe(true);

      // Expand all files outranks the marks.
      await click(tab.getByRole('button', { name: 'Collapse all files' }));
      await click(tab.getByRole('button', { name: 'Expand all files' }));
      expect(itemOf('src/app.ts')?.collapsed).toBe(false);
      tab.unmount();

      await show();
      expect(itemOf('src/app.ts')?.collapsed).toBe(true);
    });

    // The Code tab stays mounted while a push changes src/app.ts and its files load again.
    const showPushable = async () => {
      const client = new QueryClient();
      const at = (patch: string) => (
        <QueryClientProvider client={client}>
          <Holder
            files={FILES.map((entry) =>
              entry.path === 'src/app.ts' ? { ...entry, patch } : entry
            )}
          />
        </QueryClientProvider>
      );
      const tab = await renderPluginComponent(at(FILES[0]?.patch ?? ''), {
        id: 'pull-requests',
        plugin,
      });
      return { tab, push: () => tab.rerender(at('@@ -1 +1 @@\n-old\n+newer')) };
    };

    it('a viewed file a push changes opens, as Changed', async () => {
      const first = await show();
      await click(viewedBox(first, 'src/app.ts'));
      first.unmount();

      const { tab, push } = await showPushable();
      expect(itemOf('src/app.ts')?.collapsed).toBe(true);
      push();
      expect(viewedBox(tab, 'src/app.ts').getAttribute('aria-label')).toBe('Changed');
      expect(itemOf('src/app.ts')?.collapsed).toBe(false);
    });

    it('a push drops the fold a reader chose for the file it changes', async () => {
      const { tab, push } = await showPushable();
      // After Expand all files, marking a file viewed folds it as the reader's own choice.
      await click(tab.getByRole('button', { name: 'Collapse all files' }));
      await click(tab.getByRole('button', { name: 'Expand all files' }));
      await click(viewedBox(tab, 'src/app.ts'));
      await click(viewedBox(tab, 'README.md'));
      expect(itemOf('src/app.ts')?.collapsed).toBe(true);
      push();
      expect(viewedBox(tab, 'src/app.ts').getAttribute('aria-label')).toBe('Changed');
      expect(itemOf('src/app.ts')?.collapsed).toBe(false);
      // A file the push left as it was keeps its fold.
      expect(itemOf('README.md')?.collapsed).toBe(true);
    });

    it('a push drops the fold a reader set by hand on the file it changes', async () => {
      const { tab, push } = await showPushable();
      await click(viewedBox(tab, 'src/app.ts'));
      await click(foldToggle(tab, 'src/app.ts'));
      await click(foldToggle(tab, 'src/app.ts'));
      expect(itemOf('src/app.ts')?.collapsed).toBe(true);
      await click(foldToggle(tab, 'README.md'));
      expect(itemOf('README.md')?.collapsed).toBe(true);
      push();
      expect(viewedBox(tab, 'src/app.ts').getAttribute('aria-label')).toBe('Changed');
      expect(itemOf('src/app.ts')?.collapsed).toBe(false);
      expect(itemOf('README.md')?.collapsed).toBe(true);
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

    it("a folder's changed lines leave out the hidden test files", async () => {
      const tab = await show({
        files: [
          file({ path: 'src/lib/a.ts', additions: 1200, deletions: 2 }),
          file({ path: 'src/a.test.ts', additions: 30, deletions: 5 }),
          file({ path: 'docs/moved.md', status: 'renamed', additions: 0, deletions: 0 }),
          file({ path: 'README.md', additions: 100, deletions: 100 }),
        ],
      });
      // Root files count in no folder, and a folder with no changed lines shows none.
      expect(folderLines(tab)).toEqual({
        'src/': `+${(1230).toLocaleString()} -7`,
        'src/lib/': `+${(1200).toLocaleString()} -2`,
      });
      const src = tab.getByTestId('tree-folders').querySelector<HTMLElement>('[data-path="src/"]');
      expect(src?.title).toBe(`src: ${(1230).toLocaleString()} lines added, 7 removed`);
      expect(folderColors(tab, 'src/')).toEqual([
        [`+${(1230).toLocaleString()}`, 'var(--pr-added)'],
        ['-7', 'var(--pr-removed)'],
      ]);

      await click(tab.getByRole('button', { name: 'Hide test files' }));
      expect(folderLines(tab)).toEqual({
        'src/': `+${(1200).toLocaleString()} -2`,
        'src/lib/': `+${(1200).toLocaleString()} -2`,
      });
    });

    // Pierre draws its rows again for other paths or statuses, not for other counts alone.
    it("draws a folder's new lines when the same files come back with other counts", async () => {
      const client = new QueryClient();
      const ui = (additions: number, deletions: number) => (
        <QueryClientProvider client={client}>
          <Holder files={[file({ path: 'src/a.ts', additions, deletions })]} />
        </QueryClientProvider>
      );
      const tab = await renderPluginComponent(ui(1, 0), { id: 'pull-requests', plugin });
      expect(folderLines(tab)).toEqual({ 'src/': '+1 -0' });
      const src = () => tab.getByTestId('tree-folders').querySelector<HTMLElement>('[data-path]');
      expect(src()?.title).toBe('src: 1 line added, 0 removed');
      tab.rerender(ui(8, 4));
      expect(folderLines(tab)).toEqual({ 'src/': '+8 -4' });
      expect(src()?.title).toBe('src: 8 lines added, 4 removed');
    });

    // A narrow tree cuts a long or flattened folder's name; its tooltip names the whole folder.
    it("names the whole folder in its lines' tooltip", async () => {
      const tab = await show({
        files: [
          file({ path: 'packages/sdk/src/components/Button.tsx', additions: 2, deletions: 1 }),
          file({ path: 'src/a.ts', additions: 3, deletions: 0 }),
          file({ path: 'src/a.ts/b.ts', additions: 4, deletions: 2 }),
        ],
      });
      const titleOf = (path: string) =>
        tab.getByTestId('tree-folders').querySelector<HTMLElement>(`[data-path="${path}"]`)?.title;
      expect(titleOf('packages/sdk/src/components/')).toBe(
        'packages/sdk/src/components: 2 lines added, 1 removed'
      );
      // A folder at a file's path: only the file is aliased, never the folder, and selectionPath
      // keeps the folder's real path should that change.
      expect(titleOf('src/a.ts/')).toBe('src/a.ts: 4 lines added, 2 removed');
      expect(titleOf('src/')).toBe('src: 7 lines added, 2 removed');
    });

    it("formats a folder's lines in the app's language", async () => {
      // The app's German strings, none of which this test needs.
      fetchMock.mockImplementation(async (url) =>
        url.includes('/locales/de.json') ? respond({}) : respond({}, 404)
      );
      const tab = await renderPluginComponent(
        <QueryClientProvider client={new QueryClient()}>
          <Holder files={[file({ path: 'src/a.ts', additions: 1230, deletions: 7 })]} />
        </QueryClientProvider>,
        { id: 'pull-requests', plugin, language: 'de' }
      );
      expect(folderLines(tab)).toEqual({ 'src/': '+1.230 -7' });
      const src = tab.getByTestId('tree-folders').querySelector<HTMLElement>('[data-path="src/"]');
      expect(src?.title).toBe('src: 1.230 lines added, 7 removed');
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
      await click(tab.getByRole('treeitem', { name: 'README.md' }));
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

  describe('Files column width', () => {
    const PREFS_KEY = 'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/code:prefs';
    let bodyWidth = 1000;
    let clientWidth: { mockRestore(): void } | undefined;
    // jsdom has no ResizeObserver; this one tells its observers of a size change when a test
    // resizes the Code body.
    let observers: { callback: () => void; targets: Set<Element> }[] = [];
    beforeEach(() => {
      bodyWidth = 1000;
      observers = [];
      // jsdom lays nothing out; the Code body is as wide as each test says.
      clientWidth = vi
        .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.classList.contains('mrpr-code-body') ? bodyWidth : 0;
        });
      vi.stubGlobal(
        'ResizeObserver',
        class {
          private readonly entry: (typeof observers)[number];
          constructor(callback: () => void) {
            this.entry = { callback, targets: new Set() };
            observers.push(this.entry);
          }
          observe(target: Element) {
            this.entry.targets.add(target);
          }
          unobserve(target: Element) {
            this.entry.targets.delete(target);
          }
          disconnect() {
            this.entry.targets.clear();
          }
        }
      );
      // jsdom has no pointer capture.
      const captured = new Set<number>();
      Object.assign(HTMLElement.prototype, {
        setPointerCapture: (id: number) => captured.add(id),
        hasPointerCapture: (id: number) => captured.has(id),
        releasePointerCapture: (id: number) => captured.delete(id),
      });
    });
    afterEach(() => {
      clientWidth?.mockRestore();
      for (const name of ['setPointerCapture', 'hasPointerCapture', 'releasePointerCapture']) {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    });
    const resizeBody = (width: number) =>
      act(async () => {
        bodyWidth = width;
        for (const { callback, targets } of observers) {
          if ([...targets].some((target) => target.classList.contains('mrpr-code-body'))) {
            callback();
          }
        }
      });

    const handleOf = (tab: TabView) => tab.getByRole('separator', { name: 'Resize the files' });
    const shown = (tab: TabView) => {
      const handle = handleOf(tab);
      return {
        now: Number(handle.getAttribute('aria-valuenow')),
        min: Number(handle.getAttribute('aria-valuemin')),
        max: Number(handle.getAttribute('aria-valuemax')),
        style: handle.parentElement?.style.getPropertyValue('--mrpr-tree-width'),
      };
    };
    const stored = () => JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
    const press = (tab: TabView, key: string) =>
      act(async () => {
        handleOf(tab).dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        );
      });
    const pointer = (tab: TabView, type: string, clientX: number) =>
      act(async () => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
        Object.defineProperty(event, 'pointerId', { value: 1 });
        handleOf(tab).dispatchEvent(event);
      });

    it('starts at 240px, between 192px and what leaves the diffs 256px, at most 560px', async () => {
      const tab = await show();
      expect(shown(tab)).toEqual({ now: 240, min: 192, max: 560, style: '240px' });
      tab.unmount();
      bodyWidth = 640;
      expect(shown(await show())).toMatchObject({ now: 240, max: 384 });
    });

    it('the arrow keys step it 16px, Home and End to its bounds, and it persists', async () => {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ diffStyle: 'split', wrap: false }));
      const first = await show();
      await press(first, 'ArrowRight');
      await press(first, 'ArrowRight');
      expect(shown(first)).toMatchObject({ now: 272, style: '272px' });
      await press(first, 'ArrowLeft');
      expect(shown(first).now).toBe(256);
      await press(first, 'End');
      expect(shown(first).now).toBe(560);
      await press(first, 'Home');
      expect(shown(first).now).toBe(192);
      await press(first, 'ArrowRight');
      expect(stored()).toMatchObject({ diffStyle: 'split', wrap: false, treeWidth: 208 });
      first.unmount();

      const tab = await show();
      expect(shown(tab)).toMatchObject({ now: 208, style: '208px' });
      expect(options()).toMatchObject({ diffStyle: 'split', overflow: 'scroll' });
    });

    it('ignores the arrows with a modifier', async () => {
      const tab = await show();
      await act(async () => {
        handleOf(tab).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true })
        );
      });
      expect(shown(tab).now).toBe(240);
      expect(stored()).toBeNull();
    });

    it('a drag resizes it and stores the width where the pointer lets go', async () => {
      const first = await show();
      await pointer(first, 'pointerdown', 300);
      await pointer(first, 'pointermove', 380);
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      // Each frame shows the width without storing it.
      expect(shown(first)).toMatchObject({ now: 320, style: '320px' });
      expect(stored()).toBeNull();
      await pointer(first, 'pointerup', 400);
      expect(shown(first)).toMatchObject({ now: 340, style: '340px' });
      expect(stored()).toMatchObject({ treeWidth: 340 });
      first.unmount();
      expect(shown(await show()).now).toBe(340);
    });

    it('a drag stops at the bounds', async () => {
      const tab = await show();
      await pointer(tab, 'pointerdown', 300);
      await pointer(tab, 'pointerup', 0);
      expect(shown(tab).now).toBe(192);
      await pointer(tab, 'pointerdown', 300);
      await pointer(tab, 'pointerup', 2000);
      expect(shown(tab).now).toBe(560);
    });

    it('a press that does not move stores nothing', async () => {
      const tab = await show();
      await pointer(tab, 'pointerdown', 300);
      await pointer(tab, 'pointerup', 302);
      expect(shown(tab)).toMatchObject({ now: 240, style: '240px' });
      expect(stored()).toBeNull();
    });

    it('a cancelled pointer keeps the width it reached, as one that lets go', async () => {
      const tab = await show();
      await pointer(tab, 'pointerdown', 300);
      await pointer(tab, 'pointermove', 400);
      await pointer(tab, 'pointercancel', 450);
      expect(shown(tab)).toMatchObject({ now: 340, style: '340px' });
      expect(stored()).toMatchObject({ treeWidth: 340 });
    });

    it('hiding the files mid-drag abandons the drag', async () => {
      const tab = await show();
      await pointer(tab, 'pointerdown', 300);
      await pointer(tab, 'pointermove', 400);
      await click(tab.getByRole('button', { name: 'Files' }));
      expect(stored()).toBeNull();
      expect(document.body.style.cursor).toBe('');
      await click(tab.getByRole('button', { name: 'Files' }));
      expect(shown(tab)).toMatchObject({ now: 240, style: '240px' });
    });

    it('follows the panel as it narrows and widens, keeping the stored width', async () => {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ treeWidth: 500 }));
      const tab = await show();
      expect(shown(tab)).toMatchObject({ now: 500, max: 560, style: '500px' });
      await resizeBody(700);
      expect(shown(tab)).toMatchObject({ now: 444, max: 444, style: '444px' });
      expect(stored()).toEqual({ treeWidth: 500 });
      await resizeBody(1000);
      expect(shown(tab)).toMatchObject({ now: 500, max: 560, style: '500px' });
      expect(stored()).toEqual({ treeWidth: 500 });
    });

    it('a drag follows bounds that change while it lasts', async () => {
      const tab = await show();
      await pointer(tab, 'pointerdown', 300);
      await pointer(tab, 'pointermove', 700);
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      expect(shown(tab)).toMatchObject({ now: 560, style: '560px' });
      await resizeBody(700);
      expect(shown(tab)).toMatchObject({ now: 444, max: 444, style: '444px' });
      expect(stored()).toBeNull();
      await pointer(tab, 'pointerup', 700);
      expect(stored()).toMatchObject({ treeWidth: 444 });
      expect(shown(tab)).toMatchObject({ now: 444, style: '444px' });
    });

    it('a key or drag at a clamped bound keeps the stored width', async () => {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ treeWidth: 500 }));
      const tab = await show();
      await resizeBody(700);
      await press(tab, 'ArrowRight');
      await press(tab, 'End');
      await pointer(tab, 'pointerdown', 300);
      await pointer(tab, 'pointerup', 2000);
      expect(shown(tab)).toMatchObject({ now: 444, style: '444px' });
      expect(stored()).toEqual({ treeWidth: 500 });
      await resizeBody(1000);
      expect(shown(tab)).toMatchObject({ now: 500, style: '500px' });
    });

    it('a narrower body clamps a stored width it keeps', async () => {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ treeWidth: 500 }));
      bodyWidth = 600;
      const tab = await show();
      expect(shown(tab)).toMatchObject({ now: 344, max: 344, style: '344px' });
      expect(stored()).toEqual({ treeWidth: 500 });
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
    const note = tab.getByRole('link', {
      name: 'Showing the first 1000 review comments; see the rest on GitHub',
    });
    expect(note.getAttribute('href')).toBe('https://github.com/mindroom-ai/mindroom-chat/pull/200');
    expect(diffNames()).toHaveLength(6);
  });

  it('says when the commit selector lists only some of the commits', async () => {
    const tab = await show({ truncatedCommits: 250 });
    const note = tab.getByRole('link', {
      name: 'Showing the first 250 commits; see the rest on GitHub',
    });
    expect(note.getAttribute('href')).toBe(
      'https://github.com/mindroom-ai/mindroom-chat/pull/200/commits'
    );
    expect(tab.getByRole('button', { name: /^Diff scope:/ })).toBeTruthy();
  });

  describe('line distribution', () => {
    const DIST_FILES: PullRequestFile[] = [
      file({ path: 'src/workers/pool.ts', additions: 120, deletions: 20 }),
      file({
        path: 'src/workers/queue.ts',
        status: 'added',
        additions: 60,
        deletions: 0,
        patch: '@@ -0,0 +1 @@\n+q',
      }),
      file({
        path: 'src/workers/pool.test.ts',
        status: 'added',
        additions: 50,
        deletions: 5,
        patch: '@@ -0,0 +1 @@\n+t',
      }),
      file({ path: 'src/workers/icon.bin', patch: null, additions: 0, deletions: 0 }),
      file({ path: 'src/app.ts', additions: 30, deletions: 10 }),
      file({ path: 'docs/guide.md', additions: 25, deletions: 0 }),
    ];

    it('hides the toggle when there are no files, scrolls to top when opened, and respects reduced motion', async () => {
      const empty = await show({ files: [] });
      expect(empty.queryByRole('button', { name: 'Line distribution' })).toBeNull();
      empty.unmount();

      const tab = await show({ files: DIST_FILES });
      const toggle = tab.getByRole('button', { name: 'Line distribution' });
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      expect(tab.queryByRole('region', { name: 'Line distribution' })).toBeNull();

      await click(toggle);
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(tab.getByRole('region', { name: 'Line distribution' })).toBeTruthy();
      expect(view.scrollTo).toHaveBeenCalledWith({
        type: 'position',
        position: 0,
        behavior: 'smooth',
      });

      // Closing does not force a scroll to top.
      view.scrollTo.mockReset();
      await click(toggle);
      expect(tab.queryByRole('region', { name: 'Line distribution' })).toBeNull();
      expect(view.scrollTo).not.toHaveBeenCalled();

      // Reopening under prefers-reduced-motion uses instant scroll.
      vi.stubGlobal('matchMedia', () => ({ matches: true }));
      await click(toggle);
      expect(view.scrollTo).toHaveBeenCalledWith({
        type: 'position',
        position: 0,
        behavior: 'instant',
      });
    });

    it('drills into directories to filter diffs, tree, and withoutDiff, reveals files, and clears via toolbar chip', async () => {
      const tab = await show({ files: DIST_FILES });
      await click(tab.getByRole('button', { name: 'Line distribution' }));

      // Clicking a file reveals its diff without closing Distribution.
      await click(tab.getByRole('button', { name: /pool\.ts/ }));
      expect(view.scrollTo).toHaveBeenCalledWith({
        type: 'item',
        id: 'src/workers/pool.ts',
        align: 'start',
      });
      expect(tab.getByRole('region', { name: 'Line distribution' })).toBeTruthy();

      // Drill into src/ -> workers/ filters diffs, withoutDiff, file tree, and counts.
      await click(tab.getByRole('button', { name: /^src\// }));
      await click(tab.getByRole('button', { name: /^workers\// }));
      expect(diffNames()).toEqual([
        'src/workers/pool.ts',
        'src/workers/queue.ts',
        'src/workers/pool.test.ts',
      ]);
      expect(tab.container.querySelector('.mrpr-no-diff-path')?.textContent).toBe(
        'src/workers/icon.bin'
      );
      expect(tab.getByText('4 files')).toBeTruthy();
      const tree = tab.getByRole('list', { name: /^Files of/ });
      expect(treeItems(tree).map(([path]) => path)).toEqual([
        'src/workers/pool.ts',
        'src/workers/queue.ts',
        'src/workers/pool.test.ts',
        'src/workers/icon.bin',
      ]);

      // Hiding Distribution keeps the active filter visible and dismissible in the toolbar.
      await click(tab.getByRole('button', { name: 'Line distribution' }));
      const chip = tab.getByRole('button', { name: 'Clear filter: src/workers/' });
      expect(chip.textContent).toContain('src/workers/');
      await click(chip);
      expect(tab.queryByRole('button', { name: 'Clear filter: src/workers/' })).toBeNull();
      expect(diffNames()).toHaveLength(5);
    });

    it('keeps Tests chip synced with toolbar Hide test files and auto-normalizes dirPrefix on kind toggle or refetch', async () => {
      const files: PullRequestFile[] = [
        file({ path: 'src/tests/unit.test.ts', additions: 40, deletions: 0 }),
        file({ path: 'src/app.ts', additions: 20, deletions: 5 }),
        file({ path: 'docs/notes.md', additions: 10, deletions: 0 }),
      ];
      const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
      let setFiles!: (next: PullRequestFile[]) => void;
      function DynamicFiles() {
        const [list, update] = useState(files);
        setFiles = update;
        return (
          <CodeTab
            pullRequest={REF}
            files={list}
            threads={loaded<ReviewThread>([])}
            commits={loaded(COMMITS)}
            commit={undefined}
            onCommitChange={() => {}}
          />
        );
      }
      const tab = await renderPluginComponent(
        <QueryClientProvider client={client}>
          <GitHubServerContext.Provider value={{ server: undefined, pending: false }}>
            <DynamicFiles />
          </GitHubServerContext.Provider>
        </QueryClientProvider>,
        { id: 'pull-requests', plugin, themeKind: 'light' }
      );
      await click(tab.getByRole('button', { name: 'Line distribution' }));

      // Drill into src/tests/ (contains only test files).
      await click(tab.getByRole('button', { name: /^src\// }));
      await click(tab.getByRole('button', { name: /^tests\// }));
      expect(diffNames()).toEqual(['src/tests/unit.test.ts']);

      // Toggling Tests chip off updates Hide test files AND auto-normalizes src/tests/ -> src/.
      await click(tab.getByRole('button', { name: /Tests/ }));
      expect(
        tab.getByRole('button', { name: 'Hide test files' }).getAttribute('aria-pressed')
      ).toBe('true');
      expect(tab.getByRole('button', { name: 'Clear filter: src/' })).toBeTruthy();
      expect(diffNames()).toEqual(['src/app.ts']);

      // Toggling toolbar Hide test files back on updates Tests chip and stays at normalized src/.
      await click(tab.getByRole('button', { name: 'Hide test files' }));
      expect(tab.getByRole('button', { name: /Tests/ }).getAttribute('aria-pressed')).toBe('true');
      expect(tab.getByRole('button', { name: 'Clear filter: src/' })).toBeTruthy();

      // Refetch removing all files under src/ normalizes dirPrefix all the way back to root.
      await act(async () =>
        setFiles([file({ path: 'docs/notes.md', additions: 10, deletions: 0 })])
      );
      expect(tab.queryByRole('button', { name: /^Clear filter:/ })).toBeNull();
      expect(diffNames()).toEqual(['docs/notes.md']);
    });

    it('resets dirPrefix when switching commits and shows a clearable empty state if toolbar Hide tests hides remaining files', async () => {
      const tab = await show({
        files: [
          file({ path: 'src/app.ts', additions: 30, deletions: 5 }),
          file({ path: 'src/app.test.ts', additions: 20, deletions: 0 }),
        ],
      });
      await click(tab.getByRole('button', { name: 'Line distribution' }));
      await click(tab.getByRole('button', { name: /^src\// }));
      expect(tab.getByRole('button', { name: 'Clear filter: src/' })).toBeTruthy();

      // Switch to Commit 2: dirPrefix resets.
      await click(tab.getByRole('button', { name: /^Diff scope:/ }));
      await click(tab.getByRole('menuitemradio', { name: /Commit 2/ }));
      await act(async () => {});
      expect(tab.queryByRole('button', { name: 'Clear filter: src/' })).toBeNull();

      // Switch back to All commits, hide Code in Distribution, then hide tests from toolbar.
      await click(tab.getByRole('button', { name: /^Diff scope:/ }));
      await click(tab.getByRole('menuitemradio', { name: 'All commits' }));
      await click(tab.getByRole('button', { name: /Code/ }));
      await click(tab.getByRole('button', { name: 'Hide test files' }));
      expect(tab.getByText('No files match the current filter.')).toBeTruthy();
      await click(tab.getAllByRole('button', { name: 'Clear filter' })[0]);
      expect(diffNames()).toEqual(['src/app.ts']);
    });

    it('composes cleanly with the narrow (< 640px) stacked Files tree without breaking Go to files or height bounds', async () => {
      const clientWidth = vi
        .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.classList.contains('mrpr-code') ? 400 : 0;
        });
      const clientHeight = vi
        .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.classList.contains('mrpr-code-diffs') ? 600 : 0;
        });
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        }
      );
      try {
        const tab = await show({ files: DIST_FILES });
        await click(tab.getByRole('button', { name: 'Line distribution' }));
        const diffView = tab.getByTestId('diff-view');
        const stackedList = tab.getByRole('list', { name: /^Files of/ });
        const distRegion = tab.getByRole('region', { name: 'Line distribution' });
        expect(diffView.contains(stackedList)).toBe(true);
        expect(diffView.contains(distRegion)).toBe(true);
        expect(
          (tab.container.querySelector('.mrpr-code-diffs') as HTMLElement).style.getPropertyValue(
            '--mrpr-stacked-tree-max-height'
          )
        ).toBe('270px');

        view.scrollTo.mockReset();
        await click(tab.getByRole('button', { name: 'Go to files' }));
        expect(view.scrollTo).toHaveBeenCalledWith({
          type: 'position',
          position: 0,
          behavior: 'smooth',
        });
        expect(stackedList.contains(document.activeElement)).toBe(true);
      } finally {
        clientWidth.mockRestore();
        clientHeight.mockRestore();
      }
    });
  });
});
