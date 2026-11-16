// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/diffs/diffFileTree.logic.test.ts at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
import type { FileDiffMetadata } from '@pierre/diffs';
import { createFileTreeIconResolver, FileTree } from '@pierre/trees';
import { describe, expect, it } from 'vitest';

import {
  buildDiffFileTreeUpdates,
  collectDirectoryPaths,
  diffFileTreeDirectoryLines,
  diffFileTreeModel,
  orderDiffFilesLikeTree,
} from './diffFileTree.logic';

function file(type: FileDiffMetadata['type'], name: string, prevName = name): FileDiffMetadata {
  return { type, name, prevName } as FileDiffMetadata;
}

describe('orderDiffFilesLikeTree', () => {
  it('pulls a test listed last into its directory, keeping the first-seen order', () => {
    expect(
      orderDiffFilesLikeTree([
        file('change', 'server/device/Host.ts'),
        file('change', 'web/settings.ts'),
        file('change', 'server/ws.ts'),
        file('change', 'server/device/Host.test.ts'),
        file('change', 'web/settings.test.ts'),
      ]).map((entry) => entry.name)
    ).toEqual([
      'server/device/Host.ts',
      'server/device/Host.test.ts',
      'server/ws.ts',
      'web/settings.ts',
      'web/settings.test.ts',
    ]);
  });
});

describe('diffFileTreeModel', () => {
  it("gives a file at a directory's path an alias with the file's own icon", () => {
    const model = diffFileTreeModel(['src/a.ts', 'src/a.ts/b.ts']);
    expect(model.paths).toEqual(['src/a.ts\u200b', 'src/a.ts/b.ts']);
    expect(model.selectionPath('src/a.ts\u200b')).toBe('src/a.ts');
    expect(model.modelPath('src/a.ts')).toBe('src/a.ts\u200b');
    const icon = createFileTreeIconResolver(model.icons).resolveIcon(
      'file-tree-icon-file',
      'src/a.ts\u200b'
    );
    expect(icon).toMatchObject({ name: 'file-tree-builtin-typescript', token: 'typescript' });
  });
});

describe('diffFileTreeDirectoryLines', () => {
  const lines = (path: string, additions: number, deletions: number) => ({
    path,
    additions,
    deletions,
  });

  it("sums each directory's files, nested ones included, and leaves root files out", () => {
    const counts = diffFileTreeDirectoryLines([
      lines('README.md', 100, 100),
      lines('src/app/a.ts', 10, 1),
      lines('src/app/messages/b.ts', 5, 2),
      lines('src/c.ts', 1, 0),
      lines('docs/guide.md', 7, 3),
    ]);
    expect(Object.fromEntries(counts)).toEqual({
      'src/': { additions: 16, deletions: 3 },
      'src/app/': { additions: 15, deletions: 3 },
      'src/app/messages/': { additions: 5, deletions: 2 },
      'docs/': { additions: 7, deletions: 3 },
    });
  });

  it("keys a directory that shares a file's path by the model's directory path", () => {
    const entries = [lines('src/a.ts', 3, 1), lines('src/a.ts/b.ts', 2, 2)];
    const counts = diffFileTreeDirectoryLines(entries);
    const modelPaths = diffFileTreeModel(entries.map((entry) => entry.path)).paths;
    expect([...counts.keys()].sort()).toEqual([...collectDirectoryPaths(modelPaths)].sort());
    expect(Object.fromEntries(counts)).toEqual({
      'src/': { additions: 5, deletions: 3 },
      'src/a.ts/': { additions: 2, deletions: 2 },
    });
  });

  // The tree's decorations look counts up by the row's path; for a chain of directories Pierre
  // shows as one row, by the deepest one's.
  it("matches the paths Pierre gives its directory rows, a flattened chain's deepest one", () => {
    const paths = ['src/app/messages/content/a.ts', 'src/b.ts', 'src/a.ts', 'src/a.ts/c.ts'];
    const modelPaths = diffFileTreeModel(paths).paths;
    const tree = new FileTree({
      paths: modelPaths,
      flattenEmptyDirectories: true,
      initialExpansion: 'open',
    });
    const rows = tree.getVisibleRows(0, tree.getVisibleCount() - 1);
    const directoryRows = rows
      .filter((row) => row.kind === 'directory')
      .map((row) =>
        row.isFlattened
          ? row.flattenedSegments!.findLast((segment) => segment.isTerminal)!.path
          : row.path
      );
    tree.cleanUp();
    const counts = diffFileTreeDirectoryLines(paths.map((path) => lines(path, 1, 0)));
    expect(directoryRows.sort()).toEqual(['src/', 'src/a.ts/', 'src/app/messages/content/']);
    for (const path of directoryRows) expect(counts.has(path)).toBe(true);
  });
});

describe('buildDiffFileTreeUpdates', () => {
  it("adds a new file's directories before the file", () => {
    expect(buildDiffFileTreeUpdates(['README.md'], ['README.md', 'src/lib/a.ts'])).toEqual([
      { type: 'add', path: 'src/' },
      { type: 'add', path: 'src/lib/' },
      { type: 'add', path: 'src/lib/a.ts' },
    ]);
  });

  it('removes files before their now-empty directories, deepest first', () => {
    expect(buildDiffFileTreeUpdates(['src/lib/a.ts', 'src/b.ts'], ['src/b.ts'])).toEqual([
      { type: 'remove', path: 'src/lib/a.ts' },
      { type: 'remove', path: 'src/lib/', recursive: true },
    ]);
  });
});
