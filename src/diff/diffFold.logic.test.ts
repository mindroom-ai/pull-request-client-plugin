// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/pullRequestDiff.logic.test.ts and packages/client-runtime/src/pullRequestDiffFold.test.ts at 1f698f01d9), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
import { describe, expect, it } from 'vitest';

import {
  areAllDiffFilesCollapsed,
  getFileViewedRange,
  isFileDiffCollapsed,
  withFileDiffFold,
} from './diffFold.logic';

describe('isFileDiffCollapsed', () => {
  it('folds a viewed file as its mark comes and opens it as the mark goes', () => {
    const choices = new Map<string, boolean>();
    expect(isFileDiffCollapsed('a.ts', null, choices, false)).toBe(false);
    expect(isFileDiffCollapsed('a.ts', null, choices, true)).toBe(true);
    expect(isFileDiffCollapsed('a.ts', null, choices, false)).toBe(false);
  });

  it("keeps the reader's own choices while the viewed marks change", () => {
    const choices = new Map([
      ['a.ts', false],
      ['b.ts', true],
    ]);
    expect(isFileDiffCollapsed('a.ts', null, choices, true)).toBe(false);
    expect(isFileDiffCollapsed('b.ts', null, choices, false)).toBe(true);
    expect(isFileDiffCollapsed('c.ts', null, choices, true)).toBe(true);
    expect(isFileDiffCollapsed('d.ts', null, choices, false)).toBe(false);
  });

  it('follows Expand all and Collapse all files over the marks, with the choices made since', () => {
    const choices = new Map<string, boolean>();
    expect(isFileDiffCollapsed('a.ts', 'expanded', choices, true)).toBe(false);
    expect(isFileDiffCollapsed('b.ts', 'folded', choices, false)).toBe(true);
    expect(isFileDiffCollapsed('c.ts', 'folded', new Map([['c.ts', false]]), true)).toBe(false);
    expect(isFileDiffCollapsed('d.ts', 'expanded', new Map([['d.ts', true]]), false)).toBe(true);
  });
});

describe('withFileDiffFold', () => {
  it('records or clears a choice, and keeps the same map when nothing changes', () => {
    const folded = withFileDiffFold(new Map(), 'a.ts', true);
    expect(folded.get('a.ts')).toBe(true);
    expect(withFileDiffFold(folded, 'a.ts', true)).toBe(folded);
    expect(withFileDiffFold(folded, 'a.ts', false).get('a.ts')).toBe(false);
    expect(withFileDiffFold(folded, 'a.ts', undefined).has('a.ts')).toBe(false);
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
