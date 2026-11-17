// @vitest-environment jsdom
// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/diffs/DiffFileTree.browser.test.tsx at 1c86881dd5), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { FileTree } from '@pierre/trees';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from '../index';
import { DiffFileTree, type DiffFileTreeEntry } from './DiffFileTree';

const FOLDERS = 300;

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
});
