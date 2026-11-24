// @vitest-environment jsdom
// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/diffs/DiffFileTree.browser.test.tsx at 1c86881dd5), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
import { act } from '../testing/act';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { FileTree } from '@pierre/trees';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from '../index';
import { DiffFileTree, type DiffFileTreeEntry } from './DiffFileTree';

const FOLDERS = 300;

const dir = (tree: FileTree | undefined, path: string) => {
  const item = tree?.getItem(path);
  if (!item || !('isExpanded' in item)) throw new Error(`Expected directory item for ${path}`);
  return item;
};

const captureModels = () => {
  const models: FileTree[] = [];
  const originalReset = FileTree.prototype.resetPaths;
  vi.spyOn(FileTree.prototype, 'resetPaths').mockImplementation(function (
    this: FileTree,
    ...args: Parameters<FileTree['resetPaths']>
  ) {
    if (!models.includes(this)) models.push(this);
    return originalReset.apply(this, args);
  });
  return models;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom reports the tree's stylesheet, which it cannot parse and a browser reads, as an error.
  const report = console.error.bind(console);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('Could not parse CSS stylesheet')) return;
    report(...args);
  });
});
afterEach(() => {
  document.documentElement.style.fontSize = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DiffFileTree', () => {
  it('expands every folder without asking the tree about all folders for each one', async () => {
    // Two levels, so flattening empty folders cannot merge them into one.
    const entries: DiffFileTreeEntry[] = Array.from({ length: FOLDERS }, (_, index) => [
      { path: `package-${index}/a.ts`, status: 'modified' as const, additions: 1, deletions: 0 },
      {
        path: `package-${index}/lib/b.ts`,
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
      },
    ]).flat();
    const tab = await renderPluginComponent(
      <DiffFileTree entries={entries} onSelectFile={() => {}} ariaLabel="Changed files" />,
      { id: 'pull-requests', plugin }
    );
    const getItem = vi.spyOn(FileTree.prototype, 'getItem');
    await act(async () => tab.getByRole('button', { name: 'Collapse all folders' }).click());
    const expandAll = await tab.findByRole('button', { name: 'Expand all folders' });
    getItem.mockClear();
    await act(async () => expandAll.click());
    expect(await tab.findByRole('button', { name: 'Collapse all folders' })).toBeTruthy();
    // Each expansion used to look the folders up again from the first one, so the lookups grew
    // with the square of the folder count.
    expect(getItem.mock.calls.length).toBeLessThan(FOLDERS * 2 * 20);
  });

  it('starts collapsed when initialExpansion is closed and toggles all folders accurately', async () => {
    const entries: DiffFileTreeEntry[] = [
      { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
      { path: 'docs/guide.md', status: 'added', additions: 2, deletions: 0 },
      { path: 'src/session/store.ts', status: 'modified', additions: 3, deletions: 1 },
    ];
    const models = captureModels();

    const tab = await renderPluginComponent(
      <DiffFileTree
        entries={entries}
        initialExpansion="closed"
        onSelectFile={() => {}}
        ariaLabel="Changed files"
      />,
      { id: 'pull-requests', plugin }
    );
    const [model] = models;
    expect(tab.getByRole('button', { name: 'Expand all folders' })).toBeTruthy();
    expect(dir(model, 'docs/').isExpanded()).toBe(false);
    expect(dir(model, 'src/session/').isExpanded()).toBe(false);

    await act(async () => tab.getByRole('button', { name: 'Expand all folders' }).click());
    expect(await tab.findByRole('button', { name: 'Collapse all folders' })).toBeTruthy();
    expect(dir(model, 'docs/').isExpanded()).toBe(true);
    expect(dir(model, 'src/session/').isExpanded()).toBe(true);

    await act(async () => tab.getByRole('button', { name: 'Collapse all folders' }).click());
    expect(await tab.findByRole('button', { name: 'Expand all folders' })).toBeTruthy();
    expect(dir(model, 'docs/').isExpanded()).toBe(false);
    expect(dir(model, 'src/session/').isExpanded()).toBe(false);
  });

  it('preserves expanded and collapsed directories across refetches and zoom remounts under closed baseline', async () => {
    vi.useFakeTimers();
    const models = captureModels();
    const initialEntries: DiffFileTreeEntry[] = [
      { path: 'docs/a.md', status: 'modified', additions: 1, deletions: 0 },
      { path: 'pkg/c.ts', status: 'modified', additions: 1, deletions: 0 },
      { path: 'src/session/b.ts', status: 'modified', additions: 2, deletions: 0 },
    ];
    const tab = await renderPluginComponent(
      <DiffFileTree
        entries={initialEntries}
        initialExpansion="closed"
        onSelectFile={() => {}}
        ariaLabel="Changed files"
      />,
      { id: 'pull-requests', plugin }
    );
    const [first] = models;
    expect(dir(first, 'docs/').isExpanded()).toBe(false);
    expect(dir(first, 'src/session/').isExpanded()).toBe(false);

    // Explicitly expand src/session/ while leaving docs/ and pkg/ collapsed.
    await act(async () => {
      dir(first, 'src/session/').toggle();
    });
    expect(dir(first, 'src/session/').isExpanded()).toBe(true);
    expect(dir(first, 'docs/').isExpanded()).toBe(false);

    // Refetch replaces pkg/c.ts with lib/d.ts, forcing model.resetPaths:
    // expanded src/session/ stays expanded, docs/ stays collapsed, new lib/ starts collapsed.
    const refetchedEntries: DiffFileTreeEntry[] = [
      { path: 'docs/a.md', status: 'modified', additions: 1, deletions: 0 },
      { path: 'lib/d.ts', status: 'added', additions: 4, deletions: 0 },
      { path: 'src/session/b.ts', status: 'modified', additions: 2, deletions: 0 },
    ];
    await act(async () => {
      tab.rerender(
        <DiffFileTree
          entries={refetchedEntries}
          initialExpansion="closed"
          onSelectFile={() => {}}
          ariaLabel="Changed files"
        />
      );
    });
    expect(dir(first, 'src/session/').isExpanded()).toBe(true);
    expect(dir(first, 'docs/').isExpanded()).toBe(false);
    expect(dir(first, 'lib/').isExpanded()).toBe(false);

    // Page zoom remounts SizedDiffFileTree after settle: carried state preserves expanded src/session/.
    await act(async () => {
      document.documentElement.style.fontSize = '24px';
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    const zoomed = models.at(-1);
    expect(zoomed).not.toBe(first);
    expect(dir(zoomed, 'src/session/').isExpanded()).toBe(true);
    expect(dir(zoomed, 'docs/').isExpanded()).toBe(false);
    expect(dir(zoomed, 'lib/').isExpanded()).toBe(false);

    // Switching initialExpansion to open resets to all expanded rather than carrying closed state.
    await act(async () => {
      tab.rerender(
        <DiffFileTree
          entries={refetchedEntries}
          initialExpansion="open"
          onSelectFile={() => {}}
          ariaLabel="Changed files"
        />
      );
    });
    const opened = models.at(-1);
    expect(dir(opened, 'src/session/').isExpanded()).toBe(true);
    expect(dir(opened, 'docs/').isExpanded()).toBe(true);
    expect(dir(opened, 'lib/').isExpanded()).toBe(true);
    vi.useRealTimers();
    await act(async () => tab.unmount());
  });
});
