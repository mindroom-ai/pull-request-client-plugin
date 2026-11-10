import type { FileDiffMetadata } from '@pierre/diffs';
import { describe, expect, it } from 'vitest';
import type { ReviewComment } from '../github';
import type { ReviewThread } from '../reviewThreads';
import { annotationsKey, isLineInFileDiff, placeThreads } from './threadAnnotations';

function fileWithHunks(
  hunks: ReadonlyArray<{
    deletionStart: number;
    deletionCount: number;
    additionStart: number;
    additionCount: number;
  }>,
  name = 'src/app.ts'
): FileDiffMetadata {
  return { name, hunks } as unknown as FileDiffMetadata;
}

describe('isLineInFileDiff', () => {
  const file = fileWithHunks([
    { deletionStart: 10, deletionCount: 3, additionStart: 10, additionCount: 5 },
    { deletionStart: 40, deletionCount: 0, additionStart: 42, additionCount: 2 },
  ]);

  it('includes the first line of a hunk and excludes the one past its last', () => {
    expect(isLineInFileDiff(file, 'RIGHT', 10)).toBe(true);
    expect(isLineInFileDiff(file, 'RIGHT', 14)).toBe(true);
    expect(isLineInFileDiff(file, 'RIGHT', 15)).toBe(false);
    expect(isLineInFileDiff(file, 'LEFT', 9)).toBe(false);
    expect(isLineInFileDiff(file, 'LEFT', 12)).toBe(true);
    expect(isLineInFileDiff(file, 'LEFT', 13)).toBe(false);
  });

  it('keeps the two sides apart, since one line number means two lines', () => {
    expect(isLineInFileDiff(file, 'RIGHT', 43)).toBe(true);
    expect(isLineInFileDiff(file, 'LEFT', 40)).toBe(false);
  });
});

const comment = (id: number, over: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  author: { login: 'ann', name: null, avatarUrl: null, url: null, isBot: false },
  body: `Comment ${id}`,
  createdAt: `2026-11-01T00:0${id}:00Z`,
  url: `https://github.com/c/${id}`,
  reactions: [],
  path: 'src/app.ts',
  line: 11,
  originalLine: 11,
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
  line: 11,
  side: 'RIGHT',
  outdated: false,
  comments: [comment(id)],
  ...over,
});

describe('placeThreads', () => {
  const app = fileWithHunks([
    { deletionStart: 10, deletionCount: 3, additionStart: 10, additionCount: 5 },
  ]);
  const readme = fileWithHunks(
    [{ deletionStart: 1, deletionCount: 2, additionStart: 1, additionCount: 2 }],
    'README.md'
  );

  it('puts a thread on a rendered line of its file, on its side', () => {
    const right = thread(1, { line: 11, side: 'RIGHT' });
    const left = thread(2, { line: 12, side: 'LEFT' });
    const placed = placeThreads([app, readme], [right, left], false);
    expect(placed.annotations.get('src/app.ts')).toEqual([
      { side: 'additions', lineNumber: 11, metadata: { threads: [right] } },
      { side: 'deletions', lineNumber: 12, metadata: { threads: [left] } },
    ]);
    expect(placed.annotations.has('README.md')).toBe(false);
    expect(placed.offDiff).toEqual([]);
  });

  it('groups the threads of one side and line into one annotation, in their order', () => {
    const first = thread(1);
    const second = thread(2);
    const otherSide = thread(3, { side: 'LEFT' });
    const placed = placeThreads([app], [first, second, otherSide], false);
    expect(placed.annotations.get('src/app.ts')).toEqual([
      { side: 'additions', lineNumber: 11, metadata: { threads: [first, second] } },
      { side: 'deletions', lineNumber: 11, metadata: { threads: [otherSide] } },
    ]);
  });

  it('lists a thread whose line is in no hunk off the diff', () => {
    const outside = thread(1, { line: 30 });
    expect(placeThreads([app], [outside], false)).toEqual({
      annotations: new Map(),
      offDiff: [outside],
    });
  });

  it('lists an outdated thread off the diff, with or without a line', () => {
    // An outdated thread's line is the one it had on its own commit, not a line of this diff.
    const outdated = thread(1, { outdated: true, line: 11 });
    const lineless = thread(2, { line: null });
    expect(placeThreads([app], [outdated, lineless], false).offDiff).toEqual([outdated, lineless]);
  });

  it('lists a thread on a file the view does not show off the diff', () => {
    const elsewhere = thread(1, { path: 'logo.png', line: 1 });
    expect(placeThreads([app, readme], [elsewhere], false).offDiff).toEqual([elsewhere]);
  });

  it("lists every thread off the diff on a commit's view", () => {
    const threads = [thread(1), thread(2, { path: 'README.md', line: 1 })];
    expect(placeThreads([app, readme], threads, true)).toEqual({
      annotations: new Map(),
      offDiff: threads,
    });
  });
});

describe('annotationsKey', () => {
  const app = fileWithHunks([
    { deletionStart: 10, deletionCount: 3, additionStart: 10, additionCount: 5 },
  ]);
  const keyOf = (threads: ReviewThread[]) =>
    annotationsKey(placeThreads([app], threads, false).annotations.get('src/app.ts') ?? []);

  it('changes with what the annotations show', () => {
    const base = keyOf([thread(1)]);
    expect(keyOf([thread(1)])).toBe(base);
    expect(keyOf([])).not.toBe(base);
    expect(keyOf([thread(1, { line: 12 })])).not.toBe(base);
    expect(keyOf([thread(1, { comments: [comment(1, { body: 'Edited' })] })])).not.toBe(base);
    expect(keyOf([thread(1, { comments: [comment(1), comment(2)] })])).not.toBe(base);
    expect(
      keyOf([
        thread(1, { comments: [comment(1, { reactions: [{ content: 'heart', count: 1 }] })] }),
      ])
    ).not.toBe(base);
  });
});
