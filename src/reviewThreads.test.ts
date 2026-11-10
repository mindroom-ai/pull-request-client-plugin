import { describe, expect, it } from 'vitest';
import type { ReviewComment } from './github';
import { buildReviewThreads } from './reviewThreads';

const comment = (
  id: number,
  createdAt: string,
  extra: Partial<ReviewComment> = {}
): ReviewComment => ({
  id,
  author: null,
  body: '',
  createdAt,
  url: '',
  reactions: [],
  path: 'a.ts',
  line: 3,
  originalLine: 3,
  side: 'RIGHT',
  inReplyToId: null,
  reviewId: null,
  outdated: false,
  commitId: 'c',
  ...extra,
});

describe('buildReviewThreads', () => {
  it('groups replies under their root in time order', () => {
    const threads = buildReviewThreads([
      comment(3, '2026-01-03T00:00:00Z', { inReplyToId: 1 }),
      comment(1, '2026-01-01T00:00:00Z'),
      comment(2, '2026-01-02T00:00:00Z', { inReplyToId: 1 }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: 1,
      path: 'a.ts',
      line: 3,
      side: 'RIGHT',
      outdated: false,
    });
    expect(threads[0]!.comments.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it("a reply to a reply joins the root's thread", () => {
    const threads = buildReviewThreads([
      comment(3, '2026-01-03T00:00:00Z', { inReplyToId: 2 }),
      comment(1, '2026-01-01T00:00:00Z'),
      comment(2, '2026-01-02T00:00:00Z', { inReplyToId: 1 }),
    ]);
    expect(threads.map((t) => [t.id, t.comments.map((c) => c.id)])).toEqual([[1, [1, 2, 3]]]);
  });

  it('a chain whose root is missing starts at its first loaded comment', () => {
    const threads = buildReviewThreads([
      comment(4, '2026-01-04T00:00:00Z', { inReplyToId: 3 }),
      comment(3, '2026-01-03T00:00:00Z', { inReplyToId: 2 }),
      comment(2, '2026-01-02T00:00:00Z', { inReplyToId: 99 }),
    ]);
    expect(threads.map((t) => [t.id, t.comments.map((c) => c.id)])).toEqual([[2, [2, 3, 4]]]);
  });

  it('keeps every comment of a reply loop', () => {
    const threads = buildReviewThreads([
      comment(1, '2026-01-01T00:00:00Z', { inReplyToId: 2 }),
      comment(2, '2026-01-02T00:00:00Z', { inReplyToId: 1 }),
      comment(3, '2026-01-03T00:00:00Z', { inReplyToId: 3 }),
    ]);
    expect(threads.flatMap((t) => t.comments.map((c) => c.id)).sort()).toEqual([1, 2, 3]);
  });

  it('an orphan reply is its own thread', () => {
    const threads = buildReviewThreads([comment(5, '2026-01-01T00:00:00Z', { inReplyToId: 99 })]);
    expect(threads.map((t) => [t.id, t.comments.length])).toEqual([[5, 1]]);
  });

  it('orders threads by their root', () => {
    const threads = buildReviewThreads([
      comment(2, '2026-01-02T00:00:00Z'),
      comment(1, '2026-01-01T00:00:00Z'),
      comment(3, '2026-01-05T00:00:00Z', { inReplyToId: 1 }),
    ]);
    expect(threads.map((t) => t.id)).toEqual([1, 2]);
  });

  it('shows an outdated thread at its original line', () => {
    const [thread] = buildReviewThreads([
      comment(1, '2026-01-01T00:00:00Z', { line: null, originalLine: 8, outdated: true }),
    ]);
    expect(thread).toMatchObject({ line: 8, outdated: true });
  });
});
