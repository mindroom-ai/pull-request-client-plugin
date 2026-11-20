// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/lib/diffRendering.test.ts at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
import { getSharedHighlighter, renderDiffWithHighlighter } from '@pierre/diffs';
import { describe, expect, it } from 'vitest';

import {
  getDiffLineStat,
  getRenderablePatch,
  prepareFileDiff,
  reconstructOldFile,
} from './diffRendering';
import {
  greenhouseAfter,
  greenhouseBefore,
  greenhousePatch,
  greenhousePath,
} from '../testing/greenhouseDiff';

const source = (patch = greenhousePatch, additions = 2, deletions = 2, sha = 'b'.repeat(40)) => ({
  patch,
  additions,
  deletions,
  sha,
});
const parse = (patch = greenhousePatch) => {
  const name = greenhousePath;
  const result = getRenderablePatch(
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${patch}\n`,
    'pr'
  );
  if (result?.kind !== 'files' || !result.files[0]) throw new Error('not parsed');
  return result.files[0];
};

const firstHunk = greenhousePatch.split('\n@@ -9')[0]!;
const secondHunk = greenhousePatch.slice(firstHunk.length + 1);

describe('reconstructOldFile', () => {
  it('reconstructs the original full file from only the new blob and complete hunks', () => {
    expect(reconstructOldFile(parse(), source(), greenhouseAfter)).toBe(greenhouseBefore);
  });

  it.each([
    ['wrong context', greenhousePatch, greenhouseAfter.replace('east bed', 'west bed')],
    ['wrong addition', greenhousePatch, greenhouseBefore],
    ['truncated raw hunk', greenhousePatch.replace('-9,6 +9,6', '-9,7 +9,7'), greenhouseAfter],
    ['extra raw hunk lines', greenhousePatch.replace('-9,6 +9,6', '-9,5 +9,5'), greenhouseAfter],
    ['omitted whole hunk', firstHunk, greenhouseAfter],
    ['unordered hunks', `${secondHunk}\n${firstHunk}`, greenhouseAfter],
    ['overlapping hunks', `${firstHunk}\n${firstHunk}`, greenhouseAfter],
    [
      'unequal old and new gaps',
      greenhousePatch.replace('-9,6 +9,6', '-8,6 +9,6'),
      greenhouseAfter,
    ],
    ['nonempty range at line zero', greenhousePatch.replace('-1,2', '-0,2'), greenhouseAfter],
    ['wrong final newline', greenhousePatch, greenhouseAfter.trimEnd()],
  ])('rejects %s', (_name, patch, blob) => {
    expect(reconstructOldFile(parse(patch), source(patch), blob)).toBeNull();
  });

  it.each([
    [1, 2],
    [2, 1],
  ])('rejects a file stat of +%d -%d for a complete +2 -2 patch', (additions, deletions) => {
    expect(
      reconstructOldFile(parse(), source(greenhousePatch, additions, deletions), greenhouseAfter)
    ).toBeNull();
  });

  it.each([
    ['insertion after line one', '@@ -1,0 +2 @@\n+bud', 1, 0, 'stem\nbud\nleaf\n', 'stem\nleaf\n'],
    ['deletion after line one', '@@ -2 +1,0 @@\n-bud', 0, 1, 'stem\nleaf\n', 'stem\nbud\nleaf\n'],
    ['insertion at start', '@@ -0,0 +1 @@\n+bud', 1, 0, 'bud\nleaf\n', 'leaf\n'],
    [
      'old without a newline',
      '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new',
      1,
      1,
      'new\n',
      'old',
    ],
    [
      'new without a newline',
      '@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file',
      1,
      1,
      'new',
      'old\n',
    ],
    [
      'shared context without a newline',
      '@@ -1,2 +1,2 @@\n-old\n+new\n stem\n\\ No newline at end of file',
      1,
      1,
      'new\nstem',
      'old\nstem',
    ],
    [
      'CRLF context',
      '@@ -1,2 +1,2 @@\n-old\r\n+new\r\n stem\r',
      1,
      1,
      'new\r\nstem\r\n',
      'old\r\nstem\r\n',
    ],
  ])('handles %s', (_name, patch, additions, deletions, blob, old) => {
    expect(reconstructOldFile(parse(patch), source(patch, additions, deletions), blob)).toBe(old);
  });

  it('rejects an old-side EOF marker before unchanged tail lines', () => {
    const patch = '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new';
    expect(reconstructOldFile(parse(patch), source(patch, 1, 1), 'new\nstem\n')).toBeNull();
  });

  it('caps the reconstructed side by UTF-8 byte length', () => {
    const patch = `@@ -1 +1 @@\n-${'é'.repeat(65_536)}\n+bud`;
    expect(reconstructOldFile(parse(patch), source(patch, 1, 1), 'bud\n')).toBeNull();
  });
});

describe('partial diff hydration', () => {
  it('highlights a hunk that starts inside a Python docstring as a string', async () => {
    const partial = parse();
    const file = prepareFileDiff(partial, { source: source(), blob: greenhouseAfter });
    const highlighter = await getSharedHighlighter({ themes: ['pierre-light'], langs: ['python'] });
    const highlighted = renderDiffWithHighlighter(file, highlighter, {
      theme: 'pierre-light',
      useTokenTransformer: false,
      tokenizeMaxLineLength: 1000,
      lineDiffType: 'none',
      maxLineDiffLength: 1000,
    }).code.additionLines;
    const docLine = highlighted[file.hunks[1]!.additionLineIndex];
    const literal = highlighted[1];
    if (docLine?.type !== 'element' || literal?.type !== 'element') throw new Error('not rendered');
    const stringToken = literal.children.at(-1);
    if (stringToken?.type !== 'element') throw new Error('no string token');
    expect(docLine.children).toContainEqual(
      expect.objectContaining({
        properties: stringToken.properties,
        children: [{ type: 'text', value: '    if a leaf is dry, move its pot.' }],
      })
    );
    expect(file.isPartial).toBe(false);
  });

  it('changes the cache key for different blobs with the same patch', () => {
    const partial = parse();
    const fern = prepareFileDiff(partial, { source: source(), blob: greenhouseAfter });
    const sage = prepareFileDiff(partial, {
      source: source(greenhousePatch, 2, 2, 'c'.repeat(40)),
      blob: greenhouseAfter.replace('fresh soil', 'fresh compost'),
    });
    expect(fern.isPartial).toBe(false);
    expect(sage.isPartial).toBe(false);
    expect(new Set([partial.cacheKey, fern.cacheKey, sage.cacheKey]).size).toBe(3);
  });

  it('hides whitespace after hydrating and keeps hunk offsets in the full file', () => {
    const patch = greenhousePatch.replace('+    return COUNT + 2', '+    return  COUNT + 1');
    const file = prepareFileDiff(parse(patch), {
      ignoreWhitespace: true,
      source: source(patch),
      blob: greenhouseAfter.replace('return COUNT + 2', 'return  COUNT + 1'),
    });
    expect(file.isPartial).toBe(false);
    expect(getDiffLineStat([file])).toEqual({ additions: 1, deletions: 1 });
    expect(file.hunks[1]?.hunkContent).toEqual([
      { type: 'context', lines: 6, additionLineIndex: 8, deletionLineIndex: 8 },
    ]);
  });

  it('keeps the exact same partial diff when the blob does not match', () => {
    const partial = parse();
    expect(prepareFileDiff(partial, { source: source(), blob: greenhouseBefore })).toBe(partial);
  });
});

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
