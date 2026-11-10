// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestFile } from './github';
import plugin from './index';
import { CodeTab } from './CodeTab';

// jsdom has no custom elements, layout or ResizeObserver, which Pierre's tree and diff view need:
// the diff view stands in as the names of its items' files and its footer, and the tree as a
// list of buttons, one for each path, with the status the tree was given.
const view = vi.hoisted(() => ({
  scrollTo: vi.fn(),
  props: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@pierre/diffs/react', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  type Props = {
    items: { id: string; fileDiff: { name: string } }[];
    renderCodeViewFooter?: () => ReactNode;
  };
  return {
    CodeView: forwardRef<unknown, Props>(function CodeView(props, ref) {
      view.props = props;
      useImperativeHandle(ref, () => ({ scrollTo: view.scrollTo }));
      return (
        <div data-testid="diff-view">
          <ol aria-label="Diffs">
            {props.items.map((item) => (
              <li key={item.id}>{item.fileDiff.name}</li>
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

const click = (element: HTMLElement) => act(async () => element.click());

const show = (themeKind: 'light' | 'dark' = 'light') =>
  renderPluginComponent(<CodeTab pullRequest={REF} files={FILES} />, {
    id: 'pull-requests',
    plugin,
    themeKind,
  });

const treeItems = (tree: HTMLElement) =>
  [...tree.querySelectorAll('li')].map((item) => [item.textContent, item.dataset.status]);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  view.scrollTo.mockReset();
  view.props = undefined;
});
afterEach(() => {
  delete (Element.prototype as Partial<Element>).scrollIntoView;
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
    await show('dark');
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
});
