// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/pullRequestDiff.logic.test.ts at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
import { describe, expect, it } from 'vitest';

import {
  areAllDiffFilesCollapsed,
  getFileViewedRange,
  isFileDiffCollapsed,
  toggleFileDiffFoldForViewed,
} from './diffFold.logic';

describe('isFileDiffCollapsed', () => {
  it('keeps a file the reader folded closed', () => {
    const toggled = new Set(['b.ts']);
    expect(isFileDiffCollapsed('b.ts', null, toggled)).toBe(true);
    expect(isFileDiffCollapsed('c.ts', null, toggled)).toBe(false);
  });

  it('folds against Collapse all files', () => {
    const toggled = new Set(['b.ts']);
    expect(isFileDiffCollapsed('b.ts', 'folded', toggled)).toBe(false);
    expect(isFileDiffCollapsed('c.ts', 'folded', toggled)).toBe(true);
  });
});

describe('toggleFileDiffFoldForViewed', () => {
  it('moves against whatever the toolbar last asked for', () => {
    expect([...toggleFileDiffFoldForViewed('a.ts', true, 'expanded', new Set())]).toEqual(['a.ts']);
    expect(toggleFileDiffFoldForViewed('a.ts', false, 'expanded', new Set()).size).toBe(0);
    expect(toggleFileDiffFoldForViewed('a.ts', true, 'folded', new Set()).size).toBe(0);
    expect([...toggleFileDiffFoldForViewed('a.ts', false, 'folded', new Set())]).toEqual(['a.ts']);
  });
});

describe('getFileViewedRange', () => {
  const files = ['c.ts', 'a.ts', 'b.ts', 'd.ts'].map((fileKey) => ({ fileKey }));

  it('includes both endpoints in displayed order in either direction', () => {
    expect(getFileViewedRange(files, 'b.ts', 'c.ts')).toEqual(files.slice(0, 3));
    expect(getFileViewedRange(files, 'c.ts', 'b.ts')).toEqual(files.slice(0, 3));
    expect(getFileViewedRange(files, 'a.ts', 'a.ts')).toEqual([files[1]]);
  });

  it('changes only the clicked file without a current anchor', () => {
    expect(getFileViewedRange(files, 'a.ts', null)).toEqual([files[1]]);
    expect(getFileViewedRange(files, 'a.ts', 'removed.ts')).toEqual([files[1]]);
    expect(getFileViewedRange(files, 'removed.ts', 'a.ts')).toEqual([]);
  });
});

describe('areAllDiffFilesCollapsed', () => {
  it('is true only when there are files and each is collapsed', () => {
    expect(areAllDiffFilesCollapsed([], new Set())).toBe(false);
    expect(areAllDiffFilesCollapsed(['a.ts', 'b.ts'], new Set(['a.ts']))).toBe(false);
    expect(areAllDiffFilesCollapsed(['a.ts', 'b.ts'], new Set(['a.ts', 'b.ts']))).toBe(true);
  });
});
