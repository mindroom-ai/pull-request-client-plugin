// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/lib/diffRendering.test.ts at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
import { describe, expect, it } from 'vitest';

import { getDiffLineStat, getRenderablePatch } from './diffRendering';

describe('getRenderablePatch', () => {
  it('ignore whitespace hides an indentation-only change', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,3 @@',
      ' function a() {',
      '-  return 1;',
      '+    return 1;',
      ' }',
    ].join('\n');
    const shown = getRenderablePatch(patch, 'pr');
    const hidden = getRenderablePatch(patch, 'pr', { ignoreWhitespace: true });
    if (shown?.kind !== 'files' || hidden?.kind !== 'files') throw new Error('not parsed');
    expect(getDiffLineStat(shown.files)).toEqual({ additions: 1, deletions: 1 });
    expect(getDiffLineStat(hidden.files)).toEqual({ additions: 0, deletions: 0 });
    expect(hidden.files[0]!.hunks[0]!.hunkContent).toEqual([
      { type: 'context', lines: 3, additionLineIndex: 0, deletionLineIndex: 0 },
    ]);
  });

  it('hides indentation changes around inserted JSX without moving the lines', () => {
    const patch = [
      'diff --git a/item.tsx b/item.tsx',
      '--- a/item.tsx',
      '+++ b/item.tsx',
      '@@ -40,5 +40,7 @@',
      ' <ItemContent className="min-w-0">',
      '-  <ItemTitle>',
      '-    <h4 className="wrap-break-word">{name}</h4>',
      '-  </ItemTitle>',
      '+  {showName && (',
      '+    <ItemTitle>',
      '+      <h4 className="wrap-break-word">{name}</h4>',
      '+    </ItemTitle>',
      '+  )}',
      ' </ItemContent>',
      '@@ -80 +82 @@',
      '-const value = 1;',
      '+const value = 2;',
    ].join('\n');
    const shown = getRenderablePatch(patch, 'pr');
    const hidden = getRenderablePatch(patch, 'pr', { ignoreWhitespace: true });
    if (shown?.kind !== 'files' || hidden?.kind !== 'files') throw new Error('not parsed');
    expect(getDiffLineStat(shown.files)).toEqual({ additions: 6, deletions: 4 });
    expect(getDiffLineStat(hidden.files)).toEqual({ additions: 3, deletions: 1 });
    const before = shown.files[0]!;
    const file = hidden.files[0]!;
    expect(file.additionLines).toEqual(before.additionLines);
    expect(file.deletionLines).toEqual(before.deletionLines);
    expect(file.cacheKey).not.toBe(before.cacheKey);
    expect(file.hunks[0]?.hunkContent).toContainEqual({
      type: 'context',
      lines: 3,
      additionLineIndex: 2,
      deletionLineIndex: 1,
    });
    // The first hunk shows three unified rows fewer, so the rows after it move up by three.
    expect(file.hunks[1]).toMatchObject({
      additionStart: 82,
      deletionStart: 80,
      splitLineStart: before.hunks[1]!.splitLineStart,
      unifiedLineStart: before.hunks[1]!.unifiedLineStart - 3,
    });
    expect(file.unifiedLineCount).toBe(before.unifiedLineCount - 3);
    expect(file.splitLineCount).toBe(before.splitLineCount);
  });

  it.each([
    ['  const x = 1;\t', '\tconst x=1;', 0, 0],
    ['const x = 1;', 'const x = 2;', 1, 1],
    ['const x = 1;', 'const x = 1;\n', 1, 0],
  ])('filters whitespace in %j to %j', (before, after, additions, deletions) => {
    const patch = [
      'diff --git a/example.ts b/example.ts',
      '--- a/example.ts',
      '+++ b/example.ts',
      `@@ -1 +1,${after.split('\n').length} @@`,
      `-${before}`,
      ...after.split('\n').map((line) => `+${line}`),
      '',
    ].join('\n');
    const filtered = getRenderablePatch(patch, 'pr', { ignoreWhitespace: true });
    expect(filtered?.kind).toBe('files');
    if (filtered?.kind !== 'files') return;
    expect(getDiffLineStat(filtered.files)).toEqual({ additions, deletions });
  });

  it.each(['+', '-'])('keeps %s blank lines without a final newline', (sign) => {
    const parsed = getRenderablePatch(
      [
        'diff --git a/blank.txt b/blank.txt',
        '--- a/blank.txt',
        '+++ b/blank.txt',
        sign === '+' ? '@@ -0,0 +1 @@' : '@@ -1 +0,0 @@',
        `${sign}  `,
        '\\ No newline at end of file',
      ].join('\n'),
      'pr',
      { ignoreWhitespace: true }
    );
    expect(parsed?.kind).toBe('files');
    if (parsed?.kind !== 'files') return;
    expect(getDiffLineStat(parsed.files)).toEqual({
      additions: sign === '+' ? 1 : 0,
      deletions: sign === '-' ? 1 : 0,
    });
  });
});
