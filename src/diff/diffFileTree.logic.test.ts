// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/diffs/diffFileTree.logic.test.ts at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
import type { FileDiffMetadata } from '@pierre/diffs';
import { createFileTreeIconResolver } from '@pierre/trees';
import { describe, expect, it } from 'vitest';

import {
  buildDiffFileTreeUpdates,
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
